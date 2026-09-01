import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireUserId } from "./lib/auth";
import {
  rejectWithCode,
  requireBoundedIdentifier,
  requireBoundedText,
  requireRunnerPairingRequestSecret,
} from "./lib/guards";
import {
  CONNECTED_HEALTH_CHECK_ID,
  CONNECTED_RECOVERY_ACTION_ID,
  CONNECTED_RUNNER_CAPABILITY_ID,
  CONNECTED_WORKLOAD_ID,
} from "../src/lib/connected-runner-protocol";

const runnerArchitecture = v.union(
  v.literal("x64"),
  v.literal("arm64"),
);

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const AGENT_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
export const RUNNER_PAIRING_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const PAIR_ATTEMPT_LIMIT = 10;
const HEARTBEAT_IP_LIMIT = 120;
const HEARTBEAT_RUNNER_LIMIT = 45;
const HEARTBEAT_INVALID_RUNNER_LIMIT = 45;
export const MAX_RUNNER_RATE_LIMIT_BUCKETS = 256;
export const CONNECTED_RUNNER_FRESHNESS_MS = 6_000;
export const CONNECTED_HEALTH_FRESHNESS_MS = 8_000;
export const CONNECTED_APPROVAL_WINDOW_MS = 5 * 60_000;
export const CONNECTED_APPROVED_WINDOW_MS = 30_000;
export const CONNECTED_CLAIM_LEASE_MS = 15_000;
export const CONNECTED_WATCHDOG_BATCH_SIZE = 25;

const connectedHealthDetailCode = v.union(
  v.literal("exact_http_200"),
  v.literal("connection_failed"),
  v.literal("request_timeout"),
  v.literal("unexpected_response"),
);

const connectedHealthReport = v.object({
  workloadId: v.literal(CONNECTED_WORKLOAD_ID),
  healthCheckId: v.literal(CONNECTED_HEALTH_CHECK_ID),
  healthStatus: v.union(v.literal("healthy"), v.literal("unhealthy")),
  detailCode: connectedHealthDetailCode,
  instanceId: v.optional(v.string()),
});

const connectedCommandResult = v.object({
  commandId: v.id("runnerRecoveryRequests"),
  executionNonce: v.string(),
  actionId: v.literal(CONNECTED_RECOVERY_ACTION_ID),
  executionResultCode: v.union(
    v.literal("restart_succeeded"),
    v.literal("restart_failed"),
  ),
  verificationStatus: v.union(v.literal("healthy"), v.literal("unhealthy")),
  verificationDetailCode: connectedHealthDetailCode,
  postActionInstanceId: v.optional(v.string()),
});

const ACTIVE_RECOVERY_STATUSES: ReadonlySet<string> = new Set([
  "pending_approval",
  "approved",
  "claimed",
]);

function connectedWorkloadDto(workload: Doc<"managedWorkloads">) {
  return {
    workloadId: workload.workloadId,
    healthCheckId: workload.healthCheckId,
    recoveryActionId: workload.recoveryActionId,
    recoveryMode: workload.recoveryMode,
    healthStatus: workload.healthStatus,
    healthDetailCode: workload.healthDetailCode,
    healthReportedAt: workload.healthReportedAt ?? null,
    currentInstanceId:
      workload.healthStatus === "healthy"
        ? (workload.lastHealthyInstanceId ?? null)
        : null,
    lastHealthyInstanceId: workload.lastHealthyInstanceId ?? null,
    registeredAt: workload.registeredAt,
  };
}

function connectedRecoveryDto(recovery: Doc<"runnerRecoveryRequests">) {
  return {
    commandId: recovery._id,
    actionId: recovery.actionId,
    status: recovery.status,
    createdAt: recovery.createdAt,
    deadlineAt: recovery.deadlineAt,
    approvedAt: recovery.approvedAt ?? null,
    claimedAt: recovery.claimedAt ?? null,
    executionResultCode: recovery.executionResultCode ?? null,
    verificationStatus: recovery.verificationStatus ?? null,
    verificationDetailCode: recovery.verificationDetailCode ?? null,
    preActionInstanceId: recovery.preActionInstanceId,
    postActionInstanceId: recovery.postActionInstanceId ?? null,
    terminalReason: recovery.terminalReason ?? null,
    finishedAt: recovery.finishedAt ?? null,
    stateVersion: recovery.stateVersion,
  };
}

