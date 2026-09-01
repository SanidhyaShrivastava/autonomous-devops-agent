import "server-only";

import { fetchMutation } from "convex/nextjs";

import { api } from "../../../convex/_generated/api";

type RunnerArchitecture = "x64" | "arm64";

function requiredServerEnvironment(
  name: "CONVEX_URL" | "RUNNER_PAIRING_REQUEST_SECRET",
) {
  const value = process.env[name];
  if (!value) {
    throw new Error("Server configuration unavailable");
  }
  return value;
}

function convexErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("data" in error)) return null;
  const data = error.data;
  if (!data || typeof data !== "object" || !("code" in data)) return null;
  return typeof data.code === "string" ? data.code : null;
}

export async function pairRunner(args: {
  codeDigest: string;
  credentialDigest: string;
  runnerId: string;
  agentVersion: string;
  architecture: RunnerArchitecture;
}): Promise<
  | { status: "paired"; runnerId: string; label: string }
  | { status: "unavailable" }
> {
  try {
    const result = await fetchMutation(
      api.runners.pairRunner,
      {
        ...args,
        requestSecret: requiredServerEnvironment(
          "RUNNER_PAIRING_REQUEST_SECRET",
        ),
      },
      { url: requiredServerEnvironment("CONVEX_URL") },
    );
    return { status: "paired", runnerId: result.runnerId, label: result.label };
  } catch (error) {
    if (convexErrorCode(error) === "PAIRING_UNAVAILABLE") {
      return { status: "unavailable" };
    }
    throw error;
  }
}

export async function recordRunnerHeartbeat(args: {
  runnerId: string;
  credentialDigest: string;
  agentVersion: string;
}): Promise<{ status: "accepted" } | { status: "unavailable" }> {
  try {
    await fetchMutation(
      api.runners.recordHeartbeat,
      {
        ...args,
        requestSecret: requiredServerEnvironment(
          "RUNNER_PAIRING_REQUEST_SECRET",
        ),
      },
      { url: requiredServerEnvironment("CONVEX_URL") },
    );
    return { status: "accepted" };
  } catch (error) {
    if (convexErrorCode(error) === "RUNNER_UNAVAILABLE") {
      return { status: "unavailable" };
    }
    throw error;
  }
}
