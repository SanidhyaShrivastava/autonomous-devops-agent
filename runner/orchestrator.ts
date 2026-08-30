import { createHash } from "node:crypto";

import {
  DEMO_ACTION_ID,
  DEMO_HEALTHY_STATUS,
  DEMO_RUNNER_ID,
  DEMO_SERVICE_IDENTITY,
  DEMO_WORKLOAD_ID,
  DiagnosisSchema,
  NO_ACTION_ID,
  type ActionId,
  type AgentRole,
  type IncidentState,
  type IncidentTerminalState,
  type StepStatus,
} from "../src/lib/contracts";
import {
  evaluateRecoveryPolicy,
  type RecoveryPolicyDecision,
} from "../src/lib/policy";
import { sanitizePublicOutput } from "../src/lib/sanitize";
import type {
  HealthEvidence,
  RecoveryActionResult,
  SafeContainerState,
  SafeLogTail,
} from "./docker-adapter";
import type {
  CodexInvestigator,
  InvestigationEvidence,
  InvestigationResult,
} from "./codex-investigator";

const DEFAULT_LEASE_RENEWAL_INTERVAL_MS = 10_000;
const PUBLIC_STEP_OUTPUT_LIMIT = 4_000;

class RecoveryRunCancelledError extends Error {}

export type DemoCommandStatus =
  | "queued"
  | "claimed"
  | "reset_applied"
  | "failure_confirmed"
  | "complete"
  | "expired"
  | "failed";

export type RecoveryCommandStatus =
  | "proposed"
  | "allowed"
  | "executing"
  | "executed"
  | "blocked"
  | "failed";

export interface RecoveryExecutionEvidence {
  readonly commandLabel: "docker start fixed demo service";
  readonly exitCode: 0;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly latencyMs: number;
}

export interface IncidentSnapshot {
  readonly id: string;
  readonly currentPhase: IncidentState;
  readonly stateVersion: number;
  readonly incidentCategory: string | null;
  readonly diagnosisEvidence: readonly string[] | null;
  readonly diagnosisSummary: string | null;
  readonly confidence: number | null;
  readonly requiresHuman: boolean | null;
  readonly proposedActionId: ActionId | null;
}

export interface RecoverySnapshot {
  readonly id: string;
  readonly actionId: typeof DEMO_ACTION_ID;
  readonly status: RecoveryCommandStatus;
  readonly stateVersion: number;
  readonly executionNonce: string;
  readonly completedAt: number | null;
  readonly executionEvidence: RecoveryExecutionEvidence | null;
}

export interface RecoveryCommandSnapshot {
  readonly id: string;
  readonly kind: "RESET_DEMO_V1";
  readonly status: DemoCommandStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly leaseExpiresAt: number | null;
  readonly stateVersion: number;
  readonly incident: IncidentSnapshot | null;
  readonly recovery: RecoverySnapshot | null;
  readonly stepNonces: readonly string[];
}

export interface ClaimDemoCommandInput {
  readonly demoCommandId: string;
  readonly expectedStateVersion: number;
  readonly claimNonce: string;
}

export interface VersionedCommandInput {
  readonly demoCommandId: string;
  readonly expectedStateVersion: number;
}

export interface FailDemoCommandInput extends VersionedCommandInput {
  readonly terminalReason: string;
}

export interface CreateIncidentInput {
  readonly demoCommandId: string;
  readonly expectedCommandStateVersion: number;
  readonly initialHealth: "failed";
}

export interface RunnerStepInput {
  readonly demoCommandId: string;
  readonly incidentId?: string;
  readonly expectedCommandStateVersion: number;
  readonly expectedIncidentStateVersion?: number;
  readonly stepNonce: string;
  readonly role: AgentRole;
  readonly kind: string;
  readonly status: StepStatus;
  readonly safeCommandLabel?: string;
  readonly sanitizedOutput?: string;
  readonly errorSummary?: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly latencyMs?: number;
  readonly reportedInputTokens?: number;
  readonly reportedOutputTokens?: number;
  readonly costStatus?:
    | "not_reported"
    | "reported"
    | "unavailable_chatgpt_subscription";
}

export interface UpdateIncidentPhaseInput {
  readonly demoCommandId: string;
  readonly incidentId: string;
  readonly expectedPhase: IncidentState;
  readonly nextPhase: IncidentState;
  readonly expectedStateVersion: number;
  readonly expectedCommandStateVersion: number;
  readonly recoveryCommandId?: string;
  readonly expectedRecoveryStateVersion?: number;
  readonly executionNonce?: string;
  readonly executionEvidence?: RecoveryExecutionEvidence;
  readonly incidentCategory?: string;
  readonly diagnosisEvidence?: readonly string[];
  readonly diagnosisSummary?: string;
  readonly confidence?: number;
  readonly requiresHuman?: boolean;
  readonly proposedActionId?: ActionId;
  readonly reportedInputTokens?: number;
  readonly reportedOutputTokens?: number;
  readonly costStatus?:
    | "not_reported"
    | "reported"
    | "unavailable_chatgpt_subscription";
}

