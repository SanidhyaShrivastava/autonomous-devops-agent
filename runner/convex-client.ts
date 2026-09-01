import { ConvexClient, type ConnectionState } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { z } from "zod";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  DEMO_RUNNER_ID,
  IncidentStateSchema,
  type ActionId,
} from "../src/lib/contracts";
import type {
  CompleteIncidentInput,
  CreateIncidentInput,
  CreateRecoveryCommandInput,
  FailDemoCommandInput,
  RecoveryCommandSnapshot,
  RecoveryStatePort,
  RunnerStepInput,
  UpdateIncidentPhaseInput,
  VersionedCommandInput,
} from "./orchestrator";
import type {
  EnvironmentRecoveryClient,
  EnvironmentRecoveryRequest,
} from "./environment-restorer";
import {
  LEGACY_DOCKER_RECOVERY_LABEL,
  LINUX_AGENT_RECOVERY_LABEL,
  type RecoveryCommandLabel,
} from "./workload-types";

const DemoCommandStatusSchema = z.enum([
  "queued",
  "claimed",
  "reset_applied",
  "failure_confirmed",
  "complete",
  "expired",
  "failed",
]);

const RecoveryCommandStatusSchema = z.enum([
  "proposed",
  "allowed",
  "executing",
  "executed",
  "blocked",
  "failed",
]);

const RecoveryCommandLabelSchema = z.union([
  z.literal(LEGACY_DOCKER_RECOVERY_LABEL),
  z.literal(LINUX_AGENT_RECOVERY_LABEL),
]);

export function parseRecoveryLabel(value: unknown): RecoveryCommandLabel {
  return RecoveryCommandLabelSchema.parse(value);
}

const ActionIdSchema = z.enum(["restart_demo_service", "no_action"]);
const ExecutionModeSchema = z.enum(["autonomous", "approval_required"]);
const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
]);
const IdentifierSchema = z.string().min(1).max(128);

const EnvironmentRecoveryRequestSchema = z
  .object({
    incidentId: IdentifierSchema,
    stateVersion: z.number().int().nonnegative(),
  })
  .strict();

const HeartbeatResultSchema = z
  .object({
    runnerHeartbeatAt: z.number().finite().nonnegative(),
    environmentRecovery: EnvironmentRecoveryRequestSchema.nullable().optional(),
  })
  .strict();

const claimEnvironmentRecoveryMutation = makeFunctionReference<"mutation">(
  "runner:claimEnvironmentRecovery",
);
const completeEnvironmentRecoveryMutation = makeFunctionReference<"mutation">(
  "runner:completeEnvironmentRecovery",
);
const failEnvironmentRecoveryMutation = makeFunctionReference<"mutation">(
  "runner:failEnvironmentRecovery",
);

const ActiveDemoCommandSchema = z
  .object({
    _id: IdentifierSchema,
    kind: z.literal("RESET_DEMO_V1"),
    status: DemoCommandStatusSchema,
    createdAt: z.number().finite().nonnegative(),
    expiresAt: z.number().finite().nonnegative(),
    claimedAt: z.number().finite().nonnegative().nullable(),
    leaseExpiresAt: z.number().finite().nonnegative().nullable(),
    stateVersion: z.number().int().nonnegative(),
    executionMode: ExecutionModeSchema.optional(),
    incidentId: IdentifierSchema.nullable(),
    incident: z
      .object({
        _id: IdentifierSchema,
        currentPhase: IncidentStateSchema,
        stateVersion: z.number().int().nonnegative(),
        incidentCategory: z.string().nullable(),
        diagnosisEvidence: z.array(z.string().max(500)).max(5).nullable(),
        diagnosisSummary: z.string().nullable(),
        confidence: z.number().finite().min(0).max(1).nullable(),
        requiresHuman: z.boolean().nullable(),
        proposedActionId: ActionIdSchema.nullable(),
      })
      .strict()
      .nullable(),
    recovery: z
      .object({
        _id: IdentifierSchema,
        actionId: z.literal("restart_demo_service"),
        status: RecoveryCommandStatusSchema,
        stateVersion: z.number().int().nonnegative(),
        executionNonce: IdentifierSchema,
        completedAt: z.number().finite().nonnegative().nullable(),
        executionEvidence: z
          .object({
            commandLabel: RecoveryCommandLabelSchema,
            exitCode: z.literal(0),
            startedAt: z.number().finite().nonnegative(),
            finishedAt: z.number().finite().nonnegative(),
            latencyMs: z.number().int().nonnegative(),
          })
          .strict()
          .nullable(),
        approvalStatus: ApprovalStatusSchema.nullable().optional(),
        approvalRequestedAt: z.number().finite().nonnegative().nullable().optional(),
        approvalExpiresAt: z.number().finite().nonnegative().nullable().optional(),
        approvalDecidedAt: z.number().finite().nonnegative().nullable().optional(),
      })
      .strict()
      .nullable(),
    stepNonces: z.array(IdentifierSchema).max(100),
  })
  .strict()
  .superRefine((command, context) => {
    if ((command.incident === null) !== (command.incidentId === null)) {
      context.addIssue({
        code: "custom",
        message: "Incident identity and incident snapshot disagree",
      });
    }
    if (
      command.incident !== null &&
      command.incidentId !== command.incident._id
    ) {
      context.addIssue({
        code: "custom",
        message: "Incident identity does not match its snapshot",
      });
    }
    if (command.recovery !== null && command.incident === null) {
      context.addIssue({
        code: "custom",
        message: "Recovery snapshot is missing its incident",
      });
    }
  });

