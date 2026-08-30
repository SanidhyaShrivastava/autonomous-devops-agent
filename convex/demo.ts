import { v } from "convex/values";

import { internalMutation, mutation, query } from "./_generated/server";
import {
  COMMAND_EXPIRY_MS,
  DAILY_REQUEST_CAP,
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
  },
  handler: async (ctx, args) => {
    requireDemoRequestSecret(args.requestSecret);

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

    const demoCommandId = await ctx.db.insert("demoCommands", {
      kind: DEMO_COMMAND_KIND,
      status: "queued",
      createdAt: now,
      expiresAt: now + COMMAND_EXPIRY_MS,
      stateVersion: 0,
      idempotencyKey: "pending",
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
