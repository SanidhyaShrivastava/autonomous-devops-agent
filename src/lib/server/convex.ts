import "server-only";

import { fetchMutation, fetchQuery } from "convex/nextjs";

import { api } from "../../../convex/_generated/api";

type RequestDemoRunResult =
  | { status: "accepted"; demoCommandId: string }
  | {
      status:
        | "active"
        | "cooldown"
        | "daily_cap"
        | "runner_offline"
        | "environment_recovery_pending"
        | "disabled";
    };

export type DemoApprovalSession = {
  demoCommandId: string;
  incidentId: string;
  status: "pending" | "approved" | "rejected" | "expired";
  expiresAt: number;
  decidedAt: number | null;
};

export type DemoApprovalDecisionResult =
  | {
      demoCommandId: string;
      incidentId: string;
      recoveryCommandId: string;
      status: "approved" | "rejected";
      decidedAt: number;
    }
  | { status: "unavailable" | "runner_offline" };

function requiredServerEnvironment(name: "CONVEX_URL") {
  const value = process.env[name];
  if (!value) {
    throw new Error("Server configuration unavailable");
  }
  return value;
}

function convexErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("data" in error)) {
    return null;
  }
  const data = error.data;
  if (!data || typeof data !== "object" || !("code" in data)) {
    return null;
  }
  return typeof data.code === "string" ? data.code : null;
}

export async function requestDemoRun(args: {
  requestSecret: string;
  executionMode?: "autonomous" | "approval_required";
  approvalCapabilityDigest?: string;
}): Promise<RequestDemoRunResult> {
  const url = requiredServerEnvironment("CONVEX_URL");

  try {
    const result = await fetchMutation(
      api.demo.requestRun,
      args.executionMode === undefined
        ? { requestSecret: args.requestSecret }
        : {
            requestSecret: args.requestSecret,
            executionMode: args.executionMode,
            ...(args.approvalCapabilityDigest === undefined
              ? {}
              : {
                  approvalCapabilityDigest:
                    args.approvalCapabilityDigest,
                }),
          },
      { url },
    );
    return { status: "accepted", demoCommandId: result.demoCommandId };
  } catch (error) {
    switch (convexErrorCode(error)) {
      case "ACTIVE_RUN":
        return { status: "active" };
      case "COOLDOWN":
        return { status: "cooldown" };
      case "DAILY_CAP":
        return { status: "daily_cap" };
      case "RUNNER_OFFLINE":
        return { status: "runner_offline" };
      case "ENVIRONMENT_RECOVERY_PENDING":
        return { status: "environment_recovery_pending" };
      case "DEMO_DISABLED":
        return { status: "disabled" };
      default:
        throw error;
    }
  }
}

export async function getDemoApprovalSession(args: {
  requestSecret: string;
  approvalCapabilityDigest: string;
}): Promise<DemoApprovalSession | null> {
  const url = requiredServerEnvironment("CONVEX_URL");
  return await fetchQuery(
    api.demo.getApprovalSession,
    {
      requestSecret: args.requestSecret,
      approvalCapabilityDigest: args.approvalCapabilityDigest,
    },
    { url },
  );
}

export async function decideDemoApproval(args: {
  requestSecret: string;
  approvalCapabilityDigest: string;
  decision: "approved" | "rejected";
}): Promise<DemoApprovalDecisionResult> {
  const url = requiredServerEnvironment("CONVEX_URL");
  try {
    return await fetchMutation(
      api.demo.decideApproval,
      {
        requestSecret: args.requestSecret,
        approvalCapabilityDigest: args.approvalCapabilityDigest,
        decision: args.decision,
      },
      { url },
    );
  } catch (error) {
    switch (convexErrorCode(error)) {
      case "APPROVAL_NOT_FOUND":
      case "APPROVAL_NOT_PENDING":
      case "APPROVAL_EXPIRED":
        return { status: "unavailable" };
      case "RUNNER_OFFLINE":
        return { status: "runner_offline" };
      default:
        throw error;
    }
  }
}
