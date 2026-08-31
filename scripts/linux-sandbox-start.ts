import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { config as loadEnvironment } from "dotenv";

import {
  DEMO_EXPECTED_SERVICE,
  DEMO_EXPECTED_STATUS,
} from "../runner/config";
import { LinuxSandboxAdapter } from "../runner/linux-sandbox-adapter";
import {
  ensureSandboxContainer,
  SANDBOX_CONTAINER_NAME,
} from "../runner/sandbox-container";
import { deriveSandboxAgentToken } from "../runner/sandbox-token";

const AGENT_READY_TIMEOUT_MS = 10_000;
const AGENT_READY_RETRY_MS = 250;

function requiredRunnerToken(environment: NodeJS.ProcessEnv): string {
  const runnerToken = environment.RUNNER_TOKEN?.trim();
  if (!runnerToken) {
    throw new Error("RUNNER_TOKEN is required in the private runner settings");
  }
  return runnerToken;
}

async function waitForAgent(adapter: LinuxSandboxAdapter): Promise<void> {
  const deadline = Date.now() + AGENT_READY_TIMEOUT_MS;
  do {
    try {
      await adapter.inspectSafeState();
      return;
    } catch {
      if (Date.now() >= deadline) {
        break;
      }
      await new Promise((resolveRetry) =>
        setTimeout(resolveRetry, AGENT_READY_RETRY_MS),
      );
    }
  } while (Date.now() < deadline);

  throw new Error("The isolated Linux sandbox agent did not become ready");
}

export async function startLinuxSandbox() {
  loadEnvironment({
    path: [resolve(".env.runner.local"), resolve(".env.local")],
    quiet: true,
  });

  const token = deriveSandboxAgentToken(requiredRunnerToken(process.env));
  const container = await ensureSandboxContainer(token);
  const adapter = new LinuxSandboxAdapter({ token });
  await waitForAgent(adapter);

  const healthCheckStartedAt = Date.now();
  const state = await adapter.ensureDemoService();
  const health = await adapter.verifyFreshHealth(healthCheckStartedAt);
  if (
    state.status !== "running" ||
    !health.healthy ||
    health.httpStatus !== 200 ||
    health.service !== DEMO_EXPECTED_SERVICE ||
    health.status !== DEMO_EXPECTED_STATUS
  ) {
    throw new Error("The isolated Linux workload did not verify healthy");
  }

  return { adapter, container, health, state };
}

async function main(): Promise<void> {
  const result = await startLinuxSandbox();
  console.log(
    JSON.stringify({
      container: SANDBOX_CONTAINER_NAME,
      agent: "ready",
      workload: result.state.status,
      health: result.health.status,
    }),
  );
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && pathToFileURL(resolve(entry)).href === import.meta.url);
}

if (isDirectExecution()) {
  void main().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "The isolated Linux sandbox could not start",
    );
    process.exitCode = 1;
  });
}
