import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  CLAIM_LEASE_MS,
  DEMO_ACTION_ID,
  DEMO_HEALTHY_STATUS,
  DEMO_RUNNER_ID,
  DEMO_SERVICE_IDENTITY,
  DEMO_WORKLOAD_ID,
  MAX_CLOCK_SKEW_MS,
  MINIMUM_AUTONOMOUS_CONFIDENCE,
  rejectWithCode,
  requireBoundedIdentifier,
  requireBoundedText,
  requireDemoRunner,
  requireNonNegativeInteger,
  requireRunnerToken,
  sanitizeForPersistence,
  utcDayKey,
} from "./lib/guards";

const incidentPhase = v.union(
  v.literal("failed_detected"),
  v.literal("investigating"),
  v.literal("manager_review"),
  v.literal("policy_check"),
  v.literal("executing"),
  v.literal("verifying"),
  v.literal("resolved"),
  v.literal("needs_human"),
  v.literal("failed_recovery"),
  v.literal("investigation_failed"),
);

const terminalState = v.union(
  v.literal("resolved"),
  v.literal("needs_human"),
  v.literal("failed_recovery"),
  v.literal("investigation_failed"),
);

const agentRole = v.union(
  v.literal("incident_manager"),
  v.literal("investigator"),
  v.literal("recovery_planner"),
  v.literal("policy_gate"),
  v.literal("executor"),
  v.literal("verifier"),
);

const stepStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("blocked"),
);

const costStatus = v.union(
  v.literal("not_reported"),
  v.literal("reported"),
  v.literal("unavailable_chatgpt_subscription"),
);

type IncidentPhase = Doc<"incidents">["currentPhase"];
type DatabaseContext = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

const TERMINAL_STATES = new Set<IncidentPhase>([
  "resolved",
  "needs_human",
  "failed_recovery",
  "investigation_failed",
]);

const DEMO_RECOVERY_COMMAND_LABEL =
  "docker start fixed demo service" as const;

const ALLOWED_NEXT_PHASES: Readonly<
  Record<IncidentPhase, readonly IncidentPhase[]>
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

async function getControl(ctx: DatabaseContext) {
  return await ctx.db
    .query("demoControl")
    .withIndex("by_key", (q) => q.eq("key", "singleton"))
    .unique();
}

async function requireCommand(
  ctx: DatabaseContext,
  demoCommandId: Id<"demoCommands">,
) {
  const command = await ctx.db.get(demoCommandId);
  if (!command) {
    rejectWithCode("COMMAND_NOT_FOUND");
  }
  return command;
}

function requireFiniteTimestamp(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    rejectWithCode(`INVALID_${label.toUpperCase()}`);
  }
  return value;
}

function sanitizeDiagnosisEvidence(values: readonly string[]) {
  if (values.length < 1 || values.length > 5) {
    rejectWithCode("INVALID_DIAGNOSIS_EVIDENCE");
  }
  return values.map((value) =>
    sanitizeForPersistence(
      requireBoundedText(value, "diagnosis_evidence", 500),
      500,
    ),
  );
}

function requireClaimedCommand(
  command: Doc<"demoCommands">,
  runnerId: string,
  expectedStateVersion: number,
  now: number,
  allowedStatuses: readonly Doc<"demoCommands">["status"][],
) {
  if (command.runnerId !== runnerId) {
    rejectWithCode("RUNNER_MISMATCH");
  }
  if (command.stateVersion !== expectedStateVersion) {
    rejectWithCode("STALE_STATE");
  }
  if (command.leaseExpiresAt === undefined || now > command.leaseExpiresAt) {
    rejectWithCode("LEASE_EXPIRED");
  }
  if (!allowedStatuses.includes(command.status)) {
    rejectWithCode("INVALID_STATE");
  }
}

async function requireActiveIncident(
  ctx: DatabaseContext,
  command: Doc<"demoCommands">,
  incidentId: Id<"incidents">,
  expectedStateVersion: number,
) {
  const incident = await ctx.db.get(incidentId);
  if (!incident || incident.demoCommandId !== command._id) {
    rejectWithCode("INCIDENT_MISMATCH");
  }
  const control = await getControl(ctx);
  if (
    control?.activeDemoCommandId !== command._id ||
    control.activeIncidentId !== incident._id
  ) {
    rejectWithCode("INACTIVE_INCIDENT");
  }
  if (incident.stateVersion !== expectedStateVersion) {
    rejectWithCode("STALE_STATE");
  }
  return incident;
}

