import { spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  CONNECTED_HEALTH_CHECK_ID,
  CONNECTED_RECOVERY_ACTION_ID,
  CONNECTED_SERVICE_HEALTH_URL,
  CONNECTED_WORKLOAD_ID,
  connectedCommandResultSchema,
  connectedRecoveryCommandSchema,
  type ConnectedCommandResult,
  type ConnectedHealthReport,
  type ConnectedRecoveryCommand,
} from "../src/lib/connected-runner-protocol";

const FIXED_SERVICE_MODULE_PATH = fileURLToPath(
  new URL("./connected-service.mjs", import.meta.url),
);
const MINIMAL_SERVICE_ENV = Object.freeze({ NODE_ENV: "production" });
const DEFAULT_HEALTH_TIMEOUT_MS = 1_000;
const DEFAULT_READINESS_TIMEOUT_MS = 3_000;
const DEFAULT_READINESS_RETRY_MS = 50;
const JOURNAL_LIMIT = 50;

const serviceHealthBodySchema = z
  .object({
    service: z.literal(CONNECTED_WORKLOAD_ID),
    status: z.literal("healthy"),
    instanceId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

const journalEntrySchema = z
  .object({
    commandId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
    executionNonce: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
    actionId: z.literal(CONNECTED_RECOVERY_ACTION_ID),
    claimedAt: z.number().int().nonnegative(),
    result: connectedCommandResultSchema.optional(),
    deliveredAt: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      entry.result &&
      (entry.result.commandId !== entry.commandId ||
        entry.result.executionNonce !== entry.executionNonce)
    ) {
      context.addIssue({
        code: "custom",
        message: "Stored result does not match its claim",
      });
    }
    if (entry.deliveredAt !== undefined && entry.result === undefined) {
      context.addIssue({
        code: "custom",
        message: "A claim without a result cannot be delivered",
      });
    }
  });

const journalSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(journalEntrySchema).max(JOURNAL_LIMIT),
  })
  .strict();

type ExecutionJournal = z.infer<typeof journalSchema>;
type JournalEntry = ExecutionJournal["entries"][number];

export type FixedServiceController = {
  checkHealth(): Promise<ConnectedHealthReport>;
  execute(command: unknown): Promise<ConnectedCommandResult | null>;
  pendingResult(): Promise<ConnectedCommandResult | null>;
  markResultDelivered(commandId: string, executionNonce: string): Promise<void>;
  stop(): Promise<void>;
};

function defaultExecutionJournalPath() {
  return path.join(
    os.homedir(),
    ".autonomous-devops-agent",
    "executions.json",
  );
}

function unhealthyReport(
  detailCode: Exclude<
    ConnectedHealthReport["detailCode"],
    "exact_http_200"
  >,
): ConnectedHealthReport {
  return {
    workloadId: CONNECTED_WORKLOAD_ID,
    healthCheckId: CONNECTED_HEALTH_CHECK_ID,
    healthStatus: "unhealthy",
    detailCode,
  };
}