function requireFixedHealthEvidence(
  report: {
    healthStatus: "healthy" | "unhealthy";
    detailCode:
      | "exact_http_200"
      | "connection_failed"
      | "request_timeout"
      | "unexpected_response";
    instanceId?: string;
  },
  label: "health" | "verification",
) {
  const exactHealthy =
    report.healthStatus === "healthy" &&
    report.detailCode === "exact_http_200" &&
    report.instanceId !== undefined &&
    /^[A-Za-z0-9_-]{1,128}$/.test(report.instanceId);
  const exactUnhealthy =
    report.healthStatus === "unhealthy" &&
    report.detailCode !== "exact_http_200" &&
    report.instanceId === undefined;
  if (!exactHealthy && !exactUnhealthy) {
    rejectWithCode(`INVALID_CONNECTED_${label.toUpperCase()}_EVIDENCE`);
  }
}

function runnerIsFresh(runner: Doc<"registeredRunners">, now: number) {
  return Boolean(
    runner.revokedAt === undefined &&
      runner.lastHeartbeatAt !== undefined &&
      now - runner.lastHeartbeatAt < CONNECTED_RUNNER_FRESHNESS_MS,
  );
}

function capabilityIsFresh(runner: Doc<"registeredRunners">, now: number) {
  return Boolean(
    runner.capabilityId === CONNECTED_RUNNER_CAPABILITY_ID &&
      runner.capabilityReportedAt !== undefined &&
      now - runner.capabilityReportedAt < CONNECTED_RUNNER_FRESHNESS_MS,
  );
}

function workloadHealthIsFresh(
  workload: Doc<"managedWorkloads">,
  now: number,
) {
  return Boolean(
    workload.healthReportedAt !== undefined &&
      now - workload.healthReportedAt < CONNECTED_HEALTH_FRESHNESS_MS,
  );
}

async function activeRunnerForOwner(ctx: MutationCtx, ownerId: Id<"users">) {
  return (
    await ctx.db
      .query("registeredRunners")
      .withIndex("by_owner_paired_at", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .collect()
  ).find((runner) => runner.revokedAt === undefined);
}

async function workloadForRunnerRecord(
  ctx: MutationCtx,
  runnerRecordId: Id<"registeredRunners">,
) {
  return await ctx.db
    .query("managedWorkloads")
    .withIndex("by_runner_record", (q) =>
      q.eq("runnerRecordId", runnerRecordId),
    )
    .unique();
}

function requireDigest(value: string, label: string) {
  if (!DIGEST_PATTERN.test(value)) {
    rejectWithCode(`INVALID_${label.toUpperCase()}`);
  }
  return value;
}

function requireAgentVersion(value: string) {
  if (!AGENT_VERSION_PATTERN.test(value)) {
    rejectWithCode("INVALID_AGENT_VERSION");
  }
  return value;
}

type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

async function removeExpiredRateLimitBuckets(ctx: MutationCtx, now: number) {
  const expired = await ctx.db
    .query("runnerRateLimitBuckets")
    .withIndex("by_expires_at", (q) => q.lte("expiresAt", now))
    .take(32);
  for (const bucket of expired) {
    await ctx.db.delete(bucket._id);
  }
  return expired.length;
}

async function rateLimitControl(ctx: MutationCtx) {
  const existing = await ctx.db
    .query("runnerRateLimitControl")
    .withIndex("by_key", (q) => q.eq("key", "singleton"))
    .unique();
  if (existing) return existing;
  const id = await ctx.db.insert("runnerRateLimitControl", {
    key: "singleton",
    bucketCount: 0,
    capacityDeniedCount: 0,
  });
  const created = await ctx.db.get(id);
  if (!created) throw new Error("Rate limit control unavailable");
  return created;
}

async function consumeRateLimitBucket(
  ctx: MutationCtx,
  args: { bucketKey: string; limit: number; now: number },
): Promise<RateLimitResult> {
  const existing = await ctx.db
    .query("runnerRateLimitBuckets")
    .withIndex("by_bucket_key", (q) => q.eq("bucketKey", args.bucketKey))
    .unique();

  if (existing) {
    if (args.now >= existing.expiresAt) {
      await ctx.db.patch(existing._id, {
        count: 1,
        deniedCount: 0,
        expiresAt: args.now + RATE_LIMIT_WINDOW_MS,
        failedCount: 0,
        windowStartedAt: args.now,
      });
      return { allowed: true };
    }
    if (existing.count >= args.limit) {
      await ctx.db.patch(existing._id, {
        deniedCount: existing.deniedCount + 1,
      });
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((existing.expiresAt - args.now) / 1_000),
        ),
      };
    }
    await ctx.db.patch(existing._id, { count: existing.count + 1 });
    return { allowed: true };
  }

  const control = await rateLimitControl(ctx);
  let bucketCount = control.bucketCount;
  if (bucketCount >= MAX_RUNNER_RATE_LIMIT_BUCKETS) {
    const removed = await removeExpiredRateLimitBuckets(ctx, args.now);
    bucketCount -= removed;
  }
  if (bucketCount >= MAX_RUNNER_RATE_LIMIT_BUCKETS) {
    await ctx.db.patch(control._id, {
      capacityDeniedCount: (control.capacityDeniedCount ?? 0) + 1,
    });
    return { allowed: false, retryAfterSeconds: 60 };
  }

  await ctx.db.insert("runnerRateLimitBuckets", {
    bucketKey: args.bucketKey,
    count: 1,
    deniedCount: 0,
    expiresAt: args.now + RATE_LIMIT_WINDOW_MS,
    failedCount: 0,
    windowStartedAt: args.now,
  });
  await ctx.db.patch(control._id, { bucketCount: bucketCount + 1 });
  return { allowed: true };
}