async function cleanExpiredActiveRun(
  ctx: MutationCtx,
  control: Doc<"demoControl">,
  now: number,
) {
  if (!control.activeDemoCommandId) {
    return false;
  }

  const command = await ctx.db.get(control.activeDemoCommandId);
  if (!command) {
    await ctx.db.patch(control._id, {
      activeDemoCommandId: undefined,
      activeIncidentId: undefined,
    });
    return true;
  }

  const queuedExpired = command.status === "queued" && now > command.expiresAt;
  const leaseExpired =
    command.status !== "queued" &&
    command.status !== "complete" &&
    command.status !== "expired" &&
    command.status !== "failed" &&
    command.leaseExpiresAt !== undefined &&
    now > command.leaseExpiresAt;
  if (!queuedExpired && !leaseExpired) {
    return false;
  }

  const incident = control.activeIncidentId
    ? await ctx.db.get(control.activeIncidentId)
    : null;
  if (incident && !TERMINAL_STATES.has(incident.currentPhase)) {
    const terminalPhase =
      incident.currentPhase === "executing" ||
      incident.currentPhase === "verifying"
        ? "failed_recovery"
        : "investigation_failed";
    await ctx.db.patch(incident._id, {
      currentPhase: terminalPhase,
      finalHealth: "failed",
      finishedAt: now,
      totalLatencyMs: Math.max(0, now - incident.startedAt),
      terminalReason: "runner_lease_expired",
      stateVersion: incident.stateVersion + 1,
    });

    const recovery = await ctx.db
      .query("recoveryCommands")
      .withIndex("by_incident", (q) => q.eq("incidentId", incident._id))
      .first();
    if (recovery && recovery.status !== "failed" && recovery.status !== "blocked") {
      await ctx.db.patch(recovery._id, {
        status: "failed",
        completedAt: now,
        stateVersion: recovery.stateVersion + 1,
      });
    }
  }

  const latestStep = await ctx.db
    .query("steps")
    .withIndex("by_demo_command_sequence", (q) =>
      q.eq("demoCommandId", command._id),
    )
    .order("desc")
    .first();
  await ctx.db.insert("steps", {
    demoCommandId: command._id,
    incidentId: incident?._id,
    sequence: (latestStep?.sequence ?? 0) + 1,
    stepNonce: `system_expiry_${command._id}`,
    role: "incident_manager",
    kind: queuedExpired ? "command_expired" : "runner_lease_expired",
    status: "failed",
    errorSummary: queuedExpired
      ? "Demo command expired before it was claimed."
      : "Runner lease expired; the active run was closed safely.",
    startedAt: now,
    finishedAt: now,
    latencyMs: 0,
    costStatus: "not_reported",
  });

  await ctx.db.patch(command._id, {
    status: queuedExpired ? "expired" : "failed",
    finishedAt: now,
    leaseExpiresAt: undefined,
    stateVersion: command.stateVersion + 1,
  });
  await ctx.db.patch(control._id, {
    activeDemoCommandId: undefined,
    activeIncidentId: undefined,
  });
  return true;
}

export const heartbeat = mutation({
  args: {
    runnerToken: v.string(),
    runnerId: v.string(),
  },
  handler: async (ctx, args) => {
    requireRunnerToken(args.runnerToken);
    requireDemoRunner(args.runnerId);

    const now = Date.now();
    const control = await getControl(ctx);
    if (!control) {
      await ctx.db.insert("demoControl", {
        key: "singleton",
        enabled: false,
        dayKey: utcDayKey(now),
        dayCount: 0,
        runnerHeartbeatAt: now,
      });
    } else {
      await cleanExpiredActiveRun(ctx, control, now);
      await ctx.db.patch(control._id, { runnerHeartbeatAt: now });
    }

    return { runnerHeartbeatAt: now };
  },
});

export const getPendingDemoCommand = query({
  args: {
    runnerToken: v.string(),
    runnerId: v.string(),
  },
  handler: async (ctx, args) => {
    requireRunnerToken(args.runnerToken);
    requireDemoRunner(args.runnerId);

    const control = await getControl(ctx);
    if (!control?.activeDemoCommandId) {
      return null;
    }

    const command = await ctx.db.get(control.activeDemoCommandId);
    if (
      !command ||
      command.status !== "queued" ||
      Date.now() > command.expiresAt
    ) {
      return null;
    }

    return {
      _id: command._id,
      kind: command.kind,
      status: command.status,
      createdAt: command.createdAt,
      expiresAt: command.expiresAt,
      stateVersion: command.stateVersion,
    };
  },
});

export const getActiveDemoCommand = query({
  args: {
    runnerToken: v.string(),
    runnerId: v.string(),
  },
  handler: async (ctx, args) => {
    requireRunnerToken(args.runnerToken);
    requireDemoRunner(args.runnerId);

    const control = await getControl(ctx);
    if (!control?.activeDemoCommandId) {
      return null;
    }
    const command = await ctx.db.get(control.activeDemoCommandId);
    if (!command) {
      return null;
    }
    if (command.runnerId && command.runnerId !== args.runnerId) {
      rejectWithCode("RUNNER_MISMATCH");
    }

    const incident = control.activeIncidentId
      ? await ctx.db.get(control.activeIncidentId)
      : null;
    if (incident && incident.demoCommandId !== command._id) {
      rejectWithCode("INCIDENT_MISMATCH");
    }
    const recovery = incident
      ? await ctx.db
          .query("recoveryCommands")
          .withIndex("by_incident", (q) => q.eq("incidentId", incident._id))
          .unique()
      : null;
    if (recovery && recovery.runnerId !== args.runnerId) {
      rejectWithCode("RUNNER_MISMATCH");
    }
    const existingSteps = await ctx.db
      .query("steps")
      .withIndex("by_demo_command_sequence", (q) =>
        q.eq("demoCommandId", command._id),
      )
      .take(100);

    return {
      _id: command._id,
      kind: command.kind,
      status: command.status,
      createdAt: command.createdAt,
      expiresAt: command.expiresAt,
      claimedAt: command.claimedAt ?? null,
      leaseExpiresAt: command.leaseExpiresAt ?? null,
      stateVersion: command.stateVersion,
      incidentId: control.activeIncidentId ?? null,
      incident: incident
        ? {
            _id: incident._id,
            currentPhase: incident.currentPhase,
            stateVersion: incident.stateVersion,
            incidentCategory: incident.incidentCategory ?? null,
            diagnosisEvidence: incident.diagnosisEvidence ?? null,
            diagnosisSummary: incident.diagnosisSummary ?? null,
            confidence: incident.confidence ?? null,
            requiresHuman: incident.requiresHuman ?? null,
            proposedActionId: incident.proposedActionId ?? null,
          }
        : null,
      recovery: recovery
        ? {
            _id: recovery._id,
            actionId: recovery.actionId,
            status: recovery.status,
            stateVersion: recovery.stateVersion,
            executionNonce: recovery.executionNonce,
            completedAt: recovery.completedAt ?? null,
            executionEvidence:
              recovery.executionCommandLabel !== undefined &&
              recovery.executionExitCode !== undefined &&
              recovery.executionStartedAt !== undefined &&
              recovery.executionFinishedAt !== undefined &&
              recovery.executionLatencyMs !== undefined &&
              recovery.executionEvidenceNonce === recovery.executionNonce
                ? {
                    commandLabel: recovery.executionCommandLabel,
                    exitCode: recovery.executionExitCode,
                    startedAt: recovery.executionStartedAt,
                    finishedAt: recovery.executionFinishedAt,
                    latencyMs: recovery.executionLatencyMs,
                  }
                : null,
          }
        : null,
      stepNonces: existingSteps.map((step) => step.stepNonce),
    };
  },
});

