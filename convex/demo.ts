import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import {
  COMMAND_EXPIRY_MS,
  CLAIM_LEASE_MS,
  DAILY_REQUEST_CAP,
  DEMO_ACTION_ID,
  DEMO_COMMAND_KIND,
  PUBLIC_OUTPUT_LIMIT,
  PUBLIC_STEP_LIMIT,
  REQUEST_COOLDOWN_MS,
  RUNNER_FRESHNESS_MS,
  rejectWithCode,
  requireDemoRequestSecret,
  sanitizeForPersistence,
  utcDayKey,
} from "./lib/guards";

const executionMode = v.union(
  v.literal("autonomous"),
  v.literal("approval_required"),
);

const approvalDecision = v.union(
  v.literal("approved"),
  v.literal("rejected"),
);

const APPROVAL_CAPABILITY_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const APPROVAL_ACTION_LABEL =
  "linux agent restart fixed demo service" as const;

function requireApprovalCapabilityDigest(value: string) {
  if (!APPROVAL_CAPABILITY_DIGEST_PATTERN.test(value)) {
    rejectWithCode("INVALID_APPROVAL_CAPABILITY");
  }
  return value;
}

async function closePendingApprovalRequestStep(
  ctx: MutationCtx,
  demoCommandId: Id<"demoCommands">,
  incidentId: Id<"incidents">,
  status: "succeeded" | "blocked",
  now: number,
) {
  const matchingRequests = (
    await ctx.db
      .query("steps")
      .withIndex("by_demo_command_sequence", (q) =>
        q.eq("demoCommandId", demoCommandId),
      )
      .order("desc")
      .collect()
  ).filter(
    (step) =>
      step.incidentId === incidentId && step.kind === "approval_requested",
  );
  const pendingRequests = matchingRequests.filter(
    (step) => step.status === "pending" && step.finishedAt === undefined,
  );
  const latestRequest = matchingRequests[0];
  if (
    !latestRequest ||
    pendingRequests.length !== 1 ||
    pendingRequests[0]?._id !== latestRequest._id ||
    latestRequest.role !== "policy_gate" ||
    latestRequest.safeCommandLabel !== APPROVAL_ACTION_LABEL ||
    latestRequest.startedAt > now
  ) {
    rejectWithCode("APPROVAL_REQUEST_STEP_INVALID");
  }

  await ctx.db.patch(latestRequest._id, {
    status,
    finishedAt: now,
    latencyMs: Math.floor(now - latestRequest.startedAt),
  });
  return latestRequest;
}

export const setEnabled = internalMutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const control = await ctx.db
      .query("demoControl")
      .withIndex("by_key", (q) => q.eq("key", "singleton"))
      .unique();

    if (control) {
      await ctx.db.patch(control._id, { enabled: args.enabled });
      return { enabled: args.enabled };
    }

    await ctx.db.insert("demoControl", {
      key: "singleton",
      enabled: args.enabled,
      dayKey: utcDayKey(now),
      dayCount: 0,
    });
    return { enabled: args.enabled };
  },
});

