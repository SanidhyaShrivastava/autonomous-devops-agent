import { pathToFileURL } from "node:url";

import {
  CONNECTED_HEARTBEAT_INTERVAL_MS,
  CONNECTED_RUNNER_CAPABILITY_ID,
  connectedRunnerHeartbeatResponseSchema,
} from "../src/lib/connected-runner-protocol";
import {
  createFixedServiceController,
  type FixedServiceController,
} from "./fixed-service";
import {
  defaultRunnerConfigPath,
  loadRunnerConfig,
  type RunnerConfig,
} from "./config";
import { HOST_AGENT_VERSION } from "./version";

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RETRY_DELAY_MS = 30_000;

function waitForDelay(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function retryDelay(attempt: number) {
  return Math.min(1_000 * 2 ** Math.min(attempt, 5), MAX_RETRY_DELAY_MS);
}

function retryAfterDelay(value: string | null, fallbackMs: number) {
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.ceil(seconds * 1_000), MAX_RETRY_DELAY_MS);
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_DELAY_MS);
  }
  return fallbackMs;
}

async function heartbeatRequest(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  outerSignal: AbortSignal,
) {
  const controller = new AbortController();
  const abort = () => controller.abort(outerSignal.reason);
  if (outerSignal.aborted) abort();
  else outerSignal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await request(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    outerSignal.removeEventListener("abort", abort);
  }
}

export async function runHeartbeatLoop(
  config: RunnerConfig,
  options: {
    request?: typeof fetch;
    serviceController?: FixedServiceController;
    signal: AbortSignal;
    onStatus?: (message: string) => void;
  },
) {
  const request = options.request ?? fetch;
  const serviceController =
    options.serviceController ?? createFixedServiceController();
  let failedAttempts = 0;

  try {
    while (!options.signal.aborted) {
      const healthReport = await serviceController.checkHealth();
      if (options.signal.aborted) break;
      const previousCommandResult = await serviceController.pendingResult();
      if (options.signal.aborted) break;
      let response: Response;
      try {
        response = await heartbeatRequest(
          request,
          `${config.baseUrl}/api/runners/heartbeat`,
          {
            method: "POST",
            redirect: "error",
            headers: {
              Authorization: `Bearer ${config.credential}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              runnerId: config.runnerId,
              agentVersion: HOST_AGENT_VERSION,
              capabilityId: CONNECTED_RUNNER_CAPABILITY_ID,
              healthReport,
              ...(previousCommandResult ? { previousCommandResult } : {}),
            }),
          },
          options.signal,
        );
      } catch {
        if (options.signal.aborted) break;
        await waitForDelay(retryDelay(failedAttempts), options.signal);
        failedAttempts += 1;
        continue;
      }

      if (response.status === 401) {
        throw new Error("The runner credential was revoked or is invalid.");
      }
      if (response.status === 429) {
        const fallbackMs = retryDelay(failedAttempts);
        const delayMs = retryAfterDelay(
          response.headers.get("retry-after"),
          fallbackMs,
        );
        failedAttempts += 1;
        await waitForDelay(delayMs, options.signal);
        continue;
      }
      if (response.status >= 500 && response.status <= 599) {
        await waitForDelay(retryDelay(failedAttempts), options.signal);
        failedAttempts += 1;
        continue;
      }
      if (!response.ok) {
        throw new Error("The control plane rejected the runner heartbeat.");
      }

      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new Error("The control plane returned an invalid response.");
      }
      const parsed = connectedRunnerHeartbeatResponseSchema.safeParse(value);
      if (!parsed.success) {
        throw new Error("The control plane returned an invalid response.");
      }

      failedAttempts = 0;
      if (previousCommandResult) {
        await serviceController.markResultDelivered(
          previousCommandResult.commandId,
          previousCommandResult.executionNonce,
        );
      }
      options.onStatus?.(`Runner online: ${config.runnerId}`);

      if (parsed.data.command) {
        const result = await serviceController.execute(parsed.data.command);
        if (result) continue;
      }
      await waitForDelay(CONNECTED_HEARTBEAT_INTERVAL_MS, options.signal);
    }
  } finally {
    await serviceController.stop();
  }
}

async function main() {
  if (process.platform !== "linux") {
    throw new Error("This heartbeat command must run on the Linux server.");
  }
  const config = await loadRunnerConfig(defaultRunnerConfigPath());
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  await runHeartbeatLoop(config, {
    signal: controller.signal,
    onStatus: (message) => process.stdout.write(`${message}\n`),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Runner connection failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
