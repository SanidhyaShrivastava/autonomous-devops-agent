import { timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const AGENT_HOST = "0.0.0.0";
const AGENT_PORT = 3000;
const WORKLOAD_HEALTH_URL = "http://127.0.0.1:3001/health";
const WORKLOAD_EXECUTABLE = "/usr/local/bin/node";
const WORKLOAD_ARGS = Object.freeze(["/app/workload.mjs"] as const);
const DEMO_LABEL = "autonomous-devops-agent" as const;
const DEMO_SERVICE = "gx-autodevops-demo-service" as const;
const DEMO_STATUS = "healthy" as const;
const ACTION_ID = "restart_demo_service" as const;
const WORKLOAD_ID = "demo-service" as const;
const RECOVERY_LABEL = "linux agent restart fixed demo service" as const;
const MAX_BODY_BYTES = 2_048;
const MAX_LOG_LINES = 30;
const MAX_LOG_CHARACTERS = 4_000;
const MAX_LOG_LINE_CHARACTERS = 500;
const STOP_GRACE_MS = 2_000;
const HEALTH_TIMEOUT_MS = 2_000;

type WorkloadChild = ChildProcessByStdio<null, Readable, Readable>;

export interface RecoveryActionRequest {
  readonly actionId: typeof ACTION_ID;
  readonly workloadId: typeof WORKLOAD_ID;
  readonly executionId: string;
}

export interface SafeWorkloadState {
  readonly status: string;
  readonly exitCode: number;
  readonly oomKilled: false;
  readonly finishedAt: string;
  readonly demoLabel: typeof DEMO_LABEL;
}

export interface SafeLogTail {
  readonly lines: readonly string[];
  readonly lineCount: number;
  readonly characterCount: number;
  readonly truncated: boolean;
}

export interface HealthEvidence {
  readonly healthy: boolean;
  readonly httpStatus: number | null;
  readonly service: string | null;
  readonly status: string | null;
  readonly requestStartedAt: number;
  readonly checkedAt: number;
  readonly attempts: number;
}

export interface RecoveryActionResult {
  readonly actionId: typeof ACTION_ID;
  readonly commandLabel: typeof RECOVERY_LABEL;
  readonly exitCode: 0;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
}

export interface WorkloadManager {
  inspectSafeState(): Promise<SafeWorkloadState>;
  readSafeLogTail(): Promise<SafeLogTail>;
  checkHealthOnce(): Promise<HealthEvidence>;
  stopDemoService(): Promise<void>;
  ensureDemoService(): Promise<SafeWorkloadState>;
  executeRecoveryAction(input: RecoveryActionRequest): Promise<RecoveryActionResult>;
  shutdown(): Promise<void>;
}

export class DuplicateExecutionError extends Error {
  constructor() {
    super("Duplicate recovery execution rejected");
    this.name = "DuplicateExecutionError";
  }
}

export interface SpawnOptions {
  readonly cwd: "/app";
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly stdio: ["ignore", "pipe", "pipe"];
}

export type SpawnWorkload = (
  executable: typeof WORKLOAD_EXECUTABLE,
  args: typeof WORKLOAD_ARGS,
  options: SpawnOptions,
) => WorkloadChild;

export interface ManagedWorkloadDependencies {
  readonly spawnWorkload?: SpawnWorkload;
  readonly fetchHealth?: typeof fetch;
  readonly now?: () => number;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

function systemSpawnWorkload(
  executable: typeof WORKLOAD_EXECUTABLE,
  args: typeof WORKLOAD_ARGS,
  options: SpawnOptions,
): WorkloadChild {
  return spawn(executable, [...args], options);
}

function redactLogLine(line: string): string {
  return line
    .replace(
      /\b(authorization|password|secret|token)\b\s*[:=]\s*[^\s]+/gi,
      "$1=[REDACTED]",
    )
    .slice(0, MAX_LOG_LINE_CHARACTERS);
}

function boundLogLines(input: readonly string[]): SafeLogTail {
  const sanitized = input.map(redactLogLine);
  const newest = sanitized.slice(-MAX_LOG_LINES);
  const bounded: string[] = [];
  let characterCount = 0;
  let truncated = sanitized.length > MAX_LOG_LINES;

  for (let index = newest.length - 1; index >= 0; index -= 1) {
    const line = newest[index] ?? "";
    const separatorLength = bounded.length > 0 ? 1 : 0;
    const remaining = MAX_LOG_CHARACTERS - characterCount - separatorLength;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const accepted = line.slice(Math.max(0, line.length - remaining));
    if (accepted.length < line.length) {
      truncated = true;
    }
    bounded.unshift(accepted);
    characterCount += accepted.length + separatorLength;
  }

  return {
    lines: bounded,
    lineCount: bounded.length,
    characterCount,
    truncated,
  };
}

export function createBoundedLogBuffer(now: () => number) {
  const lines: string[] = [];
  let wasTruncated = false;

  return {
    add(source: "stdout" | "stderr", chunk: Buffer | string): void {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        const prefixed = `${new Date(now()).toISOString()} [${source}] ${line}`;
        const safeLine = redactLogLine(prefixed);
        if (safeLine.length < prefixed.length) {
          wasTruncated = true;
        }
        lines.push(safeLine);
        if (lines.length > MAX_LOG_LINES) {
          lines.shift();
          wasTruncated = true;
        }
      }
    },
    snapshot(): SafeLogTail {
      const snapshot = boundLogLines(lines);
      return {
        ...snapshot,
        truncated: snapshot.truncated || wasTruncated,
      };
    },
    storedLineCount(): number {
      return lines.length;
    },
  };
}

function isRunning(child: WorkloadChild | null): child is WorkloadChild {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

function exitCodeFor(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (typeof code === "number") {
    return code;
  }
  return signal === "SIGTERM" ? 143 : 137;
}

async function waitForChildExit(
  child: WorkloadChild,
  timeoutMs: number,
  scheduleTimeout: typeof globalThis.setTimeout,
  cancelTimeout: typeof globalThis.clearTimeout,
): Promise<boolean> {
  if (!isRunning(child)) {
    return true;
  }

  return await new Promise<boolean>((resolveWait) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      cancelTimeout(timer);
      child.off("exit", onExit);
      resolveWait(exited);
    };
    const onExit = () => finish(true);
    const timer = scheduleTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

export function createManagedWorkload(
  dependencies: ManagedWorkloadDependencies = {},
): WorkloadManager {
  const spawnWorkload = dependencies.spawnWorkload ?? systemSpawnWorkload;
  const fetchHealth = dependencies.fetchHealth ?? fetch;
  const now = dependencies.now ?? Date.now;
  const scheduleTimeout = dependencies.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = dependencies.clearTimeout ?? globalThis.clearTimeout;
  const executionLedger = new Set<string>();
  const logBuffer = createBoundedLogBuffer(now);
  let child: WorkloadChild | null = null;
  let lastExitCode = 0;
  let finishedAt = "";
  let processError = false;
  let mutationTail: Promise<void> = Promise.resolve();

  const addLogChunk = (source: "stdout" | "stderr", chunk: Buffer | string) => {
    logBuffer.add(source, chunk);
  };

  const runMutation = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const startChild = async (): Promise<void> => {
    if (isRunning(child)) {
      return;
    }
    const nextChild = spawnWorkload(WORKLOAD_EXECUTABLE, WORKLOAD_ARGS, {
      cwd: "/app",
      env: Object.freeze({
        NODE_ENV: "production",
        PATH: "/usr/local/bin:/usr/bin:/bin",
      }),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = nextChild;
    finishedAt = "";
    processError = false;
    nextChild.stdout.on("data", (chunk) => addLogChunk("stdout", chunk));
    nextChild.stderr.on("data", (chunk) => addLogChunk("stderr", chunk));
    nextChild.on("error", () => {
      processError = true;
      addLogChunk("stderr", "Managed workload process error");
    });
    nextChild.once("exit", (code, signal) => {
      lastExitCode = exitCodeFor(code, signal);
      finishedAt = new Date(now()).toISOString();
      if (child === nextChild) {
        child = null;
      }
    });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      const onSpawn = () => {
        nextChild.off("error", onStartupError);
        resolveSpawn();
      };
      const onStartupError = (error: Error) => {
        nextChild.off("spawn", onSpawn);
        if (child === nextChild) {
          child = null;
        }
        rejectSpawn(error);
      };
      nextChild.once("spawn", onSpawn);
      nextChild.once("error", onStartupError);
    });
  };

  const inspectSafeState = async (): Promise<SafeWorkloadState> => ({
    status: processError ? "error" : isRunning(child) ? "running" : "exited",
    exitCode: isRunning(child) ? 0 : lastExitCode,
    oomKilled: false,
    finishedAt,
    demoLabel: DEMO_LABEL,
  });

  const stopDemoServiceInternal = async (): Promise<void> => {
    const activeChild = child;
    if (!isRunning(activeChild)) {
      throw new Error("Disposable demo service is not running");
    }
    activeChild.kill("SIGTERM");
    const exited = await waitForChildExit(
      activeChild,
      STOP_GRACE_MS,
      scheduleTimeout,
      cancelTimeout,
    );
    if (!exited && isRunning(activeChild)) {
      activeChild.kill("SIGKILL");
      await waitForChildExit(
        activeChild,
        STOP_GRACE_MS,
        scheduleTimeout,
        cancelTimeout,
      );
    }
    if (isRunning(activeChild)) {
      throw new Error("Disposable demo service did not stop");
    }
  };

  return {
    inspectSafeState,
    async readSafeLogTail() {
      return logBuffer.snapshot();
    },
    async checkHealthOnce() {
      const requestStartedAt = now();
      try {
        const response = await fetchHealth(WORKLOAD_HEALTH_URL, {
          method: "GET",
          cache: "no-store",
          redirect: "error",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        const payload = (await response.json().catch(() => null)) as {
          service?: unknown;
          status?: unknown;
        } | null;
        const exactPayload =
          payload?.service === DEMO_SERVICE && payload.status === DEMO_STATUS;
        return {
          healthy: response.status === 200 && exactPayload,
          httpStatus: response.status,
          service: exactPayload ? DEMO_SERVICE : null,
          status: exactPayload ? DEMO_STATUS : null,
          requestStartedAt,
          checkedAt: now(),
          attempts: 1,
        };
      } catch {
        return {
          healthy: false,
          httpStatus: null,
          service: null,
          status: null,
          requestStartedAt,
          checkedAt: now(),
          attempts: 1,
        };
      }
    },
    stopDemoService() {
      return runMutation(stopDemoServiceInternal);
    },
    async ensureDemoService() {
      return await runMutation(async () => {
        await startChild();
        return await inspectSafeState();
      });
    },
    async executeRecoveryAction(input) {
      if (
        input.actionId !== ACTION_ID ||
        input.workloadId !== WORKLOAD_ID ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(input.executionId)
      ) {
        throw new Error("Recovery request is not allowlisted");
      }
      return await runMutation(async () => {
        if (executionLedger.has(input.executionId)) {
          throw new DuplicateExecutionError();
        }
        if (isRunning(child)) {
          throw new Error("Recovery action requires the demo service to be exited");
        }
        executionLedger.add(input.executionId);
        const startedAt = now();
        await startChild();
        const actionFinishedAt = now();
        return {
          actionId: ACTION_ID,
          commandLabel: RECOVERY_LABEL,
          exitCode: 0,
          startedAt,
          finishedAt: actionFinishedAt,
          durationMs: Math.max(0, actionFinishedAt - startedAt),
        };
      });
    },
    async shutdown() {
      await runMutation(async () => {
        if (isRunning(child)) {
          await stopDemoServiceInternal();
        }
      });
    },
  };
}

interface AgentHandlerOptions {
  readonly manager: WorkloadManager;
  readonly token: string;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return false;
  }
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new RangeError("request_too_large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

async function parseJsonBody(request: IncomingMessage): Promise<unknown> {
  if (!(request.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new SyntaxError("invalid_content_type");
  }
  return JSON.parse(await readBody(request));
}

export function createAgentRequestHandler(
  options: AgentHandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  if (!options.token) {
    throw new Error("Sandbox agent token is required");
  }

  return async (request, response) => {
    if (!authorized(request, options.token)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", "http://sandbox.local").pathname;
    try {
      if (method === "GET" && path === "/v1/workload/state") {
        sendJson(response, 200, await options.manager.inspectSafeState());
        return;
      }
      if (method === "GET" && path === "/v1/workload/logs") {
        const logs = await options.manager.readSafeLogTail();
        const bounded = boundLogLines(logs.lines);
        sendJson(response, 200, {
          ...bounded,
          truncated: bounded.truncated || logs.truncated,
        });
        return;
      }
      if (method === "GET" && path === "/v1/workload/health") {
        sendJson(response, 200, await options.manager.checkHealthOnce());
        return;
      }
      if (method === "POST" && path === "/v1/demo/stop") {
        const body = await parseJsonBody(request);
        if (!exactObject(body, ["kind"]) || body.kind !== "STOP_DEMO_SERVICE_V1") {
          throw new SyntaxError("invalid_request");
        }
        await options.manager.stopDemoService();
        sendJson(response, 200, { status: "stopped" });
        return;
      }
      if (method === "POST" && path === "/v1/demo/ensure") {
        const body = await parseJsonBody(request);
        if (!exactObject(body, ["kind"]) || body.kind !== "ENSURE_DEMO_SERVICE_V1") {
          throw new SyntaxError("invalid_request");
        }
        sendJson(response, 200, await options.manager.ensureDemoService());
        return;
      }
      if (method === "POST" && path === "/v1/actions/execute") {
        const body = await parseJsonBody(request);
        if (
          !exactObject(body, ["actionId", "executionId", "workloadId"]) ||
          body.actionId !== ACTION_ID ||
          body.workloadId !== WORKLOAD_ID ||
          typeof body.executionId !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(body.executionId)
        ) {
          throw new SyntaxError("invalid_request");
        }
        sendJson(
          response,
          200,
          await options.manager.executeRecoveryAction({
            actionId: ACTION_ID,
            workloadId: WORKLOAD_ID,
            executionId: body.executionId,
          }),
        );
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof RangeError && error.message === "request_too_large") {
        sendJson(response, 413, { error: "request_too_large" });
        return;
      }
      if (error instanceof DuplicateExecutionError) {
        sendJson(response, 409, { error: "duplicate_execution" });
        return;
      }
      if (error instanceof SyntaxError) {
        sendJson(response, 400, { error: "invalid_request" });
        return;
      }
      sendJson(response, 500, { error: "operation_failed" });
    }
  };
}

export async function startSandboxAgent(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const token = environment.SANDBOX_AGENT_TOKEN?.trim();
  if (!token) {
    throw new Error("SANDBOX_AGENT_TOKEN is required");
  }
  const manager = createManagedWorkload();
  await manager.ensureDemoService();
  const server = createServer(createAgentRequestHandler({ manager, token }));
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(AGENT_PORT, AGENT_HOST, resolveListen);
  });
  console.log("Linux sandbox agent is ready.");

  let stopping = false;
  const shutdown = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    server.close(() => undefined);
    void manager.shutdown().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && pathToFileURL(resolve(entry)).href === import.meta.url);
}

if (isDirectExecution()) {
  void startSandboxAgent().catch(() => {
    console.error("Linux sandbox agent could not start.");
    process.exitCode = 1;
  });
}
