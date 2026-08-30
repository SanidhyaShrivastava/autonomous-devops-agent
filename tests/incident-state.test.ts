import { describe, expect, it } from "vitest";

import {
  DiagnosisSchema,
  INCIDENT_ACTIVE_PHASES,
  INCIDENT_TERMINAL_STATES,
  type IncidentState,
} from "../src/lib/contracts";
import {
  attemptIncidentTransition,
  type IncidentTransitionContext,
} from "../src/lib/incident-state";

const VALID_EXECUTION_ID = "execution-1";

function freshRecoveryContext(
  overrides: Partial<IncidentTransitionContext> = {},
): IncidentTransitionContext {
  return {
    execution: {
      executionId: VALID_EXECUTION_ID,
      actionId: "restart_demo_service",
      exitCode: 0,
      finishedAt: 1_000,
    },
    verification: {
      executionId: VALID_EXECUTION_ID,
      requestStartedAt: 1_001,
      checkedAt: 1_002,
      httpStatus: 200,
      service: "gx-autodevops-demo-service",
      status: "healthy",
    },
    previousExecutionIds: [],
    ...overrides,
  };
}

function freshExecutionStartContext(): IncidentTransitionContext {
  return {
    requestedExecutionId: VALID_EXECUTION_ID,
    previousExecutionIds: [],
  };
}

const ALLOWED_TRANSITIONS = new Set([
  "failed_detected->investigating",
  "investigating->manager_review",
  "manager_review->policy_check",
  "policy_check->executing",
  "executing->verifying",
  "verifying->resolved",
  "investigating->needs_human",
  "investigating->investigation_failed",
  "manager_review->needs_human",
  "policy_check->needs_human",
  "executing->failed_recovery",
  "verifying->failed_recovery",
]);

describe("incident transition contract", () => {
  it("allows every documented edge and rejects every skipped, backward, or self transition", () => {
    const states: readonly IncidentState[] = [
      ...INCIDENT_ACTIVE_PHASES,
      ...INCIDENT_TERMINAL_STATES,
    ];

    for (const current of states) {
      for (const next of states) {
        const edge = `${current}->${next}`;
        const context =
          edge === "verifying->resolved"
            ? freshRecoveryContext()
            : edge === "policy_check->executing"
              ? freshExecutionStartContext()
              : undefined;
        const result = attemptIncidentTransition({ current, next, context });

        expect(result.allowed, edge).toBe(ALLOWED_TRANSITIONS.has(edge));
      }
    }
  });

  it.each(INCIDENT_TERMINAL_STATES)(
    "does not reopen terminal state %s",
    (terminalState) => {
      const result = attemptIncidentTransition({
        current: terminalState,
        next: "investigating",
      });

      expect(result).toEqual({
        allowed: false,
        reason: "terminal_state",
      });
    },
  );
});

describe("execution idempotency", () => {
  it("requires an execution ID and checked ledger before entering executing", () => {
    expect(
      attemptIncidentTransition({
        current: "policy_check",
        next: "executing",
      }),
    ).toEqual({
      allowed: false,
      reason: "execution_ledger_required",
    });
  });

  it("rejects a second action even when it uses a different execution ID", () => {
    expect(
      attemptIncidentTransition({
        current: "policy_check",
        next: "executing",
        context: {
          requestedExecutionId: "execution-2",
          previousExecutionIds: [VALID_EXECUTION_ID],
        },
      }),
    ).toEqual({
      allowed: false,
      reason: "duplicate_execution",
    });
  });
});

describe("bounded diagnosis contract", () => {
  const validDiagnosis = {
    summary: "The fixed demo service is stopped.",
    evidence: ["Container status is exited."],
    confidence: 0.9,
    action: "restart_demo_service",
  };

  it("accepts a bounded structured diagnosis", () => {
    expect(DiagnosisSchema.safeParse(validDiagnosis).success).toBe(true);
  });

  it.each([
    ["overlong evidence", { evidence: ["x".repeat(501)] }],
    [
      "too many evidence items",
      { evidence: Array.from({ length: 11 }, () => "safe evidence") },
    ],
    ["non-finite confidence", { confidence: Number.POSITIVE_INFINITY }],
    ["unknown action", { action: "run_shell_command" }],
    ["extra command field", { command: "docker start anything" }],
  ])("rejects %s", (_name, override) => {
    expect(
      DiagnosisSchema.safeParse({ ...validDiagnosis, ...override }).success,
    ).toBe(false);
  });
});

