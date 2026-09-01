import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

const demoCommandStatus = v.union(
  v.literal("queued"),
  v.literal("claimed"),
  v.literal("reset_applied"),
  v.literal("failure_confirmed"),
  v.literal("complete"),
  v.literal("expired"),
  v.literal("failed"),
);

const executionMode = v.union(
  v.literal("autonomous"),
  v.literal("approval_required"),
);

const approvalStatus = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("expired"),
);

const incidentPhase = v.union(
  v.literal("failed_detected"),
  v.literal("investigating"),
  v.literal("manager_review"),
  v.literal("policy_check"),
  v.literal("awaiting_approval"),
  v.literal("executing"),
  v.literal("verifying"),
  v.literal("resolved"),
  v.literal("needs_human"),
  v.literal("failed_recovery"),
  v.literal("investigation_failed"),
);

const incidentStatus = v.union(
  v.literal("active"),
  v.literal("resolved"),
  v.literal("failed"),
  v.literal("needs_human"),
);

const environmentRecoveryStatus = v.union(
  v.literal("pending"),
  v.literal("restoring"),
  v.literal("restored"),
);

const recoveryCommandStatus = v.union(
  v.literal("proposed"),
  v.literal("allowed"),
  v.literal("executing"),
  v.literal("executed"),
  v.literal("blocked"),
  v.literal("failed"),
);

const agentRole = v.union(
  v.literal("incident_manager"),
  v.literal("investigator"),
  v.literal("recovery_planner"),
  v.literal("policy_gate"),
  v.literal("human_operator"),
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

const runnerArchitecture = v.union(
  v.literal("x64"),
  v.literal("arm64"),
);

export default defineSchema({
  ...authTables,

  setupChecks: defineTable({
    label: v.string(),
    createdAt: v.number(),
  }),

  runnerPairingInvites: defineTable({
    ownerId: v.id("users"),
    label: v.string(),
    codeDigest: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    runnerRecordId: v.optional(v.id("registeredRunners")),
  })
    .index("by_code_digest", ["codeDigest"])
    .index("by_owner_created_at", ["ownerId", "createdAt"]),

  registeredRunners: defineTable({
    ownerId: v.id("users"),
    enrollmentId: v.id("runnerPairingInvites"),
    runnerId: v.string(),
    label: v.string(),
    credentialDigest: v.string(),
    osFamily: v.literal("linux"),
    architecture: runnerArchitecture,
    agentVersion: v.string(),
    pairedAt: v.number(),
    lastHeartbeatAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_runner_id", ["runnerId"])
    .index("by_owner_paired_at", ["ownerId", "pairedAt"]),

  runnerRateLimitBuckets: defineTable({
    bucketKey: v.string(),
    count: v.number(),
    failedCount: v.number(),
    deniedCount: v.number(),
    windowStartedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_bucket_key", ["bucketKey"])
    .index("by_expires_at", ["expiresAt"]),

  runnerRateLimitControl: defineTable({
    key: v.literal("singleton"),
    bucketCount: v.number(),
    capacityDeniedCount: v.optional(v.number()),
  }).index("by_key", ["key"]),

  demoControl: defineTable({
    key: v.literal("singleton"),
    enabled: v.boolean(),
    activeDemoCommandId: v.optional(v.id("demoCommands")),
    activeIncidentId: v.optional(v.id("incidents")),
    lastRequestedAt: v.optional(v.number()),
    dayKey: v.string(),
    dayCount: v.number(),
    runnerHeartbeatAt: v.optional(v.number()),
    environmentRecoveryIncidentId: v.optional(v.id("incidents")),
  }).index("by_key", ["key"]),

  demoCommands: defineTable({
    kind: v.literal("RESET_DEMO_V1"),
    status: demoCommandStatus,
    createdAt: v.number(),
    expiresAt: v.number(),
    claimedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    runnerId: v.optional(v.string()),
    claimNonce: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    stateVersion: v.number(),
    idempotencyKey: v.string(),
    executionMode: v.optional(executionMode),
    approvalCapabilityDigest: v.optional(v.string()),
  })
    .index("by_status_created_at", ["status", "createdAt"])
    .index("by_created_at", ["createdAt"])
    .index("by_approval_capability_digest", ["approvalCapabilityDigest"]),

  incidents: defineTable({
    demoCommandId: v.id("demoCommands"),
    runId: v.string(),
    staged: v.boolean(),
    runnerId: v.string(),
    workloadId: v.literal("demo-service"),
    status: v.optional(incidentStatus),
    currentPhase: incidentPhase,
    initialHealth: v.string(),
    finalHealth: v.optional(v.string()),
    incidentCategory: v.optional(v.string()),
    diagnosisEvidence: v.optional(v.array(v.string())),
    diagnosisSummary: v.optional(v.string()),
    confidence: v.optional(v.number()),
    requiresHuman: v.optional(v.boolean()),
    proposedActionId: v.optional(
      v.union(v.literal("restart_demo_service"), v.literal("no_action")),
    ),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    totalLatencyMs: v.optional(v.number()),
    reportedInputTokens: v.optional(v.number()),
    reportedOutputTokens: v.optional(v.number()),
    costStatus,
    terminalReason: v.optional(v.string()),
    lastCompletedStepSequence: v.optional(v.number()),
    lastCompletedStepLabel: v.optional(v.string()),
    environmentRecoveryStatus: v.optional(environmentRecoveryStatus),
    environmentRecoveryStartedAt: v.optional(v.number()),
    environmentRecoveredAt: v.optional(v.number()),
    environmentRecoveryError: v.optional(v.string()),
    stateVersion: v.number(),
  })
    .index("by_created_at", ["startedAt"])
    .index("by_demo_command", ["demoCommandId"]),

  recoveryCommands: defineTable({
    demoCommandId: v.id("demoCommands"),
    incidentId: v.id("incidents"),
    actionId: v.literal("restart_demo_service"),
    status: recoveryCommandStatus,
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    executionCommandLabel: v.optional(v.string()),
    executionExitCode: v.optional(v.number()),
    executionStartedAt: v.optional(v.number()),
    executionFinishedAt: v.optional(v.number()),
    executionLatencyMs: v.optional(v.number()),
    executionEvidenceNonce: v.optional(v.string()),
    runnerId: v.string(),
    stateVersion: v.number(),
    executionNonce: v.string(),
    approvalStatus: v.optional(approvalStatus),
    approvalCapabilityDigest: v.optional(v.string()),
    approvalRequestedAt: v.optional(v.number()),
    approvalExpiresAt: v.optional(v.number()),
    approvalDecidedAt: v.optional(v.number()),
  })
    .index("by_incident", ["incidentId"])
    .index("by_execution_nonce", ["executionNonce"])
    .index("by_approval_capability_digest", ["approvalCapabilityDigest"]),

  steps: defineTable({
    demoCommandId: v.id("demoCommands"),
    incidentId: v.optional(v.id("incidents")),
    sequence: v.number(),
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
  })
    .index("by_demo_command_sequence", ["demoCommandId", "sequence"])
    .index("by_incident_sequence", ["incidentId", "sequence"])
    .index("by_demo_command_step_nonce", ["demoCommandId", "stepNonce"]),
});
