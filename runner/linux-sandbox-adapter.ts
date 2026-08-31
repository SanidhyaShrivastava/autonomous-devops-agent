import { z } from "zod";

import { sanitizePublicOutput } from "../src/lib/sanitize";
import {
  DEMO_ACTION_ID,
  DEMO_EXPECTED_SERVICE,
  DEMO_EXPECTED_STATUS,
  DEMO_LABEL_VALUE,
  DEMO_LOG_LINE_LIMIT,
  DEMO_WORKLOAD_ID,
  PUBLIC_OUTPUT_CHARACTER_LIMIT,
} from "./config";
import {
  LINUX_AGENT_RECOVERY_LABEL,
  type HealthEvidence,
  type RecoveryActionResult,
  type SafeLogTail,
  type SafeWorkloadState,
} from "./workload-types";

export {
  LINUX_AGENT_RECOVERY_LABEL,
  type HealthEvidence,
  type RecoveryActionResult,
  type SafeLogTail,
  type SafeWorkloadState,
} from "./workload-types";

export const LINUX_SANDBOX_AGENT_ORIGIN = "http://127.0.0.1:3410" as const;

const REQUEST_TIMEOUT_MS = 2_000;
const HEALTH_VERIFY_TIMEOUT_MS = 10_000;
const HEALTH_RETRY_INTERVAL_MS = 250;
const MAX_HEALTH_ATTEMPTS = 40;

const SafeWorkloadStateSchema = z
  .object({
    status: z.string().min(1).max(32),
    exitCode: z.number().int(),
    oomKilled: z.boolean(),
    finishedAt: z.string().max(64),
    demoLabel: z.literal(DEMO_LABEL_VALUE),
  })
  .strict();

