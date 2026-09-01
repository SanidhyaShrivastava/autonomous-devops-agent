import "server-only";

import { fetchMutation } from "convex/nextjs";

import { api } from "../../../convex/_generated/api";
import {
  CONNECTED_HEARTBEAT_INTERVAL_MS,
  CONNECTED_RUNNER_CAPABILITY_ID,
  connectedCommandResultDispositionSchema,
  connectedRunnerHeartbeatResponseSchema,
  type ConnectedCommandResult,
  type ConnectedCommandResultDisposition,
  type ConnectedHealthReport,
  type ConnectedRecoveryCommand,
} from "../connected-runner-protocol";

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

export async function pairRunner(args: {
  clientAddressDigest: string;
  codeDigest: string;
  credentialDigest: string;
  runnerId: string;
  agentVersion: string;
  architecture: RunnerArchitecture;
}): Promise<
  | { status: "paired"; runnerId: string; label: string }
  | { status: "unavailable" }
  | { status: "rate_limited"; retryAfterSeconds: number }
> {
  const result = await fetchMutation(
    api.runners.pairRunner,
    {
      ...args,
      requestSecret: requiredServerEnvironment("RUNNER_PAIRING_REQUEST_SECRET"),
    },
    { url: requiredServerEnvironment("CONVEX_URL") },
  );
  if (result.status === "rate_limited") {
    return {
      status: "rate_limited",
      retryAfterSeconds: result.retryAfterSeconds,
    };
  }
  if (result.status === "unavailable") return result;
  return { status: "paired", runnerId: result.runnerId, label: result.label };
}

export async function recordRunnerHeartbeat(args: {
  clientAddressDigest: string;
  runnerId: string;
  credentialDigest: string;
  agentVersion: string;
  capabilityId?: typeof CONNECTED_RUNNER_CAPABILITY_ID;
  healthReport?: ConnectedHealthReport;
  previousCommandResult?: ConnectedCommandResult;
}): Promise<
  | {
      status: "accepted";
      heartbeatIntervalMs: typeof CONNECTED_HEARTBEAT_INTERVAL_MS;
      workloadRegistered: boolean;
      command: ConnectedRecoveryCommand | null;
      resultDisposition: ConnectedCommandResultDisposition;
    }
  | { status: "unavailable" }
  | { status: "rate_limited"; retryAfterSeconds: number }
> {
  const result = await fetchMutation(
    api.runners.recordHeartbeat,
    {
      ...args,
      requestSecret: requiredServerEnvironment("RUNNER_PAIRING_REQUEST_SECRET"),
    },
    { url: requiredServerEnvironment("CONVEX_URL") },
  );
  if (result.status === "rate_limited") {
    return {
      status: "rate_limited",
      retryAfterSeconds: result.retryAfterSeconds,
    };
  }
  if (result.status === "unavailable") return result;

  const response = connectedRunnerHeartbeatResponseSchema.parse({
    heartbeatIntervalMs: CONNECTED_HEARTBEAT_INTERVAL_MS,
    workloadRegistered: result.workloadRegistered,
    command: result.command ?? null,
  });
  return {
    status: "accepted",
    ...response,
    resultDisposition: connectedCommandResultDispositionSchema.parse(
      result.resultDisposition,
    ),
  };
}
