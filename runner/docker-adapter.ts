import { z } from "zod";

import { sanitizePublicOutput } from "../src/lib/sanitize";
import {
  DEMO_ACTION_ID,
  DEMO_CONTAINER_NAME,
  DEMO_EXPECTED_SERVICE,
  DEMO_EXPECTED_STATUS,
  DEMO_HEALTH_URL,
  DEMO_IMAGE,
  DEMO_LABEL_KEY,
  DEMO_LABEL_VALUE,
  DEMO_LOG_LINE_LIMIT,
  DEMO_WORKLOAD_ID,
  PUBLIC_OUTPUT_CHARACTER_LIMIT,
} from "./config";
import {
  createDockerCommandExecutor,
  DockerCommandError,
  type DockerCommandExecutor,
} from "./command-executor";
import {
  LEGACY_DOCKER_RECOVERY_LABEL,
  type HealthEvidence,
  type RecoveryActionResult,
  type SafeLogTail,
  type SafeWorkloadState,
} from "./workload-types";

export {
  LEGACY_DOCKER_RECOVERY_LABEL,
  LINUX_AGENT_RECOVERY_LABEL,
  type HealthEvidence,
  type RecoveryActionResult,
  type RecoveryCommandLabel,
  type SafeLogTail,
  type SafeWorkloadState,
} from "./workload-types";

export type SafeContainerState = SafeWorkloadState;

const HEALTH_REQUEST_TIMEOUT_MS = 2_000;
const HEALTH_VERIFY_TIMEOUT_MS = 10_000;
const HEALTH_RETRY_INTERVAL_MS = 250;
const MAX_HEALTH_ATTEMPTS = 40;

export const SAFE_INSPECT_FORMAT =
  `{"containerId":{{json .Id}},` +
  `"demoLabel":{{json (index .Config.Labels "${DEMO_LABEL_KEY}")}},` +
  `"status":{{json .State.Status}},` +
  `"exitCode":{{json .State.ExitCode}},` +
  `"oomKilled":{{json .State.OOMKilled}},` +
  `"finishedAt":{{json .State.FinishedAt}}}`;

const ContainerInspectionSchema = z
  .object({
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    demoLabel: z.literal(DEMO_LABEL_VALUE),
    status: z.string().min(1).max(32),
    exitCode: z.number().int(),
    oomKilled: z.boolean(),
    finishedAt: z.string().max(64),
  })
  .strict();

