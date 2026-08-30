import "server-only";

import { fetchMutation } from "convex/nextjs";

import { api } from "../../../convex/_generated/api";

type RequestDemoRunResult =
  | { status: "accepted"; demoCommandId: string }
  | {
      status:
        | "active"
        | "cooldown"
        | "daily_cap"
        | "runner_offline"
        | "disabled";
    };

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
}): Promise<RequestDemoRunResult> {
  const url = requiredServerEnvironment("CONVEX_URL");

  try {
    const result = await fetchMutation(
      api.demo.requestRun,
      { requestSecret: args.requestSecret },
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
      case "DEMO_DISABLED":
        return { status: "disabled" };
      default:
        throw error;
    }
  }
}
