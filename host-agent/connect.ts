import { pathToFileURL } from "node:url";

import { defaultRunnerConfigPath, loadRunnerConfig, type RunnerConfig } from "./config";

const HEARTBEAT_INTERVAL_MS = 2_000;

function waitForNextHeartbeat(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

export async function runHeartbeatLoop(
  config: RunnerConfig,
  options: {
    request?: typeof fetch;
    signal: AbortSignal;
    onStatus?: (message: string) => void;
  },
) {
  const request = options.request ?? fetch;

  while (!options.signal.aborted) {
    let response: Response;
    try {
      response = await request(`${config.baseUrl}/api/runners/heartbeat`, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${config.credential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentVersion: config.agentVersion,
          runnerId: config.runnerId,
        }),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal.aborted) break;
      throw error;
    }
    if (!response.ok) {
      throw new Error("The control plane rejected this runner credential.");
    }

    options.onStatus?.(`Runner online: ${config.runnerId}`);
    await waitForNextHeartbeat(HEARTBEAT_INTERVAL_MS, options.signal);
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
