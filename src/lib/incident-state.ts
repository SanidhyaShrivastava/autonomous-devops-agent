import { z } from "zod";

import {
  DEMO_ACTION_ID,
  DEMO_HEALTHY_STATUS,
  DEMO_SERVICE_IDENTITY,
  INCIDENT_TERMINAL_STATES,
  IncidentStateSchema,
  type IncidentState,
} from "./contracts";

const ExecutionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const RecoveryExecutionSchema = z
  .object({
    executionId: ExecutionIdSchema,
    actionId: z.literal(DEMO_ACTION_ID),
    exitCode: z.number().int(),
    finishedAt: z.number().finite().nonnegative(),
  })
  .strict();

const HealthVerificationSchema = z
  .object({
    executionId: ExecutionIdSchema,
    requestStartedAt: z.number().finite().nonnegative(),
    checkedAt: z.number().finite().nonnegative(),
    httpStatus: z.number().int().min(100).max(599),
    service: z.string().min(1).max(128),
    status: z.string().min(1).max(64),
  })
  .strict();

const IncidentTransitionContextSchema = z
  .object({
    requestedExecutionId: ExecutionIdSchema.optional(),
    execution: RecoveryExecutionSchema.optional(),
    verification: HealthVerificationSchema.optional(),
    previousExecutionIds: z.array(ExecutionIdSchema).max(100).optional(),
  })
  .strict();

const IncidentTransitionRequestSchema = z
  .object({
    current: IncidentStateSchema,
    next: IncidentStateSchema,
    context: IncidentTransitionContextSchema.optional(),
  })
  .strict();

export type RecoveryExecutionEvidence = z.infer<
  typeof RecoveryExecutionSchema
>;
export type HealthVerificationEvidence = z.infer<
  typeof HealthVerificationSchema
>;
export type IncidentTransitionContext = z.infer<
  typeof IncidentTransitionContextSchema
>;

export type IncidentTransitionDenialReason =
  | "invalid_transition"
  | "terminal_state"
  | "fresh_verification_required"
  | "execution_ledger_required"
  | "duplicate_execution"
  | "verification_contract_failed";

export type IncidentTransitionResult =
  | { readonly allowed: true; readonly next: IncidentState }
  | {
      readonly allowed: false;
      readonly reason: IncidentTransitionDenialReason;
    };

const TERMINAL_STATES = new Set<IncidentState>(INCIDENT_TERMINAL_STATES);

const ALLOWED_NEXT_STATES: Readonly<
  Record<IncidentState, readonly IncidentState[]>
> = {
  failed_detected: ["investigating"],
  investigating: [
    "manager_review",
    "needs_human",
    "investigation_failed",
  ],
  manager_review: ["policy_check", "needs_human"],
  policy_check: ["executing", "needs_human"],
  executing: ["verifying", "failed_recovery"],
  verifying: ["resolved", "failed_recovery"],
  resolved: [],
  needs_human: [],
  failed_recovery: [],
  investigation_failed: [],
};

function validateResolvedContext(
  context: IncidentTransitionContext | undefined,
): IncidentTransitionResult | null {
  if (!context?.execution || !context.verification) {
    return { allowed: false, reason: "fresh_verification_required" };
  }

  if (!context.previousExecutionIds) {
    return { allowed: false, reason: "execution_ledger_required" };
  }

  if (context.previousExecutionIds.length > 0) {
    return { allowed: false, reason: "duplicate_execution" };
  }

  const { execution, verification } = context;
  const verificationContractPassed =
    execution.actionId === DEMO_ACTION_ID &&
    execution.exitCode === 0 &&
    verification.executionId === execution.executionId &&
    verification.requestStartedAt >= execution.finishedAt &&
    verification.checkedAt >= verification.requestStartedAt &&
    verification.httpStatus === 200 &&
    verification.service === DEMO_SERVICE_IDENTITY &&
    verification.status === DEMO_HEALTHY_STATUS;

  return verificationContractPassed
    ? null
    : { allowed: false, reason: "verification_contract_failed" };
}

function validateExecutionStartContext(
  context: IncidentTransitionContext | undefined,
): IncidentTransitionResult | null {
  if (!context?.requestedExecutionId || !context.previousExecutionIds) {
    return { allowed: false, reason: "execution_ledger_required" };
  }

  if (context.previousExecutionIds.length > 0) {
    return { allowed: false, reason: "duplicate_execution" };
  }

  return null;
}

export function attemptIncidentTransition(
  input: unknown,
): IncidentTransitionResult {
  const parsed = IncidentTransitionRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { allowed: false, reason: "invalid_transition" };
  }

  const { current, next, context } = parsed.data;
  if (TERMINAL_STATES.has(current)) {
    return { allowed: false, reason: "terminal_state" };
  }

  if (!ALLOWED_NEXT_STATES[current].includes(next)) {
    return { allowed: false, reason: "invalid_transition" };
  }

  if (current === "policy_check" && next === "executing") {
    const denial = validateExecutionStartContext(context);
    if (denial) {
      return denial;
    }
  }

  if (next === "resolved") {
    const denial = validateResolvedContext(context);
    if (denial) {
      return denial;
    }
  }

  return { allowed: true, next };
}
