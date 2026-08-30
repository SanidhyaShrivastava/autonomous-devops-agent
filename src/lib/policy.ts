import { z } from "zod";

import {
  DEMO_ACTION_ID,
  DEMO_RUNNER_ID,
  DEMO_WORKLOAD_ID,
  IncidentStateSchema,
} from "./contracts";

const MINIMUM_AUTONOMOUS_CONFIDENCE = 0.8;

const FixedIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9_-]+$/);

const PolicyRequestSchema = z
  .object({
    incidentId: FixedIdentifierSchema,
    activeIncidentId: FixedIdentifierSchema.nullable(),
    incidentState: IncidentStateSchema,
    workloadId: FixedIdentifierSchema,
    actionId: FixedIdentifierSchema,
    confidence: z.number().finite().min(0).max(1),
    runnerId: FixedIdentifierSchema,
    executionId: FixedIdentifierSchema,
    previousExecutionIds: z.array(FixedIdentifierSchema).max(100),
  })
  .strict();

export type PolicyDenialReason =
  | "invalid_request"
  | "inactive_incident"
  | "workload_not_allowed"
  | "action_not_allowed"
  | "runner_not_allowed"
  | "confidence_too_low"
  | "duplicate_execution";

export type RecoveryPolicyDecision =
  | { readonly allowed: true; readonly actionId: typeof DEMO_ACTION_ID }
  | { readonly allowed: false; readonly reason: PolicyDenialReason };

export function evaluateRecoveryPolicy(input: unknown): RecoveryPolicyDecision {
  const parsed = PolicyRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { allowed: false, reason: "invalid_request" };
  }

  const request = parsed.data;
  if (
    request.incidentId !== request.activeIncidentId ||
    request.incidentState !== "policy_check"
  ) {
    return { allowed: false, reason: "inactive_incident" };
  }

  if (request.workloadId !== DEMO_WORKLOAD_ID) {
    return { allowed: false, reason: "workload_not_allowed" };
  }

  if (request.actionId !== DEMO_ACTION_ID) {
    return { allowed: false, reason: "action_not_allowed" };
  }

  if (request.runnerId !== DEMO_RUNNER_ID) {
    return { allowed: false, reason: "runner_not_allowed" };
  }

  if (request.confidence < MINIMUM_AUTONOMOUS_CONFIDENCE) {
    return { allowed: false, reason: "confidence_too_low" };
  }

  if (request.previousExecutionIds.length > 0) {
    return { allowed: false, reason: "duplicate_execution" };
  }

  return { allowed: true, actionId: DEMO_ACTION_ID };
}
