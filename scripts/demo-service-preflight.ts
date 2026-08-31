import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { ConvexHttpClient } from "convex/browser";
import { config as loadEnvironment } from "dotenv";

import { api } from "../convex/_generated/api";
import {
  DEMO_EXPECTED_SERVICE,
  DEMO_EXPECTED_STATUS,
  DEMO_LABEL_VALUE,
} from "../runner/config";
import { LinuxSandboxAdapter } from "../runner/linux-sandbox-adapter";
import { deriveSandboxAgentToken } from "../runner/sandbox-token";

const NETWORK_TIMEOUT_MS = 10_000;
const PUBLIC_APP_MARKER =
  "Recover one failed Linux service safely in about 20 seconds.";

function requiredEnvironment(
  name: "CONVEX_URL" | "PUBLIC_APP_URL" | "RUNNER_TOKEN",
) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireSafeUrl(rawUrl: string, name: string) {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    throw new Error(`${name} must be a credential-free HTTPS URL`);
  }
  return parsedUrl.origin;
}

function verifyCodexLogin() {
  const result = spawnSync("codex", ["login", "status"], {
    encoding: "utf8",
    shell: false,
    timeout: NETWORK_TIMEOUT_MS,
  });
  const statusOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (
    result.error ||
    result.status !== 0 ||
    !statusOutput.includes("Logged in using ChatGPT")
  ) {
    throw new Error("Preflight failed: Codex ChatGPT login is unavailable.");
  }
}

async function verifyPublicApp(publicAppOrigin: string) {
  try {
    const response = await fetch(publicAppOrigin, {
      redirect: "error",
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    if (
      !response.ok ||
      !contentType.includes("text/html") ||
      !body.includes(PUBLIC_APP_MARKER)
    ) {
      throw new Error("unexpected public app response");
    }
  } catch {
    throw new Error("Preflight failed: the public app is not reachable.");
  }
}

async function main(): Promise<void> {
  verifyCodexLogin();

  loadEnvironment({
    path: [resolve(".env.runner.local"), resolve(".env.local")],
    quiet: true,
  });

  const adapter = new LinuxSandboxAdapter({
    token: deriveSandboxAgentToken(requiredEnvironment("RUNNER_TOKEN")),
  });
  let state: Awaited<ReturnType<LinuxSandboxAdapter["inspectSafeState"]>>;
  let health: Awaited<ReturnType<LinuxSandboxAdapter["checkHealthOnce"]>>;
  try {
    state = await adapter.inspectSafeState();
    health = await adapter.checkHealthOnce();
  } catch {
    throw new Error(
      "Preflight failed: the Linux sandbox or demo service is unavailable.",
    );
  }

  if (
    state.demoLabel !== DEMO_LABEL_VALUE ||
    state.status !== "running" ||
    !health.healthy ||
    health.httpStatus !== 200 ||
    health.service !== DEMO_EXPECTED_SERVICE ||
    health.status !== DEMO_EXPECTED_STATUS
  ) {
    throw new Error("Preflight failed: the disposable demo service is not ready.");
  }

  const convexOrigin = requireSafeUrl(
    requiredEnvironment("CONVEX_URL"),
    "CONVEX_URL",
  );
  const publicAppOrigin = requireSafeUrl(
    requiredEnvironment("PUBLIC_APP_URL"),
    "PUBLIC_APP_URL",
  );
  const convex = new ConvexHttpClient(convexOrigin);
  const publicState = await (async () => {
    try {
      return await convex.query(api.demo.getPublicState, {});
    } catch {
      throw new Error("Preflight failed: Convex production is not reachable.");
    }
  })();
  if (!publicState.enabled) {
    throw new Error("Preflight failed: the production demo is disabled.");
  }
  if (
    !publicState.runnerOnline ||
    publicState.runnerHeartbeatAt === null ||
    !Number.isFinite(publicState.runnerHeartbeatAt)
  ) {
    throw new Error("Preflight failed: the runner heartbeat is stale.");
  }

  await verifyPublicApp(publicAppOrigin);

  console.log("Linux sandbox agent: ready");
  console.log(`Child service (${DEMO_EXPECTED_SERVICE}): ready`);
  console.log("Health: healthy");
  console.log("Codex login: ChatGPT");
  console.log("Convex production: reachable");
  console.log("Runner heartbeat: fresh");
  console.log("Public app: reachable");
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "The fixed disposable demo service preflight failed",
  );
  process.exitCode = 1;
});