async function recordRateLimitFailure(ctx: MutationCtx, bucketKey: string) {
  const bucket = await ctx.db
    .query("runnerRateLimitBuckets")
    .withIndex("by_bucket_key", (q) => q.eq("bucketKey", bucketKey))
    .unique();
  if (bucket) {
    await ctx.db.patch(bucket._id, { failedCount: bucket.failedCount + 1 });
  }
}

export const createEnrollment = mutation({
  args: {
    codeDigest: v.string(),
    label: v.string(),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const codeDigest = requireDigest(args.codeDigest, "pairing_code_digest");
    const label = requireBoundedText(args.label, "runner_label", 48);
    if (Array.from(label).length < 2) {
      rejectWithCode("INVALID_RUNNER_LABEL");
    }

    const activeRunner = (
      await ctx.db
        .query("registeredRunners")
        .withIndex("by_owner_paired_at", (q) => q.eq("ownerId", ownerId))
        .order("desc")
        .collect()
    ).find((runner) => runner.revokedAt === undefined);
    if (activeRunner) {
      rejectWithCode("RUNNER_ALREADY_CONNECTED");
    }

    const reusedDigest = await ctx.db
      .query("runnerPairingInvites")
      .withIndex("by_code_digest", (q) => q.eq("codeDigest", codeDigest))
      .unique();
    if (reusedDigest) {
      rejectWithCode("PAIRING_CODE_REUSED");
    }

    const now = Date.now();
    const previousInvites = await ctx.db
      .query("runnerPairingInvites")
      .withIndex("by_owner_created_at", (q) => q.eq("ownerId", ownerId))
      .collect();
    for (const invite of previousInvites) {
      if (invite.consumedAt === undefined && invite.cancelledAt === undefined) {
        await ctx.db.patch(invite._id, { cancelledAt: now });
      }
    }

    const enrollmentId = await ctx.db.insert("runnerPairingInvites", {
      ownerId,
      label,
      codeDigest,
      createdAt: now,
      expiresAt: now + RUNNER_PAIRING_WINDOW_MS,
    });

    return {
      enrollmentId,
      expiresAt: now + RUNNER_PAIRING_WINDOW_MS,
    };
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const [latestEnrollment, latestRunner] = await Promise.all([
      ctx.db
        .query("runnerPairingInvites")
        .withIndex("by_owner_created_at", (q) => q.eq("ownerId", ownerId))
        .order("desc")
        .first(),
      ctx.db
        .query("registeredRunners")
        .withIndex("by_owner_paired_at", (q) => q.eq("ownerId", ownerId))
        .order("desc")
        .first(),
    ]);

    const now = Date.now();
    const enrollment = latestEnrollment
      ? {
          enrollmentId: latestEnrollment._id,
          label: latestEnrollment.label,
          createdAt: latestEnrollment.createdAt,
          expiresAt: latestEnrollment.expiresAt,
          state:
            latestEnrollment.consumedAt !== undefined
              ? ("consumed" as const)
              : latestEnrollment.cancelledAt !== undefined
                ? ("cancelled" as const)
                : now >= latestEnrollment.expiresAt
                  ? ("expired" as const)
                  : ("waiting" as const),
        }
      : null;

    const runner = latestRunner
      ? {
          runnerId: latestRunner.runnerId,
          label: latestRunner.label,
          osFamily: latestRunner.osFamily,
          architecture: latestRunner.architecture,
          agentVersion: latestRunner.agentVersion,
          pairedAt: latestRunner.pairedAt,
          lastHeartbeatAt: latestRunner.lastHeartbeatAt ?? null,
          capabilityId: latestRunner.capabilityId ?? null,
          capabilityReportedAt: latestRunner.capabilityReportedAt ?? null,
          revokedAt: latestRunner.revokedAt ?? null,
        }
      : null;

    const workload = latestRunner
      ? await ctx.db
          .query("managedWorkloads")
          .withIndex("by_runner_record", (q) =>
            q.eq("runnerRecordId", latestRunner._id),
          )
          .unique()
      : null;
    const latestRecovery = workload
      ? await ctx.db
          .query("runnerRecoveryRequests")
          .withIndex("by_workload_created_at", (q) =>
            q.eq("workloadRecordId", workload._id),
          )
          .order("desc")
          .first()
      : null;

    return {
      enrollment,
      runner,
      workload: workload ? connectedWorkloadDto(workload) : null,
      latestRecovery: latestRecovery
        ? connectedRecoveryDto(latestRecovery)
        : null,
    };
  },
});