export const renewLease = mutation({
  args: {
    runnerToken: v.string(),
    runnerId: v.string(),
    demoCommandId: v.id("demoCommands"),
    expectedStateVersion: v.number(),
  },
  handler: async (ctx, args) => {
    requireRunnerToken(args.runnerToken);
    requireDemoRunner(args.runnerId);

    const now = Date.now();
    const command = await requireCommand(ctx, args.demoCommandId);
    requireClaimedCommand(
      command,
      args.runnerId,
      args.expectedStateVersion,
      now,
      ["claimed", "reset_applied", "failure_confirmed"],
    );
    const leaseExpiresAt = now + CLAIM_LEASE_MS;
    await ctx.db.patch(command._id, { leaseExpiresAt });
    return { stateVersion: command.stateVersion, leaseExpiresAt };
  },
});

export const failDemoCommand = mutation({
  args: {
    runnerToken: v.string(),
    runnerId: v.string(),
    demoCommandId: v.id("demoCommands"),
    expectedStateVersion: v.number(),
    terminalReason: v.string(),
  },
  handler: async (ctx, args) => {
    requireRunnerToken(args.runnerToken);
    requireDemoRunner(args.runnerId);

    const now = Date.now();
    const command = await requireCommand(ctx, args.demoCommandId);
    requireClaimedCommand(
      command,
      args.runnerId,
      args.expectedStateVersion,
      now,
      ["claimed", "reset_applied", "failure_confirmed"],
    );
    const control = await getControl(ctx);
    if (
      control?.activeDemoCommandId !== command._id ||
      control.activeIncidentId
    ) {
      rejectWithCode("INCIDENT_ALREADY_CREATED");
    }

    const terminalReason = sanitizeForPersistence(
      requireBoundedText(args.terminalReason, "terminal_reason", 500),
      500,
    );
    const latestStep = await ctx.db
      .query("steps")
      .withIndex("by_demo_command_sequence", (q) =>
        q.eq("demoCommandId", command._id),
      )
      .order("desc")
      .first();
    await ctx.db.insert("steps", {
      demoCommandId: command._id,
      sequence: (latestStep?.sequence ?? 0) + 1,
      stepNonce: `system_command_failure_${command._id}`,
      role: "incident_manager",
      kind: "command_failed",
      status: "failed",
      errorSummary: terminalReason,
      startedAt: now,
      finishedAt: now,
      latencyMs: 0,
      costStatus: "not_reported",
    });

    const stateVersion = command.stateVersion + 1;
    await ctx.db.patch(command._id, {
      status: "failed",
      finishedAt: now,
      leaseExpiresAt: undefined,
      stateVersion,
    });
    await ctx.db.patch(control._id, {
      activeDemoCommandId: undefined,
      activeIncidentId: undefined,
    });
    return { status: "failed" as const, stateVersion };
  },
});

export const claimDemoCommand = mutation({
  args: {
    runnerToken: v.string(),
    runnerId: v.string(),
    demoCommandId: v.id("demoCommands"),
    expectedStateVersion: v.number(),
    claimNonce: v.string(),
  },
  handler: async (ctx, args) => {
    requireRunnerToken(args.runnerToken);
    requireDemoRunner(args.runnerId);

    const now = Date.now();
    const command = await requireCommand(ctx, args.demoCommandId);
    const claimNonce = requireBoundedIdentifier(args.claimNonce, "claim_nonce");
    if (
      command.status === "claimed" &&
      command.runnerId === args.runnerId &&
      command.claimNonce === claimNonce &&
      command.stateVersion === args.expectedStateVersion + 1
    ) {
      requireClaimedCommand(
        command,
        args.runnerId,
        command.stateVersion,
        now,
        ["claimed"],
      );
      return {
        status: "claimed" as const,
        stateVersion: command.stateVersion,
        leaseExpiresAt: command.leaseExpiresAt,
      };
    }
    if (command.stateVersion !== args.expectedStateVersion) {
      rejectWithCode("STALE_STATE");
    }
    if (command.status !== "queued") {
      rejectWithCode("INVALID_STATE");
    }

    const control = await getControl(ctx);
    if (
      control?.activeDemoCommandId !== command._id ||
      control.activeIncidentId
    ) {
      rejectWithCode("INACTIVE_COMMAND");
    }

    if (now > command.expiresAt) {
      await ctx.db.patch(command._id, {
        status: "expired",
        finishedAt: now,
        stateVersion: command.stateVersion + 1,
      });
      await ctx.db.patch(control._id, { activeDemoCommandId: undefined });
      return { status: "expired" as const, code: "COMMAND_EXPIRED" as const };
    }

    const stateVersion = command.stateVersion + 1;
    const leaseExpiresAt = now + CLAIM_LEASE_MS;
    await ctx.db.patch(command._id, {
      status: "claimed",
      claimedAt: now,
      runnerId: args.runnerId,
      claimNonce,
      leaseExpiresAt,
      stateVersion,
    });

    return { status: "claimed" as const, stateVersion, leaseExpiresAt };
  },
});