const RecoveryRequestSchema = z
  .object({
    actionId: z.literal(DEMO_ACTION_ID),
    workloadId: z.literal(DEMO_WORKLOAD_ID),
    executionId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

const HealthPayloadSchema = z
  .object({
    service: z.literal(DEMO_EXPECTED_SERVICE),
    status: z.literal(DEMO_EXPECTED_STATUS),
  })
  .strict();

interface InternalContainerInspection extends SafeContainerState {
  readonly containerId: string;
}

export interface HealthResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type HealthFetch = (
  url: string,
  init: RequestInit,
) => Promise<HealthResponse>;

export interface DockerAdapterDependencies {
  readonly process?: DockerCommandExecutor;
  readonly fetch?: HealthFetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const defaultHealthFetch: HealthFetch = (url, init) => fetch(url, init);

function toSafeState(
  inspection: InternalContainerInspection,
): SafeContainerState {
  return {
    status: inspection.status,
    exitCode: inspection.exitCode,
    oomKilled: inspection.oomKilled,
    finishedAt: inspection.finishedAt,
    demoLabel: inspection.demoLabel,
  };
}

function isMissingContainer(error: unknown): boolean {
  if (!(error instanceof DockerCommandError)) {
    return false;
  }

  const message = `${error.stdout}\n${error.stderr}`.toLowerCase();
  return (
    message.includes("no such object") ||
    message.includes("no such container")
  );
}

export class DockerAdapter {
  private readonly process: DockerCommandExecutor;
  private readonly healthFetch: HealthFetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly executionLedger = new Set<string>();

  constructor(dependencies: DockerAdapterDependencies = {}) {
    this.process = dependencies.process ?? createDockerCommandExecutor();
    this.healthFetch = dependencies.fetch ?? defaultHealthFetch;
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? defaultSleep;
  }

  private async inspectValidatedContainer(): Promise<InternalContainerInspection> {
    const result = await this.process.run([
      "container",
      "inspect",
      "--format",
      SAFE_INSPECT_FORMAT,
      DEMO_CONTAINER_NAME,
    ]);

    let decoded: unknown;
    try {
      decoded = JSON.parse(result.stdout.trim());
    } catch {
      throw new Error("Docker returned malformed safe inspection data");
    }

    const inspection = ContainerInspectionSchema.safeParse(decoded);
    if (!inspection.success) {
      throw new Error("Docker container identity or safe state did not validate");
    }

    return inspection.data;
  }

  async ensureDemoService(): Promise<SafeContainerState> {
    try {
      const inspection = await this.inspectValidatedContainer();
      if (inspection.status !== "running") {
        await this.process.run(["container", "start", inspection.containerId]);
      }
      return toSafeState(await this.inspectValidatedContainer());
    } catch (error) {
      if (!isMissingContainer(error)) {
        throw error;
      }

      await this.process.run([
        "container",
        "run",
        "--detach",
        "--name",
        DEMO_CONTAINER_NAME,
        "--publish",
        "127.0.0.1:3400:3000/tcp",
        "--label",
        `${DEMO_LABEL_KEY}=${DEMO_LABEL_VALUE}`,
        "--restart=no",
        DEMO_IMAGE,
      ]);

      return toSafeState(await this.inspectValidatedContainer());
    }
  }

  async stopDemoService(): Promise<void> {
    const inspection = await this.inspectValidatedContainer();
    if (inspection.status !== "running") {
      throw new Error("Disposable demo service is not running");
    }

    await this.process.run([
      "container",
      "stop",
      "--time",
      "5",
      inspection.containerId,
    ]);
  }

  async inspectSafeState(): Promise<SafeContainerState> {
    return toSafeState(await this.inspectValidatedContainer());
  }

  async readSafeLogTail(): Promise<SafeLogTail> {
    const inspection = await this.inspectValidatedContainer();
    const result = await this.process.run([
      "container",
      "logs",
      "--tail",
      String(DEMO_LOG_LINE_LIMIT),
      "--timestamps",
      inspection.containerId,
    ]);

    const combined = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .split(/\r?\n/)
      .filter(Boolean);
    const boundedLines = combined.slice(-DEMO_LOG_LINE_LIMIT);
    const sanitized = sanitizePublicOutput(
      boundedLines.join("\n"),
      PUBLIC_OUTPUT_CHARACTER_LIMIT,
    );
    const lines = sanitized.text ? sanitized.text.split(/\r?\n/) : [];

    return {
      lines,
      lineCount: lines.length,
      characterCount: Array.from(sanitized.text).length,
      truncated:
        combined.length > DEMO_LOG_LINE_LIMIT || sanitized.truncated,
    };
  }

  async executeRecoveryAction(input: unknown): Promise<RecoveryActionResult> {
    const request = RecoveryRequestSchema.parse(input);
    if (this.executionLedger.has(request.executionId)) {
      throw new Error("Duplicate recovery execution rejected");
    }

    this.executionLedger.add(request.executionId);
    const inspection = await this.inspectValidatedContainer();
    if (inspection.status !== "exited") {
      throw new Error("Recovery action requires the demo service to be exited");
    }

    const result = await this.process.run([
      "container",
      "start",
      inspection.containerId,
    ]);

    return {
      actionId: request.actionId,
      commandLabel: LEGACY_DOCKER_RECOVERY_LABEL,
      exitCode: result.exitCode,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
    };
  }

  async checkHealthOnce(signal?: AbortSignal): Promise<HealthEvidence> {
    const requestStartedAt = this.now();
    const requestSignal = signal
      ? AbortSignal.any([
          signal,
          AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
        ])
      : AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS);

    try {
      const response = await this.healthFetch(DEMO_HEALTH_URL, {
        method: "GET",
        cache: "no-store",
        redirect: "error",
        headers: { accept: "application/json" },
        signal: requestSignal,
      });
      const payload = await response.json().catch(() => null);
      const parsed = HealthPayloadSchema.safeParse(payload);
      const checkedAt = this.now();

      return {
        healthy: response.status === 200 && parsed.success,
        httpStatus: response.status,
        service: parsed.success ? parsed.data.service : null,
        status: parsed.success ? parsed.data.status : null,
        requestStartedAt,
        checkedAt,
        attempts: 1,
      };
    } catch {
      return {
        healthy: false,
        httpStatus: null,
        service: null,
        status: null,
        requestStartedAt,
        checkedAt: this.now(),
        attempts: 1,
      };
    }
  }

  async verifyFreshHealth(
    notBefore: number,
    signal?: AbortSignal,
  ): Promise<HealthEvidence> {
    signal?.throwIfAborted();
    const deadline = this.now() + HEALTH_VERIFY_TIMEOUT_MS;
    let lastEvidence: HealthEvidence | null = null;

    for (let attempt = 1; attempt <= MAX_HEALTH_ATTEMPTS; attempt += 1) {
      const evidence = await this.checkHealthOnce(signal);
      signal?.throwIfAborted();
      const fresh = evidence.requestStartedAt >= notBefore;
      lastEvidence = {
        ...evidence,
        healthy: evidence.healthy && fresh,
        attempts: attempt,
      };

      if (lastEvidence.healthy || this.now() >= deadline) {
        return lastEvidence;
      }

      await this.sleep(HEALTH_RETRY_INTERVAL_MS);
      signal?.throwIfAborted();
    }

    return (
      lastEvidence ?? {
        healthy: false,
        httpStatus: null,
        service: null,
        status: null,
        requestStartedAt: this.now(),
        checkedAt: this.now(),
        attempts: 0,
      }
    );
  }
}
