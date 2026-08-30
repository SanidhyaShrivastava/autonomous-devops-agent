import { z } from "zod";

export const INCIDENT_ACTIVE_PHASES = [
  "failed_detected",
  "investigating",
  "manager_review",
  "policy_check",
  "executing",
  "verifying",
] as const;

export const INCIDENT_TERMINAL_STATES = [
  "resolved",
  "needs_human",
  "failed_recovery",
  "investigation_failed",
] as const;

export const INCIDENT_STATES = [
  ...INCIDENT_ACTIVE_PHASES,
  ...INCIDENT_TERMINAL_STATES,
] as const;

export const AGENT_ROLES = [
  "incident_manager",
  "investigator",
  "recovery_planner",
  "policy_gate",
  "executor",
  "verifier",
] as const;

export const DEMO_WORKLOAD_ID = "demo-service" as const;
export const DEMO_ACTION_ID = "restart_demo_service" as const;
export const NO_ACTION_ID = "no_action" as const;
export const DEMO_RUNNER_ID = "gx-local-runner" as const;
export const DEMO_SERVICE_IDENTITY =
  "gx-autodevops-demo-service" as const;
export const DEMO_HEALTHY_STATUS = "healthy" as const;

export const ACTION_IDS = [DEMO_ACTION_ID, NO_ACTION_ID] as const;

export const STEP_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "blocked",
] as const;

export const IncidentStateSchema = z.enum(INCIDENT_STATES);
export const ActionIdSchema = z.enum(ACTION_IDS);

const BoundedEvidenceSchema = z.string().trim().min(1).max(500);

export const DiagnosisSchema = z
  .object({
    incidentCategory: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(1_000),
    evidence: z.array(BoundedEvidenceSchema).min(1).max(5),
    confidence: z.number().finite().min(0).max(1),
    proposedActionId: ActionIdSchema,
    requiresHuman: z.boolean(),
  })
  .strict();

export type IncidentPhase = (typeof INCIDENT_ACTIVE_PHASES)[number];
export type IncidentTerminalState =
  (typeof INCIDENT_TERMINAL_STATES)[number];
export type IncidentState = (typeof INCIDENT_STATES)[number];
export type AgentRole = (typeof AGENT_ROLES)[number];
export type ActionId = (typeof ACTION_IDS)[number];
export type StepStatus = (typeof STEP_STATUSES)[number];
export type Diagnosis = z.infer<typeof DiagnosisSchema>;