export const markResetApplied = mutation({
  args: {
    runnerToken: v.string(),
    runnerId: v.string(),
    demoCommandId: v.id("demoCommands"),
    expectedStateVersion: v.number(),
  },
  handler: async (ctx, args) => {
    requireRunnerToken(args.runnerToken);
    requireDemoRunner(args.runnerId);

    const now = Date.now();
    const command = await requireCommand(ctx, args.demoCommandId);
    if (
      command.status === "reset_applied" &&
      command.stateVersion === args.expectedStateVersion + 1
    ) {
      requireClaimedCommand(
        command,
        args.runnerId,
        command.stateVersion,
        now,
        ["reset_applied"],
      );
      return {
        stateVersion: command.stateVersion,
        leaseExpiresAt: command.leaseExpiresAt,
      };
    }
    requireClaimedCommand(
      command,
      args.runnerId,
      args.expectedStateVersion,
      now,
      ["claimed"],
    );

    const stateVersion = command.stateVersion + 1;
    const leaseExpiresAt = now + CLAIM_LEASE_MS;
    await ctx.db.patch(command._id, {
      status: "reset_applied",
      stateVersion,
      leaseExpiresAt,
    });
    return { stateVersion, leaseExpiresAt };
  },
});

export const markFailureConfirmed = mutation({
  args: {
    runnerToken: v.string(),
    runnerId: v.string(),
    demoCommandId: v.id("demoCommands"),
    expectedStateVersion: v.number(),
  },
  handler: async (ctx, args) => {
    requireRunnerToken(args.runnerToken);
    requireDemoRunner(args.runnerId);

    const now = Date.now();
    const command = await requireCommand(ctx, args.demoCommandId);
    if (
      command.status === "failure_confirmed" &&
      command.stateVersion === args.expectedStateVersion + 1
    ) {
      requireClaimedCommand(
        command,
        args.runnerId,
        command.stateVersion,
        now,
        ["failure_confirmed"],
      );
      return {
        stateVersion: command.stateVersion,
        leaseExpiresAt: command.leaseExpiresAt,
      };
    }
    requireClaimedCommand(
      command,
      args.runnerId,
      args.expectedStateVersion,
      now,
      ["reset_applied"],
    );

    const stateVersion = command.stateVersion + 1;
    const leaseExpiresAt = now + CLAIM_LEASE_MS;
    await ctx.db.patch(command._id, {
      status: "failure_confirmed",
      stateVersion,
      leaseExpiresAt,
    });
    return { stateVersion, leaseExpiresAt };
  },
});

export const createIncidentFromConfirmedFailure = mutation({
  args: {
    runnerToken: v.string(),
    runnerId: v.string(),
    demoCommandId: v.id("demoCommands"),
    expectedCommandStateVersion: v.number(),
    initialHealth: v.literal("failed"),
  },
  handler: async (ctx, args) => {
    requireRunnerToken(args.runnerToken);
    requireDemoRunner(args.runnerId);

    const now = Date.now();
    const command = await requireCommand(ctx, args.demoCommandId);
    requireClaimedCommand(
      command,
      args.runnerId,
      args.expectedCommandStateVersion,
      now,
      ["failure_confirmed"],
    );

    const existingIncident = await ctx.db
      .query("incidents")
      .withIndex("by_demo_command", (q) =>
        q.eq("demoCommandId", command._id),
      )
      .unique();
    if (existingIncident) {
      return {
        incidentId: existingIncident._id,
        stateVersion: existingIncident.stateVersion,
      };
    }

    const control = await getControl(ctx);
    if (
      control?.activeDemoCommandId !== command._id ||
      control.activeIncidentId
    ) {
      rejectWithCode("INACTIVE_COMMAND");
    }

    const incidentId = await ctx.db.insert("incidents", {
      demoCommandId: command._id,
      runId: `incident:${command._id}`,
      staged: true,
      runnerId: DEMO_RUNNER_ID,
      workloadId: DEMO_WORKLOAD_ID,
      currentPhase: "failed_detected",
      initialHealth: "failed",
      startedAt: now,
      costStatus: "not_reported",
      stateVersion: 0,
    });
    await ctx.db.patch(control._id, { activeIncidentId: incidentId });

    return { incidentId, stateVersion: 0 };
  },
});