export const requestRun = mutation({
  args: {
    requestSecret: v.string(),
    executionMode: v.optional(executionMode),
    approvalCapabilityDigest: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireDemoRequestSecret(args.requestSecret);

    const selectedExecutionMode = args.executionMode ?? "autonomous";
    let approvalCapabilityDigest: string | undefined;
    if (selectedExecutionMode === "approval_required") {
      if (args.approvalCapabilityDigest === undefined) {
        rejectWithCode("APPROVAL_CAPABILITY_REQUIRED");
      }
      approvalCapabilityDigest = requireApprovalCapabilityDigest(
        args.approvalCapabilityDigest,
      );
    } else if (args.approvalCapabilityDigest !== undefined) {
      rejectWithCode("UNEXPECTED_APPROVAL_CAPABILITY");
    }

    const now = Date.now();
    const currentDayKey = utcDayKey(now);
    const control = await ctx.db
      .query("demoControl")
      .withIndex("by_key", (q) => q.eq("key", "singleton"))
      .unique();

    if (!control?.enabled) {
      rejectWithCode("DEMO_DISABLED");
    }

    if (
      control.runnerHeartbeatAt === undefined ||
      now - control.runnerHeartbeatAt >= RUNNER_FRESHNESS_MS
    ) {
      rejectWithCode("RUNNER_OFFLINE");
    }

    if (control.environmentRecoveryIncidentId) {
      const recoveryIncident = await ctx.db.get(
        control.environmentRecoveryIncidentId,
      );
      if (
        recoveryIncident?.environmentRecoveryStatus === "pending" ||
        recoveryIncident?.environmentRecoveryStatus === "restoring"
      ) {
        rejectWithCode("ENVIRONMENT_RECOVERY_PENDING");
      }
      await ctx.db.patch(control._id, {
        environmentRecoveryIncidentId: undefined,
      });
    }

    if (control.activeDemoCommandId || control.activeIncidentId) {
      rejectWithCode("ACTIVE_RUN");
    }

    if (
      control.lastRequestedAt !== undefined &&
      now - control.lastRequestedAt < REQUEST_COOLDOWN_MS
    ) {
      rejectWithCode("COOLDOWN");
    }

    const dayCount = control.dayKey === currentDayKey ? control.dayCount : 0;
    if (dayCount >= DAILY_REQUEST_CAP) {
      rejectWithCode("DAILY_CAP");
    }

    if (approvalCapabilityDigest) {
      const existingCommand = await ctx.db
        .query("demoCommands")
        .withIndex("by_approval_capability_digest", (q) =>
          q.eq("approvalCapabilityDigest", approvalCapabilityDigest),
        )
        .first();
      const existingRecovery = await ctx.db
        .query("recoveryCommands")
        .withIndex("by_approval_capability_digest", (q) =>
          q.eq("approvalCapabilityDigest", approvalCapabilityDigest),
        )
        .first();
      if (existingCommand || existingRecovery) {
        rejectWithCode("APPROVAL_CAPABILITY_REPLAY");
      }
    }

    const demoCommandId = await ctx.db.insert("demoCommands", {
      kind: DEMO_COMMAND_KIND,
      status: "queued",
      createdAt: now,
      expiresAt: now + COMMAND_EXPIRY_MS,
      stateVersion: 0,
      idempotencyKey: "pending",
      executionMode: selectedExecutionMode,
      approvalCapabilityDigest,
    });

    await ctx.db.patch(demoCommandId, {
      idempotencyKey: `demo:${demoCommandId}`,
    });
    await ctx.db.patch(control._id, {
      activeDemoCommandId: demoCommandId,
      activeIncidentId: undefined,
      lastRequestedAt: now,
      dayKey: currentDayKey,
      dayCount: dayCount + 1,
    });

    return { demoCommandId };
  },
});

export const getApprovalSession = query({
  args: {
    requestSecret: v.string(),
    approvalCapabilityDigest: v.string(),
  },
  handler: async (ctx, args) => {
    requireDemoRequestSecret(args.requestSecret);
    if (
      !APPROVAL_CAPABILITY_DIGEST_PATTERN.test(args.approvalCapabilityDigest)
    ) {
      return null;
    }

    const recovery = await ctx.db
      .query("recoveryCommands")
      .withIndex("by_approval_capability_digest", (q) =>
        q.eq("approvalCapabilityDigest", args.approvalCapabilityDigest),
      )
      .unique();
    if (
      !recovery?.approvalStatus ||
      recovery.approvalExpiresAt === undefined
    ) {
      return null;
    }

    const [command, incident, control] = await Promise.all([
      ctx.db.get(recovery.demoCommandId),
      ctx.db.get(recovery.incidentId),
      ctx.db
        .query("demoControl")
        .withIndex("by_key", (q) => q.eq("key", "singleton"))
        .unique(),
    ]);
    if (
      !command ||
      !incident ||
      !control ||
      command.executionMode !== "approval_required" ||
      command.approvalCapabilityDigest !== args.approvalCapabilityDigest ||
      recovery.status !== "proposed" ||
      recovery.approvalStatus !== "pending" ||
      incident.currentPhase !== "awaiting_approval" ||
      control.activeDemoCommandId !== command._id ||
      control.activeIncidentId !== incident._id
    ) {
      return null;
    }

    const status =
      recovery.approvalStatus === "pending" &&
      Date.now() >= recovery.approvalExpiresAt
        ? ("expired" as const)
        : recovery.approvalStatus;
    return {
      demoCommandId: recovery.demoCommandId,
      incidentId: recovery.incidentId,
      status,
      expiresAt: recovery.approvalExpiresAt,
      decidedAt: recovery.approvalDecidedAt ?? null,
    };
  },
});