describe("resolved requires linked fresh health evidence", () => {
  it("accepts exact post-action health evidence", () => {
    expect(
      attemptIncidentTransition({
        current: "verifying",
        next: "resolved",
        context: freshRecoveryContext(),
      }),
    ).toEqual({ allowed: true, next: "resolved" });
  });

  it("rejects command exit code 0 by itself", () => {
    const context = freshRecoveryContext();

    expect(
      attemptIncidentTransition({
        current: "verifying",
        next: "resolved",
        context: { execution: context.execution },
      }),
    ).toEqual({
      allowed: false,
      reason: "fresh_verification_required",
    });
  });

  it.each([
    {
      name: "health request started before the action finished",
      context: freshRecoveryContext({
        verification: {
          ...freshRecoveryContext().verification!,
          requestStartedAt: 999,
        },
      }),
    },
    {
      name: "verification used a different execution ID",
      context: freshRecoveryContext({
        verification: {
          ...freshRecoveryContext().verification!,
          executionId: "execution-2",
        },
      }),
    },
    {
      name: "health response was not HTTP 200",
      context: freshRecoveryContext({
        verification: {
          ...freshRecoveryContext().verification!,
          httpStatus: 503,
        },
      }),
    },
    {
      name: "health response named the wrong service",
      context: freshRecoveryContext({
        verification: {
          ...freshRecoveryContext().verification!,
          service: "another-service",
        },
      }),
    },
    {
      name: "health response did not report healthy",
      context: freshRecoveryContext({
        verification: {
          ...freshRecoveryContext().verification!,
          status: "starting",
        },
      }),
    },
  ])("rejects $name", ({ context }) => {
    expect(
      attemptIncidentTransition({
        current: "verifying",
        next: "resolved",
        context,
      }),
    ).toEqual({
      allowed: false,
      reason: "verification_contract_failed",
    });
  });

  it.each([
    ["the same execution ID", VALID_EXECUTION_ID],
    ["a different earlier execution ID", "execution-0"],
  ])("rejects prior execution: %s", (_name, previousExecutionId) => {
    expect(
      attemptIncidentTransition({
        current: "verifying",
        next: "resolved",
        context: freshRecoveryContext({
          previousExecutionIds: [previousExecutionId],
        }),
      }),
    ).toEqual({
      allowed: false,
      reason: "duplicate_execution",
    });
  });
});

describe("strict transition input validation", () => {
  it.each([
    [
      "unknown transition field",
      {
        current: "failed_detected",
        next: "investigating",
        command: "docker start anything",
      },
    ],
    [
      "runner-unavailable as an incident state",
      { current: "runner_unavailable", next: "investigating" },
    ],
    [
      "non-finite execution timestamp",
      {
        current: "verifying",
        next: "resolved",
        context: freshRecoveryContext({
          execution: {
            ...freshRecoveryContext().execution!,
            finishedAt: Number.POSITIVE_INFINITY,
          },
        }),
      },
    ],
    [
      "unknown execution action",
      {
        current: "verifying",
        next: "resolved",
        context: {
          ...freshRecoveryContext(),
          execution: {
            ...freshRecoveryContext().execution!,
            actionId: "restart_everything",
          },
        },
      },
    ],
  ])("rejects malformed input: %s", (_name, input) => {
    expect(attemptIncidentTransition(input)).toEqual({
      allowed: false,
      reason: "invalid_transition",
    });
  });

  it.each([
    [
      "nonzero recovery exit code",
      freshRecoveryContext({
        execution: {
          ...freshRecoveryContext().execution!,
          exitCode: 1,
        },
      }),
    ],
    [
      "health check completed before it began",
      freshRecoveryContext({
        verification: {
          ...freshRecoveryContext().verification!,
          checkedAt: 1_000,
        },
      }),
    ],
  ])("rejects invalid recovery proof: %s", (_name, context) => {
    expect(
      attemptIncidentTransition({
        current: "verifying",
        next: "resolved",
        context,
      }),
    ).toEqual({
      allowed: false,
      reason: "verification_contract_failed",
    });
  });
});