export const appendStep = mutation({
  args: {
    runnerToken: v.string(),
    runnerId: v.string(),
    demoCommandId: v.id("demoCommands"),
    incidentId: v.optional(v.id("incidents")),
    expectedCommandStateVersion: v.number(),
    expectedIncidentStateVersion: v.optional(v.number()),
    stepNonce: v.string(),
    role: agentRole,
    kind: v.string(),
    status: stepStatus,
    safeCommandLabel: v.optional(v.string()),
    sanitizedOutput: v.optional(v.string()),
    errorSummary: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
    reportedInputTokens: v.optional(v.number()),
    reportedOutputTokens: v.optional(v.number()),
    costStatus: v.optional(costStatus),
  },
  handler: async (ctx, args) => {
    requireRunnerToken(args.runnerToken);
    requireDemoRunner(args.runnerId);

    const now = Date.now();
    const command = await requireCommand(ctx, args.demoCommandId);
    requireClaimedCommand(
      command,
      args.runnerId,
      args.expectedCommandStateVersion,
      now,
      ["claimed", "reset_applied", "failure_confirmed"],
    );
    const stepNonce = requireBoundedIdentifier(args.stepNonce, "step_nonce");
    const kind = requireBoundedText(args.kind, "step_kind", 80);
    const safeCommandLabel = args.safeCommandLabel
      ? sanitizeForPersistence(
          requireBoundedText(args.safeCommandLabel, "command_label", 120),
          120,
        )
      : undefined;
    const sanitizedOutput =
      args.sanitizedOutput === undefined
        ? undefined
        : sanitizeForPersistence(args.sanitizedOutput);
    const errorSummary =
      args.errorSummary === undefined
        ? undefined
        : sanitizeForPersistence(args.errorSummary, 500);
    const startedAt = requireFiniteTimestamp(args.startedAt, "started_at");
    const finishedAt =
      args.finishedAt === undefined
        ? undefined
        : requireFiniteTimestamp(args.finishedAt, "finished_at");
    if (finishedAt !== undefined && finishedAt < startedAt) {
      rejectWithCode("INVALID_FINISHED_AT");
    }
    const latencyMs =
      args.latencyMs === undefined
        ? finishedAt === undefined
          ? undefined
          : Math.floor(finishedAt - startedAt)
        : requireNonNegativeInteger(args.latencyMs, "latency_ms");
    const reportedInputTokens =
      args.reportedInputTokens === undefined
        ? undefined
        : requireNonNegativeInteger(
            args.reportedInputTokens,
            "reported_input_tokens",
          );
    const reportedOutputTokens =
      args.reportedOutputTokens === undefined
        ? undefined
        : requireNonNegativeInteger(
            args.reportedOutputTokens,
            "reported_output_tokens",
          );

    const existingStep = await ctx.db
      .query("steps")
      .withIndex("by_demo_command_step_nonce", (q) =>
        q.eq("demoCommandId", command._id).eq("stepNonce", stepNonce),
      )
      .unique();
    if (existingStep) {
      if (
        existingStep.incidentId !== args.incidentId ||
        existingStep.role !== args.role ||
        existingStep.kind !== kind ||
        existingStep.status !== args.status ||
        existingStep.safeCommandLabel !== safeCommandLabel ||
        existingStep.sanitizedOutput !== sanitizedOutput ||
        existingStep.errorSummary !== errorSummary ||
        existingStep.startedAt !== startedAt ||
        existingStep.finishedAt !== finishedAt ||
        existingStep.latencyMs !== latencyMs ||
        existingStep.reportedInputTokens !== reportedInputTokens ||
        existingStep.reportedOutputTokens !== reportedOutputTokens ||
        existingStep.costStatus !== args.costStatus
      ) {
        rejectWithCode("STEP_REPLAY_MISMATCH");
      }
      return { stepId: existingStep._id, sequence: existingStep.sequence };
    }

    if (args.incidentId) {
      if (args.expectedIncidentStateVersion === undefined) {
        rejectWithCode("STALE_STATE");
      }
      await requireActiveIncident(
        ctx,
        command,
        args.incidentId,
        args.expectedIncidentStateVersion,
      );
    } else if (args.expectedIncidentStateVersion !== undefined) {
      rejectWithCode("INCIDENT_MISMATCH");
    }

    const latestStep = await ctx.db
      .query("steps")
      .withIndex("by_demo_command_sequence", (q) =>
        q.eq("demoCommandId", command._id),
      )
      .order("desc")
      .first();
    const sequence = (latestStep?.sequence ?? 0) + 1;

    const stepId = await ctx.db.insert("steps", {
      demoCommandId: command._id,
      incidentId: args.incidentId,
      sequence,
      stepNonce,
      role: args.role,
      kind,
      status: args.status,
      safeCommandLabel,
      sanitizedOutput,
      errorSummary,
      startedAt,
      finishedAt,
      latencyMs,
      reportedInputTokens,
      reportedOutputTokens,
      costStatus: args.costStatus,
    });

    return { stepId, sequence };
  },
});

