import { describe, expect, it } from "vitest";

import { evaluateRecoveryPolicy } from "../src/lib/policy";

function validPolicyRequest() {
  return {
    incidentId: "incident-1",
    activeIncidentId: "incident-1",
    incidentState: "policy_check",
    workloadId: "demo-service",
    actionId: "restart_demo_service",
    confidence: 0.8,
    runnerId: "gx-local-runner",
    executionId: "execution-1",
    previousExecutionIds: [] as string[],
  };
}

describe("deterministic recovery policy", () => {
  it("permits only the exact fixed recovery request at the confidence boundary", () => {
    const decision = evaluateRecoveryPolicy(validPolicyRequest());

    expect(decision).toEqual({
      allowed: true,
      actionId: "restart_demo_service",
    });
    expect(Object.keys(decision).sort()).toEqual(["actionId", "allowed"]);
  });

  it.each([
    ["different active incident", { activeIncidentId: "incident-2" }, "inactive_incident"],
    ["wrong incident phase", { incidentState: "investigating" }, "inactive_incident"],
    ["terminal incident", { incidentState: "resolved" }, "inactive_incident"],
    ["different workload", { workloadId: "billing-service" }, "workload_not_allowed"],
    ["unknown action", { actionId: "restart_everything" }, "action_not_allowed"],
    ["no action", { actionId: "no_action" }, "action_not_allowed"],
    ["different runner", { runnerId: "unknown-runner" }, "runner_not_allowed"],
    ["confidence below threshold", { confidence: 0.799999 }, "confidence_too_low"],
    ["prior execution", { previousExecutionIds: ["execution-0"] }, "duplicate_execution"],
  ] as const)("denies %s", (_name, override, reason) => {
    const decision = evaluateRecoveryPolicy({
      ...validPolicyRequest(),
      ...override,
    });

    expect(decision).toEqual({ allowed: false, reason });
    expect(JSON.stringify(decision)).not.toContain("docker");
  });

  it.each([
    ["numeric string", "0.9"],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative confidence", -0.1],
    ["confidence above one", 1.1],
  ])("rejects malformed confidence: %s", (_name, confidence) => {
    expect(
      evaluateRecoveryPolicy({
        ...validPolicyRequest(),
        confidence,
      }),
    ).toEqual({ allowed: false, reason: "invalid_request" });
  });

  it.each([
    ["whitespace action", { actionId: " restart_demo_service" }],
    ["case-changed action", { actionId: "RESTART_DEMO_SERVICE" }],
    ["whitespace workload", { workloadId: "demo-service " }],
    ["case-changed runner", { runnerId: "GX-LOCAL-RUNNER" }],
    ["empty execution ID", { executionId: "" }],
    ["empty previous execution ID", { previousExecutionIds: [""] }],
  ] as const)("rejects exact-value bypass: %s", (_name, override) => {
    expect(
      evaluateRecoveryPolicy({
        ...validPolicyRequest(),
        ...override,
      }),
    ).toEqual({ allowed: false, reason: "invalid_request" });
  });

  it.each([
    ["command", "docker start another-container"],
    ["args", ["start", "another-container"]],
    ["parameters", { force: true }],
    ["container", "another-container"],
    ["path", "/var/run/docker.sock"],
    ["url", "http://example.com"],
    ["env", { TOKEN: "attacker-value" }],
  ])("rejects extra operational field %s", (field, value) => {
    const decision = evaluateRecoveryPolicy({
      ...validPolicyRequest(),
      [field]: value,
    });

    expect(decision).toEqual({ allowed: false, reason: "invalid_request" });
    expect(JSON.stringify(decision)).not.toContain(String(value));
  });
});