export const decideApproval = mutation({
  args: {
    requestSecret: v.string(),
    approvalCapabilityDigest: v.string(),
    decision: approvalDecision,
  },
  handler: async (ctx, args) => {
    requireDemoRequestSecret(args.requestSecret);
    const approvalCapabilityDigest = requireApprovalCapabilityDigest(
      args.approvalCapabilityDigest,
    );
    const recovery = await ctx.db
      .query("recoveryCommands")
      .withIndex("by_approval_capability_digest", (q) =>
        q.eq("approvalCapabilityDigest", approvalCapabilityDigest),
      )
      .unique();
    if (!recovery) {
      rejectWithCode("APPROVAL_NOT_FOUND");
    }

    const [command, incident, control] = await Promise.all([
      ctx.db.get(recovery.demoCommandId),
      ctx.db.get(recovery.incidentId),
      ctx.db
        .query("demoControl")
        .withIndex("by_key", (q) => q.eq("key", "singleton"))
        .unique(),
    ]);
    if (
      !command ||
      !incident ||
      !control ||
      command.executionMode !== "approval_required" ||
      command.approvalCapabilityDigest !== approvalCapabilityDigest ||
      incident.demoCommandId !== command._id ||
      recovery.demoCommandId !== command._id ||
      recovery.incidentId !== incident._id ||
      recovery.actionId !== DEMO_ACTION_ID ||
      !incident.staged
    ) {
      rejectWithCode("APPROVAL_NOT_FOUND");
    }
    if (
      control.activeDemoCommandId !== command._id ||
      control.activeIncidentId !== incident._id ||
      incident.currentPhase !== "awaiting_approval" ||
      recovery.status !== "proposed" ||
      recovery.approvalStatus !== "pending"
    ) {
      rejectWithCode("APPROVAL_NOT_PENDING");
    }

    const now = Date.now();
    if (
      recovery.approvalExpiresAt === undefined ||
      now >= recovery.approvalExpiresAt
    ) {
      rejectWithCode("APPROVAL_EXPIRED");
    }
    if (
      args.decision === "approved" &&
      (control.runnerHeartbeatAt === undefined ||
        now - control.runnerHeartbeatAt >= RUNNER_FRESHNESS_MS)
    ) {
      rejectWithCode("RUNNER_OFFLINE");
    }

    await closePendingApprovalRequestStep(
      ctx,
      command._id,
      incident._id,
      args.decision === "approved" ? "succeeded" : "blocked",
      now,
    );

    const latestStep = await ctx.db
      .query("steps")
      .withIndex("by_demo_command_sequence", (q) =>
        q.eq("demoCommandId", command._id),
      )
      .order("desc")
      .first();
    const decisionSequence = (latestStep?.sequence ?? 0) + 1;
    const decisionLabel =
      args.decision === "approved"
        ? "starting visitor approved staged restart"
        : "starting visitor rejected staged restart";
    await ctx.db.insert("steps", {
      demoCommandId: command._id,
      incidentId: incident._id,
      sequence: decisionSequence,
      stepNonce: `approval_decision_${recovery._id}`,
      role: "human_operator",
      kind: "approval_decision",
      status: args.decision === "approved" ? "succeeded" : "blocked",
      sanitizedOutput: JSON.stringify({
        decision: args.decision,
        source: "starting visitor",
        actionId: DEMO_ACTION_ID,
      }),
      startedAt: now,
      finishedAt: now,
      latencyMs: 0,
      costStatus: "not_reported",
    });

    await ctx.db.patch(recovery._id, {
      approvalStatus: args.decision,
      approvalDecidedAt: now,
      stateVersion: recovery.stateVersion + 1,
    });

    if (args.decision === "approved") {
      await ctx.db.patch(command._id, {
        leaseExpiresAt: now + CLAIM_LEASE_MS,
      });
    } else {
      await ctx.db.patch(recovery._id, {
        status: "blocked",
        completedAt: now,
      });
      await ctx.db.patch(incident._id, {
        status: "needs_human",
        currentPhase: "needs_human",
        finalHealth: "failed",
        finishedAt: now,
        totalLatencyMs: Math.max(0, now - incident.startedAt),
        terminalReason: "approval_rejected",
        lastCompletedStepSequence: decisionSequence,
        lastCompletedStepLabel: decisionLabel,
        environmentRecoveryStatus: "pending",
        environmentRecoveryStartedAt: undefined,
        environmentRecoveredAt: undefined,
        environmentRecoveryError: undefined,
        stateVersion: incident.stateVersion + 1,
      });
      await ctx.db.patch(command._id, {
        status: "complete",
        finishedAt: now,
        leaseExpiresAt: undefined,
        stateVersion: command.stateVersion + 1,
      });
      await ctx.db.patch(control._id, {
        activeDemoCommandId: undefined,
        activeIncidentId: undefined,
        environmentRecoveryIncidentId: incident._id,
      });
    }

    return {
      demoCommandId: command._id,
      incidentId: incident._id,
      recoveryCommandId: recovery._id,
      status: args.decision,
      decidedAt: now,
    };
  },
});