export const createRecoveryCommand = mutation({
  args: {
    runnerToken: v.string(),
    runnerId: v.string(),
    demoCommandId: v.id("demoCommands"),
    incidentId: v.id("incidents"),
    expectedCommandStateVersion: v.number(),
    expectedIncidentPhase: incidentPhase,
    expectedIncidentStateVersion: v.number(),
    actionId: v.literal("restart_demo_service"),
    executionNonce: v.string(),
  },
  handler: async (ctx, args) => {
    requireRunnerToken(args.runnerToken);
    requireDemoRunner(args.runnerId);

    const now = Date.now();
    const command = await requireCommand(ctx, args.demoCommandId);
    requireClaimedCommand(
      command,
      args.runnerId,
      args.expectedCommandStateVersion,
      now,
      ["failure_confirmed"],
    );
    const incident = await requireActiveIncident(
      ctx,
      command,
      args.incidentId,
      args.expectedIncidentStateVersion,
    );
    if (
      incident.currentPhase !== args.expectedIncidentPhase ||
      incident.currentPhase !== "policy_check"
    ) {
      rejectWithCode("INVALID_STATE");
    }
    if (
      !incident.diagnosisSummary?.trim() ||
      !incident.incidentCategory?.trim() ||
      !incident.diagnosisEvidence?.length ||
      !Number.isFinite(incident.confidence) ||
      incident.confidence === undefined ||
      incident.confidence < MINIMUM_AUTONOMOUS_CONFIDENCE ||
      incident.confidence > 1 ||
      incident.requiresHuman !== false ||
      incident.proposedActionId !== DEMO_ACTION_ID ||
      args.actionId !== DEMO_ACTION_ID
    ) {
      rejectWithCode("POLICY_DENIED");
    }

    const executionNonce = requireBoundedIdentifier(
      args.executionNonce,
      "execution_nonce",
    );
    const replay = await ctx.db
      .query("recoveryCommands")
      .withIndex("by_execution_nonce", (q) =>
        q.eq("executionNonce", executionNonce),
      )
      .first();
    const existingForIncident = await ctx.db
      .query("recoveryCommands")
      .withIndex("by_incident", (q) => q.eq("incidentId", incident._id))
      .first();
    if (
      replay &&
      replay._id === existingForIncident?._id &&
      replay.demoCommandId === command._id &&
      replay.incidentId === incident._id &&
      replay.actionId === args.actionId &&
      replay.executionNonce === executionNonce
    ) {
      return {
        recoveryCommandId: replay._id,
        stateVersion: replay.stateVersion,
      };
    }
    if (replay || existingForIncident) {
      rejectWithCode("EXECUTION_REPLAY");
    }

    const recoveryCommandId = await ctx.db.insert("recoveryCommands", {
      demoCommandId: command._id,
      incidentId: incident._id,
      actionId: DEMO_ACTION_ID,
      status: "allowed",
      createdAt: now,
      runnerId: DEMO_RUNNER_ID,
      stateVersion: 0,
      executionNonce,
    });
    await ctx.db.patch(command._id, {
      leaseExpiresAt: now + CLAIM_LEASE_MS,
    });

    return { recoveryCommandId, stateVersion: 0 };
  },
});

