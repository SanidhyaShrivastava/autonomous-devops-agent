import { v } from "convex/values";

import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireUserId } from "./lib/auth";
import {
  rejectWithCode,
  requireBoundedIdentifier,
  requireBoundedText,
  requireRunnerPairingRequestSecret,
} from "./lib/guards";

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
          revokedAt: latestRunner.revokedAt ?? null,
        }
      : null;

    return { enrollment, runner };
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
    await ctx.db.patch(runner._id, { agentVersion, lastHeartbeatAt: now });
    return { status: "accepted" as const, heartbeatAt: now, runnerId };
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
    await ctx.db.patch(runner._id, { revokedAt });
    return { revokedAt, runnerId };
  },
});