export async function checkFixedServiceHealth(options: {
  request?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<ConnectedHealthReport> {
  const request = options.request ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await request(CONNECTED_SERVICE_HEALTH_URL, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status !== 200) {
      return unhealthyReport("unexpected_response");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return unhealthyReport("unexpected_response");
    }
    const parsed = serviceHealthBodySchema.safeParse(body);
    if (!parsed.success) {
      return unhealthyReport("unexpected_response");
    }
    return {
      workloadId: CONNECTED_WORKLOAD_ID,
      healthCheckId: CONNECTED_HEALTH_CHECK_ID,
      healthStatus: "healthy",
      detailCode: "exact_http_200",
      instanceId: parsed.data.instanceId,
    };
  } catch {
    return unhealthyReport(
      controller.signal.aborted ? "request_timeout" : "connection_failed",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function readJournal(journalPath: string): Promise<ExecutionJournal> {
  try {
    const value = journalSchema.parse(
      JSON.parse(await readFile(journalPath, "utf8")) as unknown,
    );
    await chmod(journalPath, 0o600);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, entries: [] };
    }
    throw error;
  }
}

async function writeJournal(
  journalPath: string,
  journal: ExecutionJournal,
) {
  const validated = journalSchema.parse(journal);
  const directory = path.dirname(journalPath);
  const temporaryPath = `${journalPath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, journalPath);
    await chmod(journalPath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function wait(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function stopChild(child: ChildProcess | null) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, wait(1_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, wait(1_000)]);
  }
}

function trimForClaim(entries: JournalEntry[]) {
  if (entries.length < JOURNAL_LIMIT) return entries;
  const removableIndex = entries.findIndex(
    (entry) => entry.deliveredAt !== undefined,
  );
  if (removableIndex === -1) {
    throw new Error("The fixed execution journal is full of unresolved claims.");
  }
  return entries.filter((_entry, index) => index !== removableIndex);
}

export function createFixedServiceController(options: {
  journalPath?: string;
  request?: typeof fetch;
  healthTimeoutMs?: number;
  readinessTimeoutMs?: number;
  readinessRetryMs?: number;
} = {}): FixedServiceController {
  const journalPath = options.journalPath ?? defaultExecutionJournalPath();
  const request = options.request ?? fetch;
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const readinessTimeoutMs =
    options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const readinessRetryMs =
    options.readinessRetryMs ?? DEFAULT_READINESS_RETRY_MS;
  let lastHealthyInstanceId: string | undefined;
  let stopped = false;
  let journalQueue = Promise.resolve();
  let executionQueue = Promise.resolve();
  let ownedChild: ChildProcess | null = null;

  function spawnFixedService() {
    if (stopped) throw new Error("The fixed service controller is stopped.");
    const child = spawn(process.execPath, [FIXED_SERVICE_MODULE_PATH], {
      shell: false,
      stdio: "ignore",
      env: MINIMAL_SERVICE_ENV,
    });
    child.once("error", () => undefined);
    ownedChild = child;
    return child;
  }

  function withJournal<T>(operation: () => Promise<T>): Promise<T> {
    const current = journalQueue.then(operation, operation);
    journalQueue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  function withExecution<T>(operation: () => Promise<T>): Promise<T> {
    const current = executionQueue.then(operation, operation);
    executionQueue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  async function checkHealth() {
    const report = await checkFixedServiceHealth({
      request,
      timeoutMs: healthTimeoutMs,
    });
    if (report.healthStatus === "healthy") {
      lastHealthyInstanceId = report.instanceId;
    }
    return report;
  }

  async function waitForFreshHealth(previousInstanceId: string | undefined) {
    const deadline = Date.now() + readinessTimeoutMs;
    let latest = unhealthyReport("connection_failed");
    do {
      latest = await checkHealth();
      if (
        latest.healthStatus === "healthy" &&
        latest.instanceId !== previousInstanceId
      ) {
        return latest;
      }
      if (Date.now() < deadline) await wait(readinessRetryMs);
    } while (Date.now() < deadline);

    return latest.healthStatus === "healthy"
      ? unhealthyReport("unexpected_response")
      : latest;
  }

  async function claimCommand(command: ConnectedRecoveryCommand) {
    return await withJournal(async () => {
      const journal = await readJournal(journalPath);
      const existing = journal.entries.find(
        (entry) => entry.commandId === command.commandId,
      );
      if (existing) {
        if (existing.executionNonce !== command.executionNonce) {
          throw new Error("The command ID was replayed with another nonce.");
        }
        return { isNew: false as const, result: existing.result ?? null };
      }
      if (
        journal.entries.some(
          (entry) => entry.executionNonce === command.executionNonce,
        )
      ) {
        throw new Error("The execution nonce was already claimed.");
      }

      const entries = trimForClaim(journal.entries);
      entries.push({
        commandId: command.commandId,
        executionNonce: command.executionNonce,
        actionId: CONNECTED_RECOVERY_ACTION_ID,
        claimedAt: Date.now(),
      });
      await writeJournal(journalPath, { version: 1, entries });
      return { isNew: true as const, result: null };
    });
  }

  async function storeResult(result: ConnectedCommandResult) {
    await withJournal(async () => {
      const journal = await readJournal(journalPath);
      const index = journal.entries.findIndex(
        (entry) =>
          entry.commandId === result.commandId &&
          entry.executionNonce === result.executionNonce,
      );
      if (index === -1) {
        throw new Error("The execution result has no durable claim.");
      }
      const entry = journal.entries[index];
      if (!entry) throw new Error("The durable claim is unavailable.");
      if (entry.result && JSON.stringify(entry.result) !== JSON.stringify(result)) {
        throw new Error("The durable execution result cannot be replaced.");
      }
      journal.entries[index] = { ...entry, result: entry.result ?? result };
      await writeJournal(journalPath, journal);
    });
  }

  async function execute(commandValue: unknown) {
    const command = connectedRecoveryCommandSchema.parse(commandValue);
    return await withExecution(async () => {
      const claim = await claimCommand(command);
      if (!claim.isNew) return claim.result;

      const previousInstanceId = lastHealthyInstanceId;
      await stopChild(ownedChild);
      ownedChild = null;
      let executionResultCode: ConnectedCommandResult["executionResultCode"] =
        "restart_succeeded";
      try {
        spawnFixedService();
      } catch {
        executionResultCode = "restart_failed";
      }

      const verification = await waitForFreshHealth(previousInstanceId);
      const result = connectedCommandResultSchema.parse({
        commandId: command.commandId,
        executionNonce: command.executionNonce,
        actionId: CONNECTED_RECOVERY_ACTION_ID,
        executionResultCode,
        verificationStatus: verification.healthStatus,
        verificationDetailCode: verification.detailCode,
        ...(verification.healthStatus === "healthy"
          ? { postActionInstanceId: verification.instanceId }
          : {}),
      });
      await storeResult(result);
      return result;
    });
  }

  async function pendingResult() {
    return await withJournal(async () => {
      const journal = await readJournal(journalPath);
      for (let index = journal.entries.length - 1; index >= 0; index -= 1) {
        const entry = journal.entries[index];
        if (entry?.result && entry.deliveredAt === undefined) return entry.result;
      }
      return null;
    });
  }

  async function markResultDelivered(commandId: string, executionNonce: string) {
    await withJournal(async () => {
      const journal = await readJournal(journalPath);
      const index = journal.entries.findIndex(
        (entry) =>
          entry.commandId === commandId &&
          entry.executionNonce === executionNonce,
      );
      const entry = journal.entries[index];
      if (!entry?.result) {
        throw new Error("The delivered result is not stored in the journal.");
      }
      if (entry.deliveredAt === undefined) {
        journal.entries[index] = { ...entry, deliveredAt: Date.now() };
        await writeJournal(journalPath, journal);
      }
    });
  }

  async function stop() {
    stopped = true;
    await executionQueue.catch(() => undefined);
    await stopChild(ownedChild);
    ownedChild = null;
  }

  spawnFixedService();
  return { checkHealth, execute, markResultDelivered, pendingResult, stop };
}