export interface CreateRecoveryCommandInput {
  readonly demoCommandId: string;
  readonly incidentId: string;
  readonly expectedCommandStateVersion: number;
  readonly expectedIncidentPhase: "policy_check";
  readonly expectedIncidentStateVersion: number;
  readonly actionId: typeof DEMO_ACTION_ID;
  readonly executionNonce: string;
}

export interface CompleteIncidentInput {
  readonly demoCommandId: string;
  readonly incidentId: string;
  readonly recoveryCommandId?: string;
  readonly executionNonce?: string;
  readonly expectedPhase: IncidentState;
  readonly expectedIncidentStateVersion: number;
  readonly expectedCommandStateVersion: number;
  readonly expectedRecoveryStateVersion?: number;
  readonly terminalState: IncidentTerminalState;
  readonly finalHealth: string;
  readonly terminalReason?: string;
  readonly verification?: {
    readonly service: string;
    readonly status: string;
    readonly httpStatus: number;
    readonly requestStartedAt: number;
    readonly checkedAt: number;
  };
}

export interface RecoveryStatePort {
  claimDemoCommand(input: ClaimDemoCommandInput): Promise<
    | {
        readonly status: "claimed";
        readonly stateVersion: number;
        readonly leaseExpiresAt?: number;
      }
    | { readonly status: "expired"; readonly code: "COMMAND_EXPIRED" }
  >;
  renewLease(input: VersionedCommandInput): Promise<{
    readonly stateVersion: number;
    readonly leaseExpiresAt?: number;
  }>;
  failDemoCommand(input: FailDemoCommandInput): Promise<{
    readonly status: "failed";
    readonly stateVersion: number;
  }>;
  markResetApplied(input: VersionedCommandInput): Promise<{
    readonly stateVersion: number;
    readonly leaseExpiresAt?: number;
  }>;
  markFailureConfirmed(input: VersionedCommandInput): Promise<{
    readonly stateVersion: number;
    readonly leaseExpiresAt?: number;
  }>;
  createIncident(input: CreateIncidentInput): Promise<{
    readonly incidentId: string;
    readonly stateVersion: number;
  }>;
  appendStep(input: RunnerStepInput): Promise<{
    readonly stepId: string;
    readonly sequence: number;
  }>;
  updateIncidentPhase(input: UpdateIncidentPhaseInput): Promise<{
    readonly stateVersion: number;
    readonly recoveryStateVersion?: number;
    readonly recoveryCompletedAt?: number;
    readonly leaseExpiresAt?: number;
  }>;
  createRecoveryCommand(input: CreateRecoveryCommandInput): Promise<{
    readonly recoveryCommandId: string;
    readonly stateVersion: number;
  }>;
  completeIncident(input: CompleteIncidentInput): Promise<{
    readonly stateVersion: number;
    readonly terminalState: IncidentTerminalState;
  }>;
}

export interface DemoWorkloadPort {
  inspectSafeState(): Promise<SafeContainerState>;
  stopDemoService(): Promise<void>;
  checkHealthOnce(signal?: AbortSignal): Promise<HealthEvidence>;
  readSafeLogTail(): Promise<SafeLogTail>;
  executeRecoveryAction(input: {
    readonly actionId: typeof DEMO_ACTION_ID;
    readonly workloadId: typeof DEMO_WORKLOAD_ID;
    readonly executionId: string;
  }): Promise<RecoveryActionResult>;
  verifyFreshHealth(
    notBefore: number,
    signal?: AbortSignal,
  ): Promise<HealthEvidence>;
}

export type PolicyEvaluator = (input: unknown) => RecoveryPolicyDecision;

export interface RecoveryOrchestratorDependencies {
  readonly state: RecoveryStatePort;
  readonly workload: DemoWorkloadPort;
  readonly investigator: CodexInvestigator;
  readonly evaluatePolicy?: PolicyEvaluator;
  readonly now?: () => number;
  readonly leaseRenewalIntervalMs?: number;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
}

export interface RecoveryActivityObserver {
  onCriticalMutationStart(): void;
  onCriticalMutationEnd(): void;
}

export type OrchestrationResult =
  | {
      readonly status:
        | "resolved"
        | "needs_human"
        | "failed_recovery"
        | "investigation_failed";
      readonly demoCommandId: string;
      readonly incidentId: string;
    }
  | {
      readonly status: "command_failed" | "state_conflict" | "ignored";
      readonly demoCommandId: string;
      readonly incidentId?: string;
    };

export interface RecoveryOrchestrator {
  run(
    command: RecoveryCommandSnapshot,
    signal?: AbortSignal,
    activity?: RecoveryActivityObserver,
  ): Promise<OrchestrationResult>;
}