export interface ConvexRunnerClientOptions {
  readonly convexUrl: string;
  readonly runnerToken: string;
  readonly runnerId?: string;
  readonly client?: ConvexClient;
}

export interface HeartbeatResult {
  readonly runnerHeartbeatAt: number;
  readonly environmentRecovery?: EnvironmentRecoveryRequest;
}

export interface ConvexRunnerClient
  extends RecoveryStatePort, EnvironmentRecoveryClient {
  heartbeat(): Promise<HeartbeatResult>;
  getActiveCommand(): Promise<RecoveryCommandSnapshot | null>;
  subscribeToActiveCommand(
    onCommand: (command: RecoveryCommandSnapshot | null) => unknown,
    onError: (error: Error) => unknown,
  ): () => void;
  connectionState(): ConnectionState;
  subscribeToConnectionState(
    callback: (state: ConnectionState) => void,
  ): () => void;
  close(): Promise<void>;
}

export function normalizeConvexDeploymentUrl(rawUrl: string) {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl.trim());
  } catch {
    throw new Error("CONVEX_URL is not a valid URL");
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error("CONVEX_URL must use HTTP or HTTPS");
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error("CONVEX_URL must not contain credentials");
  }
  if (
    parsedUrl.pathname !== "/" ||
    parsedUrl.search !== "" ||
    parsedUrl.hash !== ""
  ) {
    throw new Error("CONVEX_URL must contain only a deployment origin");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    parsedUrl.protocol === "http:" &&
    !loopbackHosts.has(parsedUrl.hostname)
  ) {
    throw new Error("Remote CONVEX_URL connections must use HTTPS");
  }
  return parsedUrl.origin;
}

function requireConfiguration(options: ConvexRunnerClientOptions) {
  const convexUrl = normalizeConvexDeploymentUrl(options.convexUrl);
  if (!options.runnerToken.trim()) {
    throw new Error("RUNNER_TOKEN is required");
  }
  const runnerId = options.runnerId ?? DEMO_RUNNER_ID;
  if (runnerId !== DEMO_RUNNER_ID) {
    throw new Error("RUNNER_ID does not match the fixed demo runner");
  }
  return { convexUrl, runnerId };
}

function mapCommand(rawCommand: unknown): RecoveryCommandSnapshot | null {
  if (rawCommand === null) {
    return null;
  }
  const command = ActiveDemoCommandSchema.parse(rawCommand);
  return {
    id: command._id,
    kind: command.kind,
    status: command.status,
    createdAt: command.createdAt,
    expiresAt: command.expiresAt,
    leaseExpiresAt: command.leaseExpiresAt,
    stateVersion: command.stateVersion,
    executionMode: command.executionMode ?? "autonomous",
    incident: command.incident
      ? {
          id: command.incident._id,
          currentPhase: command.incident.currentPhase,
          stateVersion: command.incident.stateVersion,
          incidentCategory: command.incident.incidentCategory,
          diagnosisEvidence: command.incident.diagnosisEvidence,
          diagnosisSummary: command.incident.diagnosisSummary,
          confidence: command.incident.confidence,
          requiresHuman: command.incident.requiresHuman,
          proposedActionId: command.incident
            .proposedActionId as ActionId | null,
        }
      : null,
    recovery: command.recovery
      ? {
          id: command.recovery._id,
          actionId: command.recovery.actionId,
          status: command.recovery.status,
          stateVersion: command.recovery.stateVersion,
          executionNonce: command.recovery.executionNonce,
          completedAt: command.recovery.completedAt,
          executionEvidence: command.recovery.executionEvidence,
          approvalStatus: command.recovery.approvalStatus ?? null,
          approvalRequestedAt: command.recovery.approvalRequestedAt ?? null,
          approvalExpiresAt: command.recovery.approvalExpiresAt ?? null,
          approvalDecidedAt: command.recovery.approvalDecidedAt ?? null,
        }
      : null,
    stepNonces: command.stepNonces,
  };
}

function asError(error: unknown) {
  return error instanceof Error
    ? error
    : new Error("Convex runner subscription failed");
}