export const getPublicState = query({
  args: { demoCommandId: v.optional(v.id("demoCommands")) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const control = await ctx.db
      .query("demoControl")
      .withIndex("by_key", (q) => q.eq("key", "singleton"))
      .unique();

    const requestedCommand = args.demoCommandId
      ? await ctx.db.get(args.demoCommandId)
      : null;
    const requestedIncident = requestedCommand
      ? await ctx.db
          .query("incidents")
          .withIndex("by_demo_command", (q) =>
            q.eq("demoCommandId", requestedCommand._id),
          )
          .unique()
      : null;
    const activeCommand = args.demoCommandId
      ? null
      : control?.activeDemoCommandId
        ? await ctx.db.get(control.activeDemoCommandId)
        : null;
    const activeIncident = args.demoCommandId
      ? null
      : control?.activeIncidentId
        ? await ctx.db.get(control.activeIncidentId)
        : null;
    const hasControlActiveRun = Boolean(
      control?.activeDemoCommandId || control?.activeIncidentId,
    );
    const latestHistoricalCommand =
      args.demoCommandId || hasControlActiveRun
        ? null
        : await ctx.db
            .query("demoCommands")
            .withIndex("by_created_at")
            .order("desc")
            .first();
    const defaultCommand = activeCommand ?? latestHistoricalCommand;
    const defaultIncident =
      activeIncident ??
      (defaultCommand
        ? await ctx.db
            .query("incidents")
            .withIndex("by_demo_command", (q) =>
              q.eq("demoCommandId", defaultCommand._id),
            )
            .unique()
        : null);
    const displayedIncident = args.demoCommandId
      ? requestedIncident
      : defaultIncident;
    const displayedCommand = args.demoCommandId
      ? requestedCommand
      : defaultCommand
        ? defaultCommand
        : displayedIncident
          ? await ctx.db.get(displayedIncident.demoCommandId)
          : null;
    const displayedRecovery = displayedIncident
      ? await ctx.db
          .query("recoveryCommands")
          .withIndex("by_incident", (q) =>
            q.eq("incidentId", displayedIncident._id),
          )
          .unique()
      : null;
    const commandStatus = displayedCommand
      ? displayedCommand.expiresAt <= now &&
        displayedCommand.status === "queued"
        ? "expired"
        : displayedCommand.status
      : null;
    const hasActiveRun = args.demoCommandId
      ? commandStatus !== null &&
        commandStatus !== "complete" &&
        commandStatus !== "failed" &&
        commandStatus !== "expired"
      : hasControlActiveRun;

    const descendingSteps = displayedCommand
      ? await ctx.db
          .query("steps")
          .withIndex("by_demo_command_sequence", (q) =>
            q.eq("demoCommandId", displayedCommand._id),
          )
          .order("desc")
          .take(PUBLIC_STEP_LIMIT)
      : [];

    const runnerOnline =
      control?.runnerHeartbeatAt !== undefined &&
      now - control.runnerHeartbeatAt < RUNNER_FRESHNESS_MS;
    const cooldownRemainingMs = control?.lastRequestedAt
      ? Math.max(0, REQUEST_COOLDOWN_MS - (now - control.lastRequestedAt))
      : 0;

    return {
      snapshotAt: now,
      demoCommandId: displayedCommand?._id ?? null,
      commandStatus,
      commandExpiresAt: displayedCommand?.expiresAt ?? null,
      executionMode: displayedCommand?.executionMode ?? "autonomous",
      approval:
        displayedRecovery?.approvalStatus &&
        displayedRecovery.approvalRequestedAt !== undefined &&
        displayedRecovery.approvalExpiresAt !== undefined
          ? {
              status:
                displayedRecovery.approvalStatus === "pending" &&
                now >= displayedRecovery.approvalExpiresAt
                  ? ("expired" as const)
                  : displayedRecovery.approvalStatus,
              actionId: displayedRecovery.actionId,
              actionLabel: APPROVAL_ACTION_LABEL,
              requestedAt: displayedRecovery.approvalRequestedAt,
              expiresAt: displayedRecovery.approvalExpiresAt,
              decidedAt: displayedRecovery.approvalDecidedAt ?? null,
            }
          : null,
      runnerOnline,
      enabled: control?.enabled ?? false,
      active: hasActiveRun,
      runnerHeartbeatAt: control?.runnerHeartbeatAt ?? null,
      cooldownUntil:
        control?.lastRequestedAt === undefined
          ? null
          : control.lastRequestedAt + REQUEST_COOLDOWN_MS,
      cooldownRemainingMs,
      incident: displayedIncident
        ? {
            incidentId: displayedIncident._id,
            staged: displayedIncident.staged,
            status:
              displayedIncident.status ??
              (displayedIncident.currentPhase === "resolved"
                ? "resolved"
                : displayedIncident.currentPhase === "needs_human"
                  ? "needs_human"
                  : displayedIncident.finishedAt !== undefined
                    ? "failed"
                    : "active"),
            currentPhase: displayedIncident.currentPhase,
            initialHealth: sanitizeForPersistence(
              displayedIncident.initialHealth,
              64,
            ),
            finalHealth: displayedIncident.finalHealth
              ? sanitizeForPersistence(displayedIncident.finalHealth, 64)
              : null,
            incidentCategory: displayedIncident.incidentCategory
              ? sanitizeForPersistence(displayedIncident.incidentCategory, 120)
              : null,
            diagnosisEvidence:
              displayedIncident.diagnosisEvidence?.map((evidence) =>
                sanitizeForPersistence(evidence, 500),
              ) ?? null,
            diagnosisSummary: displayedIncident.diagnosisSummary
              ? sanitizeForPersistence(
                  displayedIncident.diagnosisSummary,
                  1_000,
                )
              : null,
            confidence: displayedIncident.confidence ?? null,
            requiresHuman: displayedIncident.requiresHuman ?? null,
            proposedActionId: displayedIncident.proposedActionId ?? null,
            startedAt: displayedIncident.startedAt,
            finishedAt: displayedIncident.finishedAt ?? null,
            terminalReason: displayedIncident.terminalReason
              ? sanitizeForPersistence(displayedIncident.terminalReason, 500)
              : null,
            lastCompletedStepSequence:
              displayedIncident.lastCompletedStepSequence ?? null,
            lastCompletedStepLabel: displayedIncident.lastCompletedStepLabel
              ? sanitizeForPersistence(
                  displayedIncident.lastCompletedStepLabel,
                  120,
                )
              : null,
            environmentRecoveryStatus:
              displayedIncident.environmentRecoveryStatus ?? null,
            environmentRecoveryError: displayedIncident.environmentRecoveryError
              ? sanitizeForPersistence(
                  displayedIncident.environmentRecoveryError,
                  500,
                )
              : null,
            environmentRecoveryStartedAt:
              displayedIncident.environmentRecoveryStartedAt ?? null,
            environmentRecoveredAt:
              displayedIncident.environmentRecoveredAt ?? null,
          }
        : null,
      steps: descendingSteps.reverse().map((step) => ({
        stepId: step._id,
        sequence: step.sequence,
        role: step.role,
        kind: sanitizeForPersistence(step.kind, 80),
        status: step.status,
        safeCommandLabel: step.safeCommandLabel
          ? sanitizeForPersistence(step.safeCommandLabel, 120)
          : null,
        sanitizedOutput: step.sanitizedOutput
          ? sanitizeForPersistence(step.sanitizedOutput, PUBLIC_OUTPUT_LIMIT)
          : null,
        errorSummary: step.errorSummary
          ? sanitizeForPersistence(step.errorSummary, 500)
          : null,
        startedAt: step.startedAt,
        finishedAt: step.finishedAt ?? null,
        latencyMs: step.latencyMs ?? null,
      })),
      result: displayedIncident
        ? {
            finalHealth: displayedIncident.finalHealth ?? null,
            totalLatencyMs: displayedIncident.totalLatencyMs ?? null,
          }
        : null,
    };
  },
});