const SafeLogTailSchema = z
  .object({
    lines: z
      .array(
        z
          .string()
          .max(500)
          .refine((line) => !/[\r\n]/.test(line), {
            message: "Log entries must be single lines",
          }),
      )
      .max(DEMO_LOG_LINE_LIMIT),
    lineCount: z.number().int().nonnegative().max(DEMO_LOG_LINE_LIMIT),
    characterCount: z
      .number()
      .int()
      .nonnegative()
      .max(PUBLIC_OUTPUT_CHARACTER_LIMIT),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((logs, context) => {
    if (logs.lineCount !== logs.lines.length) {
      context.addIssue({
        code: "custom",
        message: "Log line count does not match lines",
      });
    }
    if (Array.from(logs.lines.join("\n")).length !== logs.characterCount) {
      context.addIssue({
        code: "custom",
        message: "Log character count does not match lines",
      });
    }
  });

const HealthEvidenceSchema = z
  .object({
    healthy: z.boolean(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    service: z.literal(DEMO_EXPECTED_SERVICE).nullable(),
    status: z.literal(DEMO_EXPECTED_STATUS).nullable(),
    requestStartedAt: z.number().finite().nonnegative(),
    checkedAt: z.number().finite().nonnegative(),
    attempts: z.number().int().positive(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.checkedAt < evidence.requestStartedAt) {
      context.addIssue({
        code: "custom",
        message: "Health check finished before it started",
      });
    }
    const exactSuccess =
      evidence.httpStatus === 200 &&
      evidence.service === DEMO_EXPECTED_SERVICE &&
      evidence.status === DEMO_EXPECTED_STATUS;
    if (evidence.healthy !== exactSuccess) {
      context.addIssue({
        code: "custom",
        message: "Health success fields are inconsistent",
      });
    }
  });

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

const RecoveryActionResultSchema = z
  .object({
    actionId: z.literal(DEMO_ACTION_ID),
    commandLabel: z.literal(LINUX_AGENT_RECOVERY_LABEL),
    exitCode: z.literal(0),
    startedAt: z.number().finite().nonnegative(),
    finishedAt: z.number().finite().nonnegative(),
    durationMs: z.number().finite().nonnegative(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.finishedAt < result.startedAt) {
      context.addIssue({
        code: "custom",
        message: "Recovery action finished before it started",
      });
    }
    if (result.durationMs !== result.finishedAt - result.startedAt) {
      context.addIssue({
        code: "custom",
        message: "Recovery duration does not match its timestamps",
      });
    }
  });

const StopResponseSchema = z
  .object({ status: z.literal("stopped") })
  .strict();

type AgentPath =
  | "/v1/workload/state"
  | "/v1/workload/logs"
  | "/v1/workload/health"
  | "/v1/demo/stop"
  | "/v1/demo/ensure"
  | "/v1/actions/execute";

export interface SandboxAgentResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type SandboxAgentFetch = (
  url: string,
  init: RequestInit,
) => Promise<SandboxAgentResponse>;

export interface LinuxSandboxAdapterDependencies {
  readonly token: string;
  readonly fetch?: SandboxAgentFetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly createTimeoutSignal?: (milliseconds: number) => AbortSignal;
}

class SandboxAgentRequestError extends Error {
  constructor(message = "Sandbox agent request failed") {
    super(message);
    this.name = "SandboxAgentRequestError";
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sleepWithSignal(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolveSleep, rejectSleep) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      rejectSleep(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void sleep(milliseconds).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolveSleep();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectSleep(error);
      },
    );
  });
}

const defaultAgentFetch: SandboxAgentFetch = (url, init) => fetch(url, init);

export class LinuxSandboxAdapter {
  private readonly token: string;
  private readonly agentFetch: SandboxAgentFetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly createTimeoutSignal: (milliseconds: number) => AbortSignal;
  private readonly executionLedger = new Set<string>();

  constructor(dependencies: LinuxSandboxAdapterDependencies) {
    if (!dependencies.token || dependencies.token.trim().length === 0) {
      throw new Error("Sandbox agent token is required");
    }
    this.token = dependencies.token;
    this.agentFetch = dependencies.fetch ?? defaultAgentFetch;
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.createTimeoutSignal =
      dependencies.createTimeoutSignal ?? AbortSignal.timeout;
  }

  private async request(
    path: AgentPath,
    method: "GET" | "POST",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const timeoutSignal = this.createTimeoutSignal(REQUEST_TIMEOUT_MS);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    let response: SandboxAgentResponse;
    try {
      response = await this.agentFetch(`${LINUX_SANDBOX_AGENT_ORIGIN}${path}`, {
        method,
        cache: "no-store",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: requestSignal,
      });
    } catch {
      throw new SandboxAgentRequestError();
    }

    if (response.status < 200 || response.status >= 300) {
      throw new SandboxAgentRequestError(
        `Sandbox agent request failed with status ${response.status}`,
      );
    }

    return await response.json();
  }

  async inspectSafeState(): Promise<SafeWorkloadState> {
    return SafeWorkloadStateSchema.parse(
      await this.request("/v1/workload/state", "GET"),
    );
  }

  async readSafeLogTail(): Promise<SafeLogTail> {
    const logs = SafeLogTailSchema.parse(
      await this.request("/v1/workload/logs", "GET"),
    );
    const sanitized = sanitizePublicOutput(
      logs.lines.join("\n"),
      PUBLIC_OUTPUT_CHARACTER_LIMIT,
    );
    const lines = sanitized.text ? sanitized.text.split(/\r?\n/) : [];

    return {
      lines,
      lineCount: lines.length,
      characterCount: Array.from(sanitized.text).length,
      truncated: logs.truncated || sanitized.truncated,
    };
  }

  async checkHealthOnce(signal?: AbortSignal): Promise<HealthEvidence> {
    const requestStartedAt = this.now();
    try {
      return HealthEvidenceSchema.parse(
        await this.request("/v1/workload/health", "GET", undefined, signal),
      );
    } catch (error) {
      if (!(error instanceof SandboxAgentRequestError)) {
        throw error;
      }
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

  async stopDemoService(): Promise<void> {
    StopResponseSchema.parse(
      await this.request("/v1/demo/stop", "POST", {
        kind: "STOP_DEMO_SERVICE_V1",
      }),
    );
  }

  async ensureDemoService(): Promise<SafeWorkloadState> {
    return SafeWorkloadStateSchema.parse(
      await this.request("/v1/demo/ensure", "POST", {
        kind: "ENSURE_DEMO_SERVICE_V1",
      }),
    );
  }

  async executeRecoveryAction(input: unknown): Promise<RecoveryActionResult> {
    const request = RecoveryRequestSchema.parse(input);
    if (this.executionLedger.has(request.executionId)) {
      throw new Error("Duplicate recovery execution rejected");
    }
    this.executionLedger.add(request.executionId);

    return RecoveryActionResultSchema.parse(
      await this.request("/v1/actions/execute", "POST", request),
    );
  }

  async verifyFreshHealth(
    notBefore: number,
    signal?: AbortSignal,
  ): Promise<HealthEvidence> {
    signal?.throwIfAborted();
    const deadline = this.now() + HEALTH_VERIFY_TIMEOUT_MS;
    const deadlineSignal = this.createTimeoutSignal(HEALTH_VERIFY_TIMEOUT_MS);
    const verificationSignal = signal
      ? AbortSignal.any([signal, deadlineSignal])
      : deadlineSignal;
    let lastEvidence: HealthEvidence | null = null;

    for (let attempt = 1; attempt <= MAX_HEALTH_ATTEMPTS; attempt += 1) {
      if (this.now() >= deadline || deadlineSignal.aborted) {
        break;
      }
      const evidence = await this.checkHealthOnce(verificationSignal);
      signal?.throwIfAborted();
      const fresh = evidence.requestStartedAt >= notBefore;
      lastEvidence = {
        ...evidence,
        healthy: evidence.healthy && fresh,
        attempts: attempt,
      };

      if (
        lastEvidence.healthy ||
        this.now() >= deadline ||
        deadlineSignal.aborted
      ) {
        return lastEvidence;
      }

      const remainingMs = Math.max(0, deadline - this.now());
      try {
        await sleepWithSignal(
          this.sleep,
          Math.min(HEALTH_RETRY_INTERVAL_MS, remainingMs),
          verificationSignal,
        );
      } catch (error) {
        signal?.throwIfAborted();
        if (deadlineSignal.aborted) {
          return lastEvidence;
        }
        throw error;
      }
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