function boundedIdentifier(prefix: string, value: string) {
  const safeValue = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return `${prefix}_${safeValue}`.slice(0, 128);
}

function safeJson(value: unknown) {
  const encoded = JSON.stringify(value);
  return sanitizePublicOutput(
    encoded ?? "Unable to encode safe output.",
    PUBLIC_STEP_OUTPUT_LIMIT,
  ).text;
}

function safeLatency(startedAt: number, finishedAt: number) {
  return Math.max(0, Math.floor(finishedAt - startedAt));
}

type VerifiedHealthEvidence = HealthEvidence & {
  readonly healthy: true;
  readonly httpStatus: 200;
  readonly service: typeof DEMO_SERVICE_IDENTITY;
  readonly status: typeof DEMO_HEALTHY_STATUS;
};

function isVerifiedHealthy(
  evidence: HealthEvidence,
): evidence is VerifiedHealthEvidence {
  return (
    evidence.healthy &&
    evidence.httpStatus === 200 &&
    evidence.service === DEMO_SERVICE_IDENTITY &&
    evidence.status === DEMO_HEALTHY_STATUS &&
    evidence.checkedAt >= evidence.requestStartedAt
  );
}

function isActiveCommandStatus(status: DemoCommandStatus) {
  return (
    status === "queued" ||
    status === "claimed" ||
    status === "reset_applied" ||
    status === "failure_confirmed"
  );
}

function validSnapshot(command: RecoveryCommandSnapshot) {
  return (
    command.kind === "RESET_DEMO_V1" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(command.id) &&
    Number.isSafeInteger(command.stateVersion) &&
    command.stateVersion >= 0 &&
    (command.leaseExpiresAt === null ||
      (Number.isFinite(command.leaseExpiresAt) &&
        command.leaseExpiresAt >= 0)) &&
    Array.isArray(command.stepNonces)
  );
}