export const updateIncidentPhase = mutation({
  args: {
    runnerToken: v.string(),
    runnerId: v.string(),
    demoCommandId: v.id("demoCommands"),
    incidentId: v.id("incidents"),
    expectedPhase: incidentPhase,
    nextPhase: incidentPhase,
    expectedStateVersion: v.number(),
    expectedCommandStateVersion: v.number(),
    recoveryCommandId: v.optional(v.id("recoveryCommands")),
    expectedRecoveryStateVersion: v.optional(v.number()),
    executionNonce: v.optional(v.string()),
    executionEvidence: v.optional(
      v.object({
        commandLabel: v.string(),
        exitCode: v.number(),
        startedAt: v.number(),
        finishedAt: v.number(),
        latencyMs: v.number(),
      }),
    ),
    incidentCategory: v.optional(v.string()),
    diagnosisEvidence: v.optional(v.array(v.string())),
    diagnosisSummary: v.optional(v.string()),
    confidence: v.optional(v.number()),
    requiresHuman: v.optional(v.boolean()),
    proposedActionId: v.optional(
      v.union(v.literal("restart_demo_service"), v.literal("no_action")),
    ),
    reportedInputTokens: v.optional(v.number()),
    reportedOutputTokens: v.optional(v.number()),
    costStatus: v.optional(costStatus),
  },
  handler: async (ctx, args) => {
    requireRunnerToken(args.runnerToken);
    requireDemoRunner(args.runnerId);

    const now = Date.now();
    const command = await requireCommand(ctx, args.demoCommandId);
    const incidentBeforeLeaseCheck = await ctx.db.get(args.incidentId);
    if (
      !incidentBeforeLeaseCheck ||
      incidentBeforeLeaseCheck.demoCommandId !== command._id
    ) {
      rejectWithCode("INCIDENT_MISMATCH");
    }
    if (TERMINAL_STATES.has(incidentBeforeLeaseCheck.currentPhase)) {
      rejectWithCode("TERMINAL_STATE");
    }
    requireClaimedCommand(
      command,
      args.runnerId,
      args.expectedCommandStateVersion,
      now,
      ["failure_confirmed"],
    );
    const incident = await requireActiveIncident(
      ctx,
      command,
      args.incidentId,
      args.expectedStateVersion,
    );

    if (incident.currentPhase !== args.expectedPhase) {
      rejectWithCode("INVALID_STATE");
    }
    const changesPolicyDecision =
      args.incidentCategory !== undefined ||
      args.diagnosisEvidence !== undefined ||
      args.diagnosisSummary !== undefined ||
      args.confidence !== undefined ||
      args.requiresHuman !== undefined ||
      args.proposedActionId !== undefined;
    if (
      changesPolicyDecision &&
      (incident.currentPhase === "policy_check" ||
        incident.currentPhase === "executing" ||
        incident.currentPhase === "verifying")
    ) {
      rejectWithCode("POLICY_IMMUTABLE");
    }
    if (TERMINAL_STATES.has(args.nextPhase)) {
      rejectWithCode("TERMINAL_STATE");
    }
    if (!ALLOWED_NEXT_PHASES[incident.currentPhase].includes(args.nextPhase)) {
      rejectWithCode("INVALID_TRANSITION");
    }
    if (
      args.executionEvidence !== undefined &&
      args.nextPhase !== "verifying"
    ) {
      rejectWithCode("UNEXPECTED_EXECUTION_EVIDENCE");
    }

    if (args.confidence !== undefined) {
      if (!Number.isFinite(args.confidence) || args.confidence < 0 || args.confidence > 1) {
        rejectWithCode("INVALID_CONFIDENCE");
      }
    }

    if (
      args.nextPhase === "executing" ||
      args.nextPhase === "verifying"
    ) {
      if (
        !args.recoveryCommandId ||
        !args.executionNonce ||
        args.expectedRecoveryStateVersion === undefined
      ) {
        rejectWithCode("RECOVERY_COMMAND_REQUIRED");
      }
      const executionNonce = requireBoundedIdentifier(
        args.executionNonce,
        "execution_nonce",
      );
      const recovery = await ctx.db.get(args.recoveryCommandId);
      if (
        !recovery ||
        recovery.demoCommandId !== command._id ||
        recovery.incidentId !== incident._id ||
        recovery.runnerId !== args.runnerId ||
        recovery.executionNonce !== executionNonce
      ) {
        rejectWithCode("RECOVERY_MISMATCH");
      }
      if (recovery.stateVersion !== args.expectedRecoveryStateVersion) {
        rejectWithCode("STALE_STATE");
      }

      if (args.nextPhase === "executing") {
        if (args.executionEvidence !== undefined) {
          rejectWithCode("UNEXPECTED_EXECUTION_EVIDENCE");
        }
        if (recovery.status !== "allowed") {
          rejectWithCode("INVALID_RECOVERY_STATE");
        }
        await ctx.db.patch(recovery._id, {
          status: "executing",
          claimedAt: now,
          stateVersion: recovery.stateVersion + 1,
        });
      } else {
        const executionEvidence = args.executionEvidence;
        if (!executionEvidence) {
          rejectWithCode("EXECUTION_EVIDENCE_REQUIRED");
        }
        if (recovery.status !== "executing") {
          rejectWithCode("INVALID_RECOVERY_STATE");
        }
        const executionStartedAt = requireFiniteTimestamp(
          executionEvidence.startedAt,
          "execution_started_at",
        );
        const executionFinishedAt = requireFiniteTimestamp(
          executionEvidence.finishedAt,
          "execution_finished_at",
        );
        const executionLatencyMs = requireNonNegativeInteger(
          executionEvidence.latencyMs,
          "execution_latency_ms",
        );
        if (
          executionEvidence.commandLabel !== DEMO_RECOVERY_COMMAND_LABEL ||
          executionEvidence.exitCode !== 0 ||
          recovery.claimedAt === undefined ||
          executionStartedAt < recovery.claimedAt ||
          executionFinishedAt < executionStartedAt ||
          executionLatencyMs !==
            Math.floor(executionFinishedAt - executionStartedAt) ||
          executionFinishedAt > now + MAX_CLOCK_SKEW_MS
        ) {
          rejectWithCode("INVALID_EXECUTION_EVIDENCE");
        }
        await ctx.db.patch(recovery._id, {
          status: "executed",
          completedAt: now,
          executionCommandLabel: DEMO_RECOVERY_COMMAND_LABEL,
          executionExitCode: 0,
          executionStartedAt,
          executionFinishedAt,
          executionLatencyMs,
          executionEvidenceNonce: executionNonce,
          stateVersion: recovery.stateVersion + 1,
        });
      }
    }

    const reportedInputTokens =
      args.reportedInputTokens === undefined
        ? undefined
        : requireNonNegativeInteger(
            args.reportedInputTokens,
            "reported_input_tokens",
          );
    const reportedOutputTokens =
      args.reportedOutputTokens === undefined
        ? undefined
        : requireNonNegativeInteger(
            args.reportedOutputTokens,
            "reported_output_tokens",
          );
    const stateVersion = incident.stateVersion + 1;

    await ctx.db.patch(incident._id, {
      currentPhase: args.nextPhase,
      stateVersion,
      incidentCategory: args.incidentCategory
        ? sanitizeForPersistence(
            requireBoundedText(
              args.incidentCategory,
              "incident_category",
              120,
            ),
            120,
          )
        : incident.incidentCategory,
      diagnosisEvidence:
        args.diagnosisEvidence === undefined
          ? incident.diagnosisEvidence
          : sanitizeDiagnosisEvidence(args.diagnosisEvidence),
      diagnosisSummary: args.diagnosisSummary
        ? sanitizeForPersistence(
            requireBoundedText(
              args.diagnosisSummary,
              "diagnosis_summary",
              1_000,
            ),
            1_000,
          )
        : incident.diagnosisSummary,
      confidence: args.confidence ?? incident.confidence,
      requiresHuman: args.requiresHuman ?? incident.requiresHuman,
      proposedActionId: args.proposedActionId ?? incident.proposedActionId,
      reportedInputTokens:
        reportedInputTokens ?? incident.reportedInputTokens,
      reportedOutputTokens:
        reportedOutputTokens ?? incident.reportedOutputTokens,
      costStatus: args.costStatus ?? incident.costStatus,
    });
    await ctx.db.patch(command._id, {
      leaseExpiresAt: now + CLAIM_LEASE_MS,
    });

    return {
      stateVersion,
      recoveryStateVersion:
        args.expectedRecoveryStateVersion === undefined
          ? undefined
          : args.expectedRecoveryStateVersion + 1,
      recoveryCompletedAt:
        args.nextPhase === "verifying" ? now : undefined,
      leaseExpiresAt: now + CLAIM_LEASE_MS,
    };
  },
});