export const registerFixedWorkload = mutation({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const now = Date.now();
    const runner = await activeRunnerForOwner(ctx, ownerId);
    if (
      !runner ||
      !runnerIsFresh(runner, now) ||
      !capabilityIsFresh(runner, now)
    ) {
      rejectWithCode("FIXED_CAPABILITY_UNAVAILABLE");
    }

    const existing = await workloadForRunnerRecord(ctx, runner._id);
    if (existing) return connectedWorkloadDto(existing);

    const workloadRecordId = await ctx.db.insert("managedWorkloads", {
      ownerId,
      runnerRecordId: runner._id,
      runnerId: runner.runnerId,
      workloadId: CONNECTED_WORKLOAD_ID,
      healthCheckId: CONNECTED_HEALTH_CHECK_ID,
      recoveryActionId: CONNECTED_RECOVERY_ACTION_ID,
      recoveryMode: "approval_required",
      registeredAt: now,
      healthStatus: "unknown",
      healthDetailCode: "not_reported",
      stateVersion: 0,
    });
    const workload = await ctx.db.get(workloadRecordId);
    if (!workload) throw new Error("Connected workload unavailable");
    return connectedWorkloadDto(workload);
  },
});

export const requestFixedRecovery = mutation({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const now = Date.now();
    const runner = await activeRunnerForOwner(ctx, ownerId);
    if (
      !runner ||
      !runnerIsFresh(runner, now) ||
      !capabilityIsFresh(runner, now)
    ) {
      rejectWithCode("RUNNER_OR_HEALTH_STALE");
    }

    const workload = await workloadForRunnerRecord(ctx, runner._id);
    if (
      !workload ||
      workload.healthStatus !== "unhealthy" ||
      workload.lastHealthyInstanceId === undefined
    ) {
      rejectWithCode("UNHEALTHY_REPORT_REQUIRED");
    }
    if (!workloadHealthIsFresh(workload, now)) {
      rejectWithCode("RUNNER_OR_HEALTH_STALE");
    }

    const latest = await ctx.db
      .query("runnerRecoveryRequests")
      .withIndex("by_workload_created_at", (q) =>
        q.eq("workloadRecordId", workload._id),
      )
      .order("desc")
      .first();
    if (latest && ACTIVE_RECOVERY_STATUSES.has(latest.status)) {
      rejectWithCode("RECOVERY_ALREADY_ACTIVE");
    }

    const commandId = await ctx.db.insert("runnerRecoveryRequests", {
      ownerId,
      workloadRecordId: workload._id,
      runnerRecordId: runner._id,
      runnerId: runner.runnerId,
      workloadId: CONNECTED_WORKLOAD_ID,
      actionId: CONNECTED_RECOVERY_ACTION_ID,
      status: "pending_approval",
      createdAt: now,
      deadlineAt: now + CONNECTED_APPROVAL_WINDOW_MS,
      preActionInstanceId: workload.lastHealthyInstanceId,
      stateVersion: 0,
    });
    const recovery = await ctx.db.get(commandId);
    if (!recovery) throw new Error("Recovery request unavailable");
    return connectedRecoveryDto(recovery);
  },
});