export function createRecoveryOrchestrator(
  dependencies: RecoveryOrchestratorDependencies,
): RecoveryOrchestrator {
  const { state, workload, investigator } = dependencies;
  const policy = dependencies.evaluatePolicy ?? evaluateRecoveryPolicy;
  const now = dependencies.now ?? Date.now;
  const scheduleInterval = dependencies.setInterval ?? globalThis.setInterval;
  const cancelInterval = dependencies.clearInterval ?? globalThis.clearInterval;
  const leaseRenewalIntervalMs =
    dependencies.leaseRenewalIntervalMs ??
    DEFAULT_LEASE_RENEWAL_INTERVAL_MS;

  return {
    async run(command, signal, activity): Promise<OrchestrationResult> {
      if (!validSnapshot(command) || !isActiveCommandStatus(command.status)) {
        return { status: "ignored", demoCommandId: command.id };
      }

      let commandStatus = command.status;
      let commandStateVersion = command.stateVersion;
      let incident = command.incident ? { ...command.incident } : null;
      let recovery = command.recovery ? { ...command.recovery } : null;
      const persistedStepNonces = new Set(command.stepNonces);
      let failedHealth: HealthEvidence | null = null;
      let leaseTimer: ReturnType<typeof setInterval> | null = null;
      let leaseFailure: unknown = null;
      let leaseRenewal: Promise<void> | null = null;

      const requireNotCancelled = () => {
        if (signal?.aborted) {
          throw new RecoveryRunCancelledError("Recovery run cancelled");
        }
      };

      const hasPersistedStepKind = (kind: string) =>
        Array.from(persistedStepNonces).some((nonce) =>
          nonce.startsWith(`step_${kind}_`),
        );

      const appendStep = async (
        stage: string,
        input: Omit<
          RunnerStepInput,
          | "demoCommandId"
          | "incidentId"
          | "expectedCommandStateVersion"
          | "expectedIncidentStateVersion"
          | "stepNonce"
        >,
      ) => {
        const logicalStep = {
          role: input.role,
          kind: input.kind,
          status: input.status,
          safeCommandLabel: input.safeCommandLabel,
          sanitizedOutput: input.sanitizedOutput,
          errorSummary: input.errorSummary,
          reportedInputTokens: input.reportedInputTokens,
          reportedOutputTokens: input.reportedOutputTokens,
          costStatus: input.costStatus,
        };
        const replayHash = createHash("sha256")
          .update(JSON.stringify(logicalStep))
          .digest("hex")
          .slice(0, 16);
        const stepNonce = boundedIdentifier(
          `step_${stage}_${replayHash}`,
          command.id,
        );
        if (persistedStepNonces.has(stepNonce)) {
          return;
        }
        await state.appendStep({
          demoCommandId: command.id,
          incidentId: incident?.id,
          expectedCommandStateVersion: commandStateVersion,
          expectedIncidentStateVersion: incident?.stateVersion,
          stepNonce,
          ...input,
        });
        persistedStepNonces.add(stepNonce);
      };

      const renewLease = () => {
        if (leaseRenewal || leaseFailure) {
          return;
        }
        const expectedStateVersion = commandStateVersion;
        leaseRenewal = state
          .renewLease({
            demoCommandId: command.id,
            expectedStateVersion,
          })
          .then((result) => {
            if (result.stateVersion !== expectedStateVersion) {
              throw new Error("Lease renewed a different command version");
            }
          })
          .catch((error: unknown) => {
            leaseFailure = error;
          })
          .finally(() => {
            leaseRenewal = null;
          });
      };

      const startLeaseRenewal = () => {
        if (leaseTimer || leaseRenewalIntervalMs <= 0) {
          return;
        }
        leaseTimer = scheduleInterval(renewLease, leaseRenewalIntervalMs);
      };

      const requireHealthyLease = async () => {
        if (leaseRenewal) {
          await leaseRenewal;
        }
        if (leaseFailure) {
          throw new Error("Command lease renewal failed");
        }
      };

      const stopLeaseRenewal = async () => {
        if (leaseTimer) {
          cancelInterval(leaseTimer);
          leaseTimer = null;
        }
        if (leaseRenewal) {
          await leaseRenewal;
        }
      };

      const complete = async (
        terminalState: IncidentTerminalState,
        terminalReason: string,
        finalHealth: "failed" | typeof DEMO_HEALTHY_STATUS,
        verification?: CompleteIncidentInput["verification"],
      ): Promise<OrchestrationResult> => {
        if (!incident) {
          throw new Error("Cannot complete a missing incident");
        }
        await requireHealthyLease();
        await state.completeIncident({
          demoCommandId: command.id,
          incidentId: incident.id,
          recoveryCommandId: recovery?.id,
          executionNonce: recovery?.executionNonce,
          expectedPhase: incident.currentPhase,
          expectedIncidentStateVersion: incident.stateVersion,
          expectedCommandStateVersion: commandStateVersion,
          expectedRecoveryStateVersion: recovery?.stateVersion,
          terminalState,
          finalHealth,
          terminalReason,
          verification,
        });
        return {
          status: terminalState,
          demoCommandId: command.id,
          incidentId: incident.id,
        };
      };

      const failPreIncident = async (terminalReason: string) => {
        await state.failDemoCommand({
          demoCommandId: command.id,
          expectedStateVersion: commandStateVersion,
          terminalReason,
        });
        return {
          status: "command_failed" as const,
          demoCommandId: command.id,
        };
      };

      try {
        if (commandStatus !== "queued") {
          const renewed = await state.renewLease({
            demoCommandId: command.id,
            expectedStateVersion: commandStateVersion,
          });
          if (renewed.stateVersion !== commandStateVersion) {
            throw new Error("Lease renewed a different command version");
          }
        }

        if (commandStatus === "queued") {
          const claimed = await state.claimDemoCommand({
            demoCommandId: command.id,
            expectedStateVersion: commandStateVersion,
            claimNonce: boundedIdentifier("claim", command.id),
          });
          if (claimed.status === "expired") {
            return { status: "command_failed", demoCommandId: command.id };
          }
          commandStatus = "claimed";
          commandStateVersion = claimed.stateVersion;
        }

        if (commandStatus === "claimed") {
          const resetStartedAt = now();
          let resetMutationActive = false;
          try {
            requireNotCancelled();
            const stateBeforeReset = await workload.inspectSafeState();
            requireNotCancelled();
            let stoppedByThisRun = false;
            if (stateBeforeReset.status === "running") {
              requireNotCancelled();
              activity?.onCriticalMutationStart();
              resetMutationActive = true;
              try {
                await workload.stopDemoService();
              } finally {
                resetMutationActive = false;
                activity?.onCriticalMutationEnd();
              }
              stoppedByThisRun = true;
            } else if (stateBeforeReset.status !== "exited") {
              return await failPreIncident(
                "disposable_service_not_in_resettable_state",
              );
            }
            const resetApplied = await state.markResetApplied({
              demoCommandId: command.id,
              expectedStateVersion: commandStateVersion,
            });
            commandStateVersion = resetApplied.stateVersion;
            commandStatus = "reset_applied";
            const resetFinishedAt = now();
            await appendStep("reset_applied", {
              role: "incident_manager",
              kind: "reset_applied",
              status: "succeeded",
              safeCommandLabel: stoppedByThisRun
                ? "docker stop fixed demo service"
                : undefined,
              sanitizedOutput: safeJson({
                validatedDemoLabel: stateBeforeReset.demoLabel,
                stateBeforeReset: stateBeforeReset.status,
                stoppedByThisRun,
                resetApplied: true,
              }),
              startedAt: resetStartedAt,
              finishedAt: resetFinishedAt,
              latencyMs: safeLatency(resetStartedAt, resetFinishedAt),
              costStatus: "not_reported",
            });
          } catch (error) {
            if (
              signal?.aborted ||
              error instanceof RecoveryRunCancelledError
            ) {
              throw error;
            }
            return await failPreIncident("failed_to_seed_disposable_service");
          } finally {
            if (resetMutationActive) {
              activity?.onCriticalMutationEnd();
            }
          }
        }

        if (commandStatus === "reset_applied") {
          if (!hasPersistedStepKind("reset_applied")) {
            const reconstructedAt = now();
            const currentSafeState = await workload.inspectSafeState();
            const reconstructionFinishedAt = now();
            await appendStep("reset_applied", {
              role: "incident_manager",
              kind: "reset_applied",
              status: "succeeded",
              sanitizedOutput: safeJson({
                resetApplied: true,
                restoredFromAuthoritativeCommandState: true,
                currentSafeState,
              }),
              startedAt: reconstructedAt,
              finishedAt: reconstructionFinishedAt,
              latencyMs: safeLatency(
                reconstructedAt,
                reconstructionFinishedAt,
              ),
              costStatus: "not_reported",
            });
          }
          failedHealth = await workload.checkHealthOnce();
          if (failedHealth.healthy) {
            return await failPreIncident(
              "reset_did_not_produce_failed_health",
            );
          }
          const failureConfirmed = await state.markFailureConfirmed({
            demoCommandId: command.id,
            expectedStateVersion: commandStateVersion,
          });
          commandStateVersion = failureConfirmed.stateVersion;
          commandStatus = "failure_confirmed";
          await appendStep("failure_confirmed", {
            role: "incident_manager",
            kind: "failure_confirmed",
            status: "succeeded",
            safeCommandLabel: "HTTP GET fixed demo health",
            sanitizedOutput: safeJson(failedHealth),
            startedAt: failedHealth.requestStartedAt,
            finishedAt: failedHealth.checkedAt,
            latencyMs: safeLatency(
              failedHealth.requestStartedAt,
              failedHealth.checkedAt,
            ),
            costStatus: "not_reported",
          });
        }

        if (commandStatus !== "failure_confirmed") {
          return { status: "ignored", demoCommandId: command.id };
        }

        if (!hasPersistedStepKind("failure_confirmed")) {
          failedHealth = await workload.checkHealthOnce();
          await appendStep("failure_confirmed", {
            role: "incident_manager",
            kind: "failure_confirmed",
            status: "succeeded",
            safeCommandLabel: "HTTP GET fixed demo health",
            sanitizedOutput: safeJson({
              restoredFromAuthoritativeCommandState: true,
              currentHealth: failedHealth,
            }),
            startedAt: failedHealth.requestStartedAt,
            finishedAt: failedHealth.checkedAt,
            latencyMs: safeLatency(
              failedHealth.requestStartedAt,
              failedHealth.checkedAt,
            ),
            costStatus: "not_reported",
          });
        }

        startLeaseRenewal();
        if (!incident) {
          if (recovery) {
            throw new Error("Recovery exists without an incident");
          }
          const created = await state.createIncident({
            demoCommandId: command.id,
            expectedCommandStateVersion: commandStateVersion,
            initialHealth: "failed",
          });
          incident = {
            id: created.incidentId,
            currentPhase: "failed_detected",
            stateVersion: created.stateVersion,
            incidentCategory: null,
            diagnosisEvidence: null,
            diagnosisSummary: null,
            confidence: null,
            requiresHuman: null,
            proposedActionId: null,
          };
        }

        if (incident.currentPhase === "executing") {
          if (!recovery) {
            throw new Error("Executing incident has no recovery command");
          }
          return await complete(
            "failed_recovery",
            "execution_state_ambiguous_after_restart",
            "failed",
          );
        }

        if (incident.currentPhase === "failed_detected") {
          const investigating = await state.updateIncidentPhase({
            demoCommandId: command.id,
            incidentId: incident.id,
            expectedPhase: "failed_detected",
            nextPhase: "investigating",
            expectedStateVersion: incident.stateVersion,
            expectedCommandStateVersion: commandStateVersion,
          });
          incident.currentPhase = "investigating";
          incident.stateVersion = investigating.stateVersion;
        }

        if (incident.currentPhase === "investigating") {
          if (!failedHealth) {
            failedHealth = await workload.checkHealthOnce();
            if (failedHealth.healthy) {
              return await complete(
                "needs_human",
                "service_state_changed_before_investigation",
                DEMO_HEALTHY_STATUS,
              );
            }
          }

          let safeState: SafeContainerState;
          let safeLogs: SafeLogTail;
          try {
            const inspectStartedAt = now();
            safeState = await workload.inspectSafeState();
            const inspectFinishedAt = now();
            await appendStep("safe_state_collected", {
              role: "investigator",
              kind: "safe_state_collected",
              status: "succeeded",
              safeCommandLabel: "docker inspect fixed demo service",
              sanitizedOutput: safeJson(safeState),
              startedAt: inspectStartedAt,
              finishedAt: inspectFinishedAt,
              latencyMs: safeLatency(inspectStartedAt, inspectFinishedAt),
              costStatus: "not_reported",
            });

            const logsStartedAt = now();
            safeLogs = await workload.readSafeLogTail();
            const logsFinishedAt = now();
            await appendStep("safe_logs_collected", {
              role: "investigator",
              kind: "safe_logs_collected",
              status: "succeeded",
              safeCommandLabel: "docker logs --tail 30 fixed demo service",
              sanitizedOutput: safeJson(safeLogs),
              startedAt: logsStartedAt,
              finishedAt: logsFinishedAt,
              latencyMs: safeLatency(logsStartedAt, logsFinishedAt),
              costStatus: "not_reported",
            });
          } catch {
            const failedAt = now();
            await appendStep("evidence_collection_failed", {
              role: "investigator",
              kind: "evidence_collection_failed",
              status: "failed",
              errorSummary: "The bounded evidence collection did not complete.",
              startedAt: failedAt,
              finishedAt: failedAt,
              latencyMs: 0,
              costStatus: "not_reported",
            });
            return await complete(
              "investigation_failed",
              "evidence_collection_failed",
              "failed",
            );
          }

          const evidence: InvestigationEvidence = {
            workloadId: DEMO_WORKLOAD_ID,
            failedHealth,
            safeState,
            safeLogs,
          };
          const investigation: InvestigationResult =
            await investigator.investigate(evidence, signal);
          requireNotCancelled();
          await requireHealthyLease();
          if (investigation.status !== "succeeded") {
            await appendStep("diagnosis_failed", {
              role: "investigator",
              kind: "diagnosis_failed",
              status: "failed",
              safeCommandLabel: "local codex schema-bound diagnosis",
              errorSummary: "The bounded investigation did not complete.",
              startedAt: investigation.startedAt,
              finishedAt: investigation.finishedAt,
              latencyMs: investigation.latencyMs,
              costStatus: investigation.costStatus,
            });
            return await complete(
              "investigation_failed",
              `codex_${investigation.failureReason}`,
              "failed",
            );
          }

          const diagnosis = DiagnosisSchema.safeParse(
            investigation.diagnosis,
          );
          if (!diagnosis.success) {
            await appendStep("diagnosis_failed", {
              role: "investigator",
              kind: "diagnosis_failed",
              status: "failed",
              safeCommandLabel: "local codex schema-bound diagnosis",
              errorSummary: "The investigation returned an invalid diagnosis.",
              startedAt: investigation.startedAt,
              finishedAt: investigation.finishedAt,
              latencyMs: investigation.latencyMs,
              costStatus: investigation.costStatus,
            });
            return await complete(
              "investigation_failed",
              "invalid_diagnosis",
              "failed",
            );
          }

          const decision = diagnosis.data;
          await appendStep("diagnosis_completed", {
            role: "investigator",
            kind: "diagnosis_completed",
            status: "succeeded",
            safeCommandLabel: "local codex schema-bound diagnosis",
            sanitizedOutput: safeJson(decision),
            startedAt: investigation.startedAt,
            finishedAt: investigation.finishedAt,
            latencyMs: investigation.latencyMs,
            reportedInputTokens: investigation.usage.inputTokens,
            reportedOutputTokens: investigation.usage.outputTokens,
            costStatus: investigation.costStatus,
          });

          const selectedActionId: ActionId =
            decision.requiresHuman ||
            decision.proposedActionId === NO_ACTION_ID
              ? NO_ACTION_ID
              : DEMO_ACTION_ID;
          const managerReview = await state.updateIncidentPhase({
            demoCommandId: command.id,
            incidentId: incident.id,
            expectedPhase: "investigating",
            nextPhase: "manager_review",
            expectedStateVersion: incident.stateVersion,
            expectedCommandStateVersion: commandStateVersion,
            incidentCategory: decision.incidentCategory,
            diagnosisEvidence: decision.evidence,
            diagnosisSummary: decision.summary,
            confidence: decision.confidence,
            requiresHuman: decision.requiresHuman,
            proposedActionId: selectedActionId,
            reportedInputTokens: investigation.usage.inputTokens,
            reportedOutputTokens: investigation.usage.outputTokens,
            costStatus: investigation.costStatus,
          });
          incident = {
            ...incident,
            currentPhase: "manager_review",
            stateVersion: managerReview.stateVersion,
            incidentCategory: decision.incidentCategory,
            diagnosisEvidence: decision.evidence,
            diagnosisSummary: decision.summary,
            confidence: decision.confidence,
            requiresHuman: decision.requiresHuman,
            proposedActionId: selectedActionId,
          };
        }

        if (
          !incident.incidentCategory ||
          !incident.diagnosisEvidence?.length ||
          !incident.diagnosisSummary ||
          incident.confidence === null ||
          incident.requiresHuman === null ||
          !incident.proposedActionId
        ) {
          if (
            incident.currentPhase === "manager_review" ||
            incident.currentPhase === "policy_check"
          ) {
            return await complete(
              "needs_human",
              "persisted_diagnosis_incomplete",
              "failed",
            );
          }
          throw new Error("Incident diagnosis is incomplete");
        }

        if (incident.currentPhase === "manager_review") {
          const managerStartedAt = now();
          const managerFinishedAt = now();
          await appendStep("manager_evidence_review", {
            role: "incident_manager",
            kind: "manager_evidence_review",
            status: "succeeded",
            sanitizedOutput: safeJson({
              incidentCategory: incident.incidentCategory,
              evidenceReviewed: incident.diagnosisEvidence,
              diagnosisSummary: incident.diagnosisSummary,
              confidence: incident.confidence,
              selectedActionId: incident.proposedActionId,
              requiresHuman: incident.requiresHuman,
            }),
            startedAt: managerStartedAt,
            finishedAt: managerFinishedAt,
            latencyMs: safeLatency(managerStartedAt, managerFinishedAt),
            costStatus: "not_reported",
          });
          const policyCheck = await state.updateIncidentPhase({
            demoCommandId: command.id,
            incidentId: incident.id,
            expectedPhase: "manager_review",
            nextPhase: "policy_check",
            expectedStateVersion: incident.stateVersion,
            expectedCommandStateVersion: commandStateVersion,
          });
          incident.currentPhase = "policy_check";
          incident.stateVersion = policyCheck.stateVersion;
        }

        if (incident.currentPhase === "policy_check") {
          const executionNonce =
            recovery?.executionNonce ??
            boundedIdentifier("execution", command.id);
          const policyStartedAt = now();
          const policyDecision = policy({
            incidentId: incident.id,
            activeIncidentId: incident.id,
            incidentState: incident.currentPhase,
            workloadId: DEMO_WORKLOAD_ID,
            actionId: incident.proposedActionId,
            confidence: incident.confidence,
            runnerId: DEMO_RUNNER_ID,
            executionId: executionNonce,
            previousExecutionIds:
              recovery && recovery.status !== "allowed"
                ? [recovery.executionNonce]
                : [],
          });
          const policyFinishedAt = now();
          await appendStep("policy_decision", {
            role: "policy_gate",
            kind: "policy_decision",
            status: policyDecision.allowed ? "succeeded" : "blocked",
            sanitizedOutput: safeJson(policyDecision),
            startedAt: policyStartedAt,
            finishedAt: policyFinishedAt,
            latencyMs: safeLatency(policyStartedAt, policyFinishedAt),
            costStatus: "not_reported",
          });
          if (!policyDecision.allowed || incident.requiresHuman) {
            return await complete(
              "needs_human",
              policyDecision.allowed
                ? "human_approval_required"
                : `policy_${policyDecision.reason}`,
              "failed",
            );
          }

          if (!recovery) {
            const createdRecovery = await state.createRecoveryCommand({
              demoCommandId: command.id,
              incidentId: incident.id,
              expectedCommandStateVersion: commandStateVersion,
              expectedIncidentPhase: "policy_check",
              expectedIncidentStateVersion: incident.stateVersion,
              actionId: DEMO_ACTION_ID,
              executionNonce,
            });
            recovery = {
              id: createdRecovery.recoveryCommandId,
              actionId: DEMO_ACTION_ID,
              status: "allowed",
              stateVersion: createdRecovery.stateVersion,
              executionNonce,
              completedAt: null,
              executionEvidence: null,
            };
          } else if (recovery.status !== "allowed") {
            return await complete(
              "needs_human",
              "recovery_command_not_safe_to_resume",
              "failed",
            );
          }

          const executing = await state.updateIncidentPhase({
            demoCommandId: command.id,
            incidentId: incident.id,
            expectedPhase: "policy_check",
            nextPhase: "executing",
            expectedStateVersion: incident.stateVersion,
            expectedCommandStateVersion: commandStateVersion,
            recoveryCommandId: recovery.id,
            expectedRecoveryStateVersion: recovery.stateVersion,
            executionNonce: recovery.executionNonce,
          });
          incident.currentPhase = "executing";
          incident.stateVersion = executing.stateVersion;
          recovery.status = "executing";
          recovery.stateVersion =
            executing.recoveryStateVersion ?? recovery.stateVersion + 1;

          let actionResult: RecoveryActionResult | null = null;
          let recoveryMutationActive = false;
          try {
            await requireHealthyLease();
            requireNotCancelled();
            activity?.onCriticalMutationStart();
            recoveryMutationActive = true;
            try {
              actionResult = await workload.executeRecoveryAction({
                actionId: DEMO_ACTION_ID,
                workloadId: DEMO_WORKLOAD_ID,
                executionId: recovery.executionNonce,
              });
            } catch {
              actionResult = null;
            } finally {
              recoveryMutationActive = false;
              activity?.onCriticalMutationEnd();
            }

            if (!actionResult) {
              const failedAt = now();
              await appendStep("recovery_failed", {
                role: "executor",
                kind: "recovery_failed",
                status: "failed",
                safeCommandLabel: "docker start fixed demo service",
                errorSummary: "The fixed recovery action failed.",
                startedAt: failedAt,
                finishedAt: failedAt,
                latencyMs: 0,
                costStatus: "not_reported",
              });
              return await complete(
                "failed_recovery",
                "fixed_restart_failed",
                "failed",
              );
            }

            const verifying = await state.updateIncidentPhase({
              demoCommandId: command.id,
              incidentId: incident.id,
              expectedPhase: "executing",
              nextPhase: "verifying",
              expectedStateVersion: incident.stateVersion,
              expectedCommandStateVersion: commandStateVersion,
              recoveryCommandId: recovery.id,
              expectedRecoveryStateVersion: recovery.stateVersion,
              executionNonce: recovery.executionNonce,
              executionEvidence: {
                commandLabel: actionResult.commandLabel,
                exitCode: actionResult.exitCode,
                startedAt: actionResult.startedAt,
                finishedAt: actionResult.finishedAt,
                latencyMs: actionResult.durationMs,
              },
            });
            incident.currentPhase = "verifying";
            incident.stateVersion = verifying.stateVersion;
            recovery.status = "executed";
            recovery.stateVersion =
              verifying.recoveryStateVersion ?? recovery.stateVersion + 1;
            recovery.completedAt = verifying.recoveryCompletedAt ?? null;
            recovery.executionEvidence = {
              commandLabel: actionResult.commandLabel,
              exitCode: actionResult.exitCode,
              startedAt: actionResult.startedAt,
              finishedAt: actionResult.finishedAt,
              latencyMs: actionResult.durationMs,
            };

            await appendStep("recovery_executed", {
              role: "executor",
              kind: "recovery_executed",
              status: "succeeded",
              safeCommandLabel: actionResult.commandLabel,
              sanitizedOutput: safeJson({
                actionId: actionResult.actionId,
                exitCode: actionResult.exitCode,
              }),
              startedAt: actionResult.startedAt,
              finishedAt: actionResult.finishedAt,
              latencyMs: actionResult.durationMs,
              costStatus: "not_reported",
            });
          } finally {
            if (recoveryMutationActive) {
              activity?.onCriticalMutationEnd();
            }
          }
        }

        if (incident.currentPhase === "verifying") {
          if (
            !recovery ||
            recovery.status !== "executed" ||
            !recovery.executionEvidence
          ) {
            throw new Error("Verifying incident has no executed recovery");
          }
          if (!hasPersistedStepKind("recovery_executed")) {
            await appendStep("recovery_executed", {
              role: "executor",
              kind: "recovery_executed",
              status: "succeeded",
              safeCommandLabel: recovery.executionEvidence.commandLabel,
              sanitizedOutput: safeJson({
                actionId: recovery.actionId,
                exitCode: recovery.executionEvidence.exitCode,
                restoredFromDurableExecutionRecord: true,
              }),
              startedAt: recovery.executionEvidence.startedAt,
              finishedAt: recovery.executionEvidence.finishedAt,
              latencyMs: recovery.executionEvidence.latencyMs,
              costStatus: "not_reported",
            });
          }
          await requireHealthyLease();
          requireNotCancelled();
          const verificationNotBefore = recovery.completedAt ?? now();
          const verification = await workload.verifyFreshHealth(
            verificationNotBefore,
            signal,
          );
          requireNotCancelled();
          await appendStep("verification_completed", {
            role: "verifier",
            kind: "verification_completed",
            status: verification.healthy ? "succeeded" : "failed",
            safeCommandLabel: "HTTP GET fixed demo health",
            sanitizedOutput: safeJson(verification),
            startedAt: verification.requestStartedAt,
            finishedAt: verification.checkedAt,
            latencyMs: safeLatency(
              verification.requestStartedAt,
              verification.checkedAt,
            ),
            costStatus: "not_reported",
          });

          if (!isVerifiedHealthy(verification)) {
            return await complete(
              "failed_recovery",
              "restart_did_not_recover_service",
              "failed",
            );
          }
          return await complete(
            "resolved",
            "verified_healthy_after_restart",
            DEMO_HEALTHY_STATUS,
            {
              service: verification.service,
              status: verification.status,
              httpStatus: verification.httpStatus,
              requestStartedAt: verification.requestStartedAt,
              checkedAt: verification.checkedAt,
            },
          );
        }

        return {
          status: "state_conflict",
          demoCommandId: command.id,
          incidentId: incident.id,
        };
      } catch {
        return {
          status: "state_conflict",
          demoCommandId: command.id,
          incidentId: incident?.id,
        };
      } finally {
        await stopLeaseRenewal();
      }
    },
  };
}