export const completeIncident = mutation({
  args: {
    runnerToken: v.string(),
    runnerId: v.string(),
    demoCommandId: v.id("demoCommands"),
    incidentId: v.id("incidents"),
    recoveryCommandId: v.optional(v.id("recoveryCommands")),
    executionNonce: v.optional(v.string()),
    expectedPhase: incidentPhase,
    expectedIncidentStateVersion: v.number(),
    expectedCommandStateVersion: v.number(),
    expectedRecoveryStateVersion: v.optional(v.number()),
    terminalState,
    finalHealth: v.string(),
    terminalReason: v.optional(v.string()),
    verification: v.optional(
      v.object({
        service: v.string(),
        status: v.string(),
        httpStatus: v.number(),
        requestStartedAt: v.number(),
        checkedAt: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    requireRunnerToken(args.runnerToken);
    requireDemoRunner(args.runnerId);

    const now = Date.now();
    const command = await requireCommand(ctx, args.demoCommandId);
    requireClaimedCommand(
      command,
      args.runnerId,
      args.expectedCommandStateVersion,
      now,
      ["failure_confirmed"],
    );
    const incident = await requireActiveIncident(
      ctx,
      command,
      args.incidentId,
      args.expectedIncidentStateVersion,
    );

    if (TERMINAL_STATES.has(incident.currentPhase)) {
      rejectWithCode("TERMINAL_STATE");
    }
    if (incident.currentPhase !== args.expectedPhase) {
      rejectWithCode("INVALID_STATE");
    }
    if (!ALLOWED_NEXT_PHASES[incident.currentPhase].includes(args.terminalState)) {
      rejectWithCode("INVALID_TRANSITION");
    }

    const storedRecovery = await ctx.db
      .query("recoveryCommands")
      .withIndex("by_incident", (q) => q.eq("incidentId", incident._id))
      .unique();
    if (storedRecovery && !args.recoveryCommandId) {
      rejectWithCode("RECOVERY_COMMAND_REQUIRED");
    }
    if (!storedRecovery && args.recoveryCommandId) {
      rejectWithCode("RECOVERY_MISMATCH");
    }

    const recovery: Doc<"recoveryCommands"> | null = storedRecovery;
    if (recovery) {
      const executionNonce = args.executionNonce
        ? requireBoundedIdentifier(args.executionNonce, "execution_nonce")
        : null;
      if (
        args.recoveryCommandId !== recovery._id ||
        recovery.demoCommandId !== command._id ||
        recovery.incidentId !== incident._id ||
        recovery.runnerId !== args.runnerId ||
        !executionNonce ||
        recovery.executionNonce !== executionNonce
      ) {
        rejectWithCode("RECOVERY_MISMATCH");
      }
      if (
        args.expectedRecoveryStateVersion === undefined ||
        recovery.stateVersion !== args.expectedRecoveryStateVersion
      ) {
        rejectWithCode("STALE_STATE");
      }
    } else if (
      args.executionNonce !== undefined ||
      args.expectedRecoveryStateVersion !== undefined
    ) {
      rejectWithCode("RECOVERY_MISMATCH");
    }
    if (
      (incident.currentPhase === "executing" ||
        incident.currentPhase === "verifying") &&
      !recovery
    ) {
      rejectWithCode("RECOVERY_COMMAND_REQUIRED");
    }

    if (args.terminalState === "resolved") {
      const verification = args.verification;
      const requestStartedAt = verification
        ? requireFiniteTimestamp(
            verification.requestStartedAt,
            "verification_request_started_at",
          )
        : undefined;
      const checkedAt = verification
        ? requireFiniteTimestamp(
            verification.checkedAt,
            "verification_checked_at",
          )
        : undefined;
      if (
        !recovery ||
        recovery.status !== "executed" ||
        recovery.completedAt === undefined ||
        recovery.executionCommandLabel !== DEMO_RECOVERY_COMMAND_LABEL ||
        recovery.executionExitCode !== 0 ||
        recovery.executionStartedAt === undefined ||
        recovery.executionFinishedAt === undefined ||
        recovery.executionLatencyMs === undefined ||
        recovery.executionEvidenceNonce !== recovery.executionNonce ||
        !verification ||
        args.finalHealth !== DEMO_HEALTHY_STATUS ||
        verification.service !== DEMO_SERVICE_IDENTITY ||
        verification.status !== DEMO_HEALTHY_STATUS ||
        verification.httpStatus !== 200 ||
        requestStartedAt === undefined ||
        checkedAt === undefined ||
        requestStartedAt < recovery.completedAt ||
        checkedAt < requestStartedAt ||
        checkedAt > now + MAX_CLOCK_SKEW_MS
      ) {
        rejectWithCode("VERIFICATION_FAILED");
      }
    }

    const finishedAt = now;
    const stateVersion = incident.stateVersion + 1;
    const finalHealth = sanitizeForPersistence(
      requireBoundedText(args.finalHealth, "final_health", 64),
      64,
    );
    const terminalReason = args.terminalReason
      ? sanitizeForPersistence(
          requireBoundedText(args.terminalReason, "terminal_reason", 500),
          500,
        )
      : args.terminalState;

    await ctx.db.patch(incident._id, {
      currentPhase: args.terminalState,
      finalHealth,
      finishedAt,
      totalLatencyMs: Math.max(0, finishedAt - incident.startedAt),
      terminalReason,
      stateVersion,
    });
    await ctx.db.patch(command._id, {
      status:
        args.terminalState === "resolved" ||
        args.terminalState === "needs_human"
          ? "complete"
          : "failed",
      finishedAt,
      leaseExpiresAt: undefined,
      stateVersion: command.stateVersion + 1,
    });

    if (recovery && args.terminalState !== "resolved") {
      await ctx.db.patch(recovery._id, {
        status:
          args.terminalState === "needs_human" ? "blocked" : "failed",
        completedAt: finishedAt,
        stateVersion: recovery.stateVersion + 1,
      });
    }

    const control = await getControl(ctx);
    if (control) {
      await ctx.db.patch(control._id, {
        activeDemoCommandId: undefined,
        activeIncidentId: undefined,
      });
    }

    return { stateVersion, terminalState: args.terminalState };
  },
});