export const decideFixedRecovery = mutation({
  args: {
    commandId: v.id("runnerRecoveryRequests"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const recovery = await ctx.db.get(args.commandId);
    if (!recovery || recovery.ownerId !== ownerId) {
      rejectWithCode("RECOVERY_NOT_FOUND");
    }
    if (recovery.status !== "pending_approval") {
      rejectWithCode("RECOVERY_NOT_PENDING");
    }

    const now = Date.now();
    if (recovery.deadlineAt <= now) {
      await ctx.db.patch(recovery._id, {
        status: "expired",
        terminalReason: "approval_expired",
        finishedAt: now,
        stateVersion: recovery.stateVersion + 1,
      });
      const expired = await ctx.db.get(recovery._id);
      if (!expired) throw new Error("Recovery request unavailable");
      return connectedRecoveryDto(expired);
    }

    if (args.decision === "rejected") {
      await ctx.db.patch(recovery._id, {
        status: "rejected",
        approvalDecidedAt: now,
        terminalReason: "owner_rejected",
        finishedAt: now,
        stateVersion: recovery.stateVersion + 1,
      });
    } else {
      const [runner, workload] = await Promise.all([
        ctx.db.get(recovery.runnerRecordId),
        ctx.db.get(recovery.workloadRecordId),
      ]);
      if (
        !runner ||
        !workload ||
        !runnerIsFresh(runner, now) ||
        !capabilityIsFresh(runner, now) ||
        !workloadHealthIsFresh(workload, now) ||
        workload.healthStatus !== "unhealthy" ||
        workload.lastHealthyInstanceId !== recovery.preActionInstanceId
      ) {
        rejectWithCode("RUNNER_OR_HEALTH_STALE");
      }
      await ctx.db.patch(recovery._id, {
        status: "approved",
        approvalDecidedAt: now,
        approvedAt: now,
        deadlineAt: now + CONNECTED_APPROVED_WINDOW_MS,
        stateVersion: recovery.stateVersion + 1,
      });
    }

    const updated = await ctx.db.get(recovery._id);
    if (!updated) throw new Error("Recovery request unavailable");
    return connectedRecoveryDto(updated);
  },
});

export const pairRunner = mutation({
  args: {
    requestSecret: v.string(),
    clientAddressDigest: v.string(),
    codeDigest: v.string(),
    credentialDigest: v.string(),
    runnerId: v.string(),
    agentVersion: v.string(),
    architecture: runnerArchitecture,
  },
  handler: async (ctx, args) => {
    requireRunnerPairingRequestSecret(args.requestSecret);
    const clientAddressDigest = requireDigest(
      args.clientAddressDigest,
      "client_address_digest",
    );
    const codeDigest = requireDigest(args.codeDigest, "pairing_code_digest");
    const credentialDigest = requireDigest(
      args.credentialDigest,
      "runner_credential_digest",
    );
    const runnerId = requireBoundedIdentifier(args.runnerId, "runner_id");
    const agentVersion = requireAgentVersion(args.agentVersion);
    const now = Date.now();

    const pairBucketKey = `pair_ip:${clientAddressDigest}`;
    const rateLimit = await consumeRateLimitBucket(ctx, {
      bucketKey: pairBucketKey,
      limit: PAIR_ATTEMPT_LIMIT,
      now,
    });
    if (!rateLimit.allowed) {
      return {
        status: "rate_limited" as const,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      };
    }

    const invite = await ctx.db
      .query("runnerPairingInvites")
      .withIndex("by_code_digest", (q) => q.eq("codeDigest", codeDigest))
      .unique();
    if (
      !invite ||
      invite.consumedAt !== undefined ||
      invite.cancelledAt !== undefined ||
      now >= invite.expiresAt
    ) {
      await recordRateLimitFailure(ctx, pairBucketKey);
      return { status: "unavailable" as const };
    }

    const existingRunnerId = await ctx.db
      .query("registeredRunners")
      .withIndex("by_runner_id", (q) => q.eq("runnerId", runnerId))
      .unique();
    const ownerAlreadyConnected = (
      await ctx.db
        .query("registeredRunners")
        .withIndex("by_owner_paired_at", (q) =>
          q.eq("ownerId", invite.ownerId),
        )
        .collect()
    ).some((runner) => runner.revokedAt === undefined);
    if (existingRunnerId || ownerAlreadyConnected) {
      await recordRateLimitFailure(ctx, pairBucketKey);
      return { status: "unavailable" as const };
    }

    const runnerRecordId = await ctx.db.insert("registeredRunners", {
      ownerId: invite.ownerId,
      enrollmentId: invite._id,
      runnerId,
      label: invite.label,
      credentialDigest,
      osFamily: "linux",
      architecture: args.architecture,
      agentVersion,
      pairedAt: now,
    });
    await ctx.db.patch(invite._id, {
      consumedAt: now,
      runnerRecordId,
    });

    return {
      status: "paired" as const,
      label: invite.label,
      pairedAt: now,
      runnerId,
    };
  },
});

export const recordHeartbeat = mutation({
  args: {
    requestSecret: v.string(),
    clientAddressDigest: v.string(),
    runnerId: v.string(),
    credentialDigest: v.string(),
    agentVersion: v.string(),
    capabilityId: v.optional(v.literal(CONNECTED_RUNNER_CAPABILITY_ID)),
    healthReport: v.optional(connectedHealthReport),
    previousCommandResult: v.optional(connectedCommandResult),
  },
  handler: async (ctx, args) => {
    requireRunnerPairingRequestSecret(args.requestSecret);
    const clientAddressDigest = requireDigest(
      args.clientAddressDigest,
      "client_address_digest",
    );
    const runnerId = requireBoundedIdentifier(args.runnerId, "runner_id");
    const credentialDigest = requireDigest(
      args.credentialDigest,
      "runner_credential_digest",
    );
    const agentVersion = requireAgentVersion(args.agentVersion);
    const now = Date.now();
    const ipBucketKey = `heartbeat_ip:${clientAddressDigest}`;
    const ipRateLimit = await consumeRateLimitBucket(ctx, {
      bucketKey: ipBucketKey,
      limit: HEARTBEAT_IP_LIMIT,
      now,
    });
    if (!ipRateLimit.allowed) {
      return {
        status: "rate_limited" as const,
        retryAfterSeconds: ipRateLimit.retryAfterSeconds,
      };
    }
    const runner = await ctx.db
      .query("registeredRunners")
      .withIndex("by_runner_id", (q) => q.eq("runnerId", runnerId))
      .unique();
    if (!runner) {
      await recordRateLimitFailure(ctx, ipBucketKey);
      return { status: "unavailable" as const };
    }

    if (
      runner.revokedAt !== undefined ||
      runner.credentialDigest !== credentialDigest
    ) {
      await recordRateLimitFailure(ctx, ipBucketKey);
      const invalidRunnerBucketKey = `heartbeat_runner_invalid:${runnerId}`;
      const invalidRunnerRateLimit = await consumeRateLimitBucket(ctx, {
        bucketKey: invalidRunnerBucketKey,
        limit: HEARTBEAT_INVALID_RUNNER_LIMIT,
        now,
      });
      if (!invalidRunnerRateLimit.allowed) {
        return {
          status: "rate_limited" as const,
          retryAfterSeconds: invalidRunnerRateLimit.retryAfterSeconds,
        };
      }
      await recordRateLimitFailure(ctx, invalidRunnerBucketKey);
      return { status: "unavailable" as const };
    }

    const runnerRateLimit = await consumeRateLimitBucket(ctx, {
      bucketKey: `heartbeat_runner:${runnerId}`,
      limit: HEARTBEAT_RUNNER_LIMIT,
      now,
    });
    if (!runnerRateLimit.allowed) {
      return {
        status: "rate_limited" as const,
        retryAfterSeconds: runnerRateLimit.retryAfterSeconds,
      };
    }
    await ctx.db.patch(runner._id, {
      agentVersion,
      lastHeartbeatAt: now,
      ...(args.capabilityId
        ? {
            capabilityId: args.capabilityId,
            capabilityReportedAt: now,
          }
        : {}),
    });

    let workload = await workloadForRunnerRecord(ctx, runner._id);

    if (args.previousCommandResult) {
      const result = args.previousCommandResult;
      requireFixedHealthEvidence(
        {
          healthStatus: result.verificationStatus,
          detailCode: result.verificationDetailCode,
          instanceId: result.postActionInstanceId,
        },
        "verification",
      );
      const recovery = await ctx.db.get(result.commandId);
      if (
        !recovery ||
        !workload ||
        recovery.runnerRecordId !== runner._id ||
        recovery.workloadRecordId !== workload._id ||
        recovery.actionId !== result.actionId
      ) {
        rejectWithCode("COMMAND_RESULT_UNAVAILABLE");
      }

      if (!ACTIVE_RECOVERY_STATUSES.has(recovery.status)) {
        // A repeated or late result must not reopen a terminal recovery.
      } else {
        if (
          recovery.status !== "claimed" ||
          recovery.executionNonce !== result.executionNonce
        ) {
          rejectWithCode("COMMAND_RESULT_UNAVAILABLE");
        }

        const verifiedNewInstance =
          result.executionResultCode === "restart_succeeded" &&
          result.verificationStatus === "healthy" &&
          result.verificationDetailCode === "exact_http_200" &&
          result.postActionInstanceId !== undefined &&
          result.postActionInstanceId !== recovery.preActionInstanceId;
        const terminalStatus = verifiedNewInstance ? "succeeded" : "failed";
        const terminalReason = verifiedNewInstance
          ? undefined
          : result.executionResultCode === "restart_failed"
            ? ("execution_failed" as const)
            : ("verification_failed" as const);

        await ctx.db.patch(recovery._id, {
          status: terminalStatus,
          executionResultCode: result.executionResultCode,
          verificationStatus: result.verificationStatus,
          verificationDetailCode: result.verificationDetailCode,
          ...(result.postActionInstanceId
            ? { postActionInstanceId: result.postActionInstanceId }
            : {}),
          ...(terminalReason ? { terminalReason } : {}),
          finishedAt: now,
          stateVersion: recovery.stateVersion + 1,
        });
      }
    }

    if (args.healthReport && workload) {
      requireFixedHealthEvidence(args.healthReport, "health");
      await ctx.db.patch(workload._id, {
        healthStatus: args.healthReport.healthStatus,
        healthDetailCode: args.healthReport.detailCode,
        healthReportedAt: now,
        ...(args.healthReport.healthStatus === "healthy"
          ? { lastHealthyInstanceId: args.healthReport.instanceId }
          : {}),
        stateVersion: workload.stateVersion + 1,
      });
      const updatedWorkload = await ctx.db.get(workload._id);
      if (!updatedWorkload) throw new Error("Connected workload unavailable");
      workload = updatedWorkload;
    }

    let command: {
      commandId: Id<"runnerRecoveryRequests">;
      executionNonce: string;
      workloadId: typeof CONNECTED_WORKLOAD_ID;
      actionId: typeof CONNECTED_RECOVERY_ACTION_ID;
    } | null = null;

    if (
      workload &&
      args.healthReport &&
      args.capabilityId === CONNECTED_RUNNER_CAPABILITY_ID
    ) {
      const approved = await ctx.db
        .query("runnerRecoveryRequests")
        .withIndex("by_runner_status_created_at", (q) =>
          q
            .eq("runnerId", runner.runnerId)
            .eq("status", "approved"),
        )
        .order("asc")
        .first();

      if (approved && approved.workloadRecordId === workload._id) {
        if (approved.deadlineAt <= now) {
          await ctx.db.patch(approved._id, {
            status: "expired",
            terminalReason: "command_expired",
            finishedAt: now,
            stateVersion: approved.stateVersion + 1,
          });
        } else if (args.healthReport.healthStatus === "healthy") {
          await ctx.db.patch(approved._id, {
            status: "not_needed",
            terminalReason: "precondition_changed",
            finishedAt: now,
            stateVersion: approved.stateVersion + 1,
          });
        } else if (
          workload.healthStatus === "unhealthy" &&
          workloadHealthIsFresh(workload, now)
        ) {
          if (
            workload.lastHealthyInstanceId !== approved.preActionInstanceId
          ) {
            await ctx.db.patch(approved._id, {
              status: "not_needed",
              terminalReason: "precondition_changed",
              finishedAt: now,
              stateVersion: approved.stateVersion + 1,
            });
          } else {
            const executionNonce = `execution_${String(approved._id).replace(
              /[^A-Za-z0-9_-]/g,
              "_",
            )}_${approved.stateVersion + 1}`.slice(0, 128);
            const leaseExpiresAt = now + CONNECTED_CLAIM_LEASE_MS;
            await ctx.db.patch(approved._id, {
              status: "claimed",
              claimedAt: now,
              leaseExpiresAt,
              deadlineAt: leaseExpiresAt,
              executionNonce,
              stateVersion: approved.stateVersion + 1,
            });
            command = {
              commandId: approved._id,
              executionNonce,
              workloadId: CONNECTED_WORKLOAD_ID,
              actionId: CONNECTED_RECOVERY_ACTION_ID,
            };
          }
        }
      }
    }

    return {
      status: "accepted" as const,
      heartbeatAt: now,
      runnerId,
      heartbeatIntervalMs: 2_000 as const,
      workloadRegistered: workload !== null,
      command,
    };
  },
});

export const revoke = mutation({
  args: { runnerId: v.string() },
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const runnerId = requireBoundedIdentifier(args.runnerId, "runner_id");
    const runner = await ctx.db
      .query("registeredRunners")
      .withIndex("by_runner_id", (q) => q.eq("runnerId", runnerId))
      .unique();
    if (!runner || runner.ownerId !== ownerId || runner.revokedAt !== undefined) {
      rejectWithCode("RUNNER_NOT_FOUND");
    }

    const revokedAt = Date.now();
    for (const status of [
      "pending_approval",
      "approved",
      "claimed",
    ] as const) {
      const activeRecoveries = await ctx.db
        .query("runnerRecoveryRequests")
        .withIndex("by_runner_status_created_at", (q) =>
          q.eq("runnerId", runner.runnerId).eq("status", status),
        )
        .collect();
      for (const recovery of activeRecoveries) {
        await ctx.db.patch(recovery._id, {
          status: status === "claimed" ? "execution_unknown" : "expired",
          terminalReason:
            status === "claimed"
              ? "runner_revoked_after_claim"
              : "runner_revoked_before_claim",
          finishedAt: revokedAt,
          stateVersion: recovery.stateVersion + 1,
        });
      }
    }
    await ctx.db.patch(runner._id, { revokedAt });
    return { revokedAt, runnerId };
  },
});

export const watchFixedRecoveryCommands = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let processed = 0;

    for (const status of [
      "pending_approval",
      "approved",
      "claimed",
    ] as const) {
      const remaining = CONNECTED_WATCHDOG_BATCH_SIZE - processed;
      if (remaining <= 0) break;
      const expired = await ctx.db
        .query("runnerRecoveryRequests")
        .withIndex("by_status_deadline", (q) =>
          q.eq("status", status).lte("deadlineAt", now),
        )
        .take(remaining);

      for (const recovery of expired) {
        await ctx.db.patch(recovery._id, {
          status: status === "claimed" ? "execution_unknown" : "expired",
          terminalReason:
            status === "pending_approval"
              ? "approval_expired"
              : status === "approved"
                ? "command_expired"
                : "runner_lost_during_action",
          finishedAt: now,
          stateVersion: recovery.stateVersion + 1,
        });
        processed += 1;
      }
    }

    return { processed };
  },
});