export function createConvexRunnerClient(
  options: ConvexRunnerClientOptions,
): ConvexRunnerClient {
  const configuration = requireConfiguration(options);
  const client =
    options.client ??
    new ConvexClient(configuration.convexUrl, {
      logger: false,
      unsavedChangesWarning: false,
    });
  const privateArgs = {
    runnerToken: options.runnerToken,
    runnerId: configuration.runnerId,
  };

  return {
    async heartbeat() {
      const rawResult = await client.mutation(
        api.runner.heartbeat,
        privateArgs,
      );
      const result = HeartbeatResultSchema.parse(rawResult);
      return {
        runnerHeartbeatAt: result.runnerHeartbeatAt,
        environmentRecovery: result.environmentRecovery ?? undefined,
      };
    },

    async claimEnvironmentRecovery(input) {
      return await client.mutation(claimEnvironmentRecoveryMutation, {
        ...privateArgs,
        incidentId: input.incidentId as Id<"incidents">,
        expectedStateVersion: input.expectedStateVersion,
      });
    },

    async completeEnvironmentRecovery(input) {
      return await client.mutation(completeEnvironmentRecoveryMutation, {
        ...privateArgs,
        ...input,
        incidentId: input.incidentId as Id<"incidents">,
      });
    },

    async failEnvironmentRecovery(input) {
      return await client.mutation(failEnvironmentRecoveryMutation, {
        ...privateArgs,
        incidentId: input.incidentId as Id<"incidents">,
        expectedStateVersion: input.expectedStateVersion,
        errorSummary: input.errorSummary,
      });
    },

    async getActiveCommand() {
      const rawCommand = await client.query(
        api.runner.getActiveDemoCommand,
        privateArgs,
      );
      return mapCommand(rawCommand);
    },

    subscribeToActiveCommand(onCommand, onError) {
      return client.onUpdate(
        api.runner.getActiveDemoCommand,
        privateArgs,
        (rawCommand) => {
          try {
            onCommand(mapCommand(rawCommand));
          } catch (error) {
            onError(asError(error));
          }
        },
        (error) => onError(asError(error)),
      );
    },

    connectionState() {
      return client.connectionState();
    },

    subscribeToConnectionState(callback) {
      return client.subscribeToConnectionState(callback);
    },

    async claimDemoCommand(input) {
      return await client.mutation(api.runner.claimDemoCommand, {
        ...privateArgs,
        ...input,
        demoCommandId: input.demoCommandId as Id<"demoCommands">,
      });
    },

    async renewLease(input: VersionedCommandInput) {
      return await client.mutation(api.runner.renewLease, {
        ...privateArgs,
        ...input,
        demoCommandId: input.demoCommandId as Id<"demoCommands">,
      });
    },

    async failDemoCommand(input: FailDemoCommandInput) {
      return await client.mutation(api.runner.failDemoCommand, {
        ...privateArgs,
        ...input,
        demoCommandId: input.demoCommandId as Id<"demoCommands">,
      });
    },

    async markResetApplied(input: VersionedCommandInput) {
      return await client.mutation(api.runner.markResetApplied, {
        ...privateArgs,
        ...input,
        demoCommandId: input.demoCommandId as Id<"demoCommands">,
      });
    },

    async markFailureConfirmed(input: VersionedCommandInput) {
      return await client.mutation(api.runner.markFailureConfirmed, {
        ...privateArgs,
        ...input,
        demoCommandId: input.demoCommandId as Id<"demoCommands">,
      });
    },

    async createIncident(input: CreateIncidentInput) {
      const result = await client.mutation(
        api.runner.createIncidentFromConfirmedFailure,
        {
          ...privateArgs,
          ...input,
          demoCommandId: input.demoCommandId as Id<"demoCommands">,
        },
      );
      return {
        incidentId: result.incidentId as string,
        stateVersion: result.stateVersion,
      };
    },

    async appendStep(input: RunnerStepInput) {
      const result = await client.mutation(api.runner.appendStep, {
        ...privateArgs,
        ...input,
        demoCommandId: input.demoCommandId as Id<"demoCommands">,
        incidentId: input.incidentId as Id<"incidents"> | undefined,
      });
      return {
        stepId: result.stepId as string,
        sequence: result.sequence,
      };
    },

    async updateIncidentPhase(input: UpdateIncidentPhaseInput) {
      return await client.mutation(api.runner.updateIncidentPhase, {
        ...privateArgs,
        ...input,
        demoCommandId: input.demoCommandId as Id<"demoCommands">,
        incidentId: input.incidentId as Id<"incidents">,
        diagnosisEvidence: input.diagnosisEvidence
          ? [...input.diagnosisEvidence]
          : undefined,
        recoveryCommandId: input.recoveryCommandId as
          Id<"recoveryCommands"> | undefined,
      });
    },

    async createRecoveryCommand(input: CreateRecoveryCommandInput) {
      const result = await client.mutation(api.runner.createRecoveryCommand, {
        ...privateArgs,
        ...input,
        demoCommandId: input.demoCommandId as Id<"demoCommands">,
        incidentId: input.incidentId as Id<"incidents">,
      });
      return {
        recoveryCommandId: result.recoveryCommandId as string,
        stateVersion: result.stateVersion,
      };
    },

    async completeIncident(input: CompleteIncidentInput) {
      return await client.mutation(api.runner.completeIncident, {
        ...privateArgs,
        ...input,
        demoCommandId: input.demoCommandId as Id<"demoCommands">,
        incidentId: input.incidentId as Id<"incidents">,
        recoveryCommandId: input.recoveryCommandId as
          Id<"recoveryCommands"> | undefined,
      });
    },

    async close() {
      await client.close();
    },
  };
}
