import { v } from "convex/values";

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
                : now > latestEnrollment.expiresAt
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
    codeDigest: v.string(),
    credentialDigest: v.string(),
    runnerId: v.string(),
    agentVersion: v.string(),
    architecture: runnerArchitecture,
  },
  handler: async (ctx, args) => {
    requireRunnerPairingRequestSecret(args.requestSecret);
    const codeDigest = requireDigest(args.codeDigest, "pairing_code_digest");
    const credentialDigest = requireDigest(
      args.credentialDigest,
      "runner_credential_digest",
    );
    const runnerId = requireBoundedIdentifier(args.runnerId, "runner_id");
    const agentVersion = requireAgentVersion(args.agentVersion);
    const now = Date.now();

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
      rejectWithCode("PAIRING_UNAVAILABLE");
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
      rejectWithCode("PAIRING_UNAVAILABLE");
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

    return { label: invite.label, pairedAt: now, runnerId };
  },
});

export const recordHeartbeat = mutation({
  args: {
    requestSecret: v.string(),
    runnerId: v.string(),
    credentialDigest: v.string(),
    agentVersion: v.string(),
  },
  handler: async (ctx, args) => {
    requireRunnerPairingRequestSecret(args.requestSecret);
    const runnerId = requireBoundedIdentifier(args.runnerId, "runner_id");
    const credentialDigest = requireDigest(
      args.credentialDigest,
      "runner_credential_digest",
    );
    const agentVersion = requireAgentVersion(args.agentVersion);
    const runner = await ctx.db
      .query("registeredRunners")
      .withIndex("by_runner_id", (q) => q.eq("runnerId", runnerId))
      .unique();
    if (
      !runner ||
      runner.revokedAt !== undefined ||
      runner.credentialDigest !== credentialDigest
    ) {
      rejectWithCode("RUNNER_UNAVAILABLE");
    }

    const now = Date.now();
    await ctx.db.patch(runner._id, { agentVersion, lastHeartbeatAt: now });
    return { heartbeatAt: now, runnerId };
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
