import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const SERVER_SECRET = "pairing-route-secret-with-enough-entropy";
const CODE_DIGEST = "a".repeat(64);
const OTHER_CODE_DIGEST = "b".repeat(64);
const CREDENTIAL_DIGEST = "c".repeat(64);
const OTHER_CREDENTIAL_DIGEST = "d".repeat(64);
const RUNNER_ID = "gxr_primary123";
const BASE_TIME = Date.UTC(2026, 8, 2, 12, 0, 0);

const createEnrollment = makeFunctionReference<"mutation">(
  "runners:createEnrollment",
);
const listMine = makeFunctionReference<"query">("runners:listMine");
const pairRunner = makeFunctionReference<"mutation">("runners:pairRunner");
const recordHeartbeat = makeFunctionReference<"mutation">(
  "runners:recordHeartbeat",
);
const revoke = makeFunctionReference<"mutation">("runners:revoke");
const registerFixedWorkload = makeFunctionReference<"mutation">(
  "runners:registerFixedWorkload",
);
const requestFixedRecovery = makeFunctionReference<"mutation">(
  "runners:requestFixedRecovery",
);
const decideFixedRecovery = makeFunctionReference<"mutation">(
  "runners:decideFixedRecovery",
);
const watchFixedRecoveryCommands = makeFunctionReference<"mutation">(
  "runners:watchFixedRecoveryCommands",
);
const CLIENT_ADDRESS_DIGEST = "e".repeat(64);
const CONNECTED_CAPABILITY_ID = "fixed_disposable_service_v1";
const CONNECTED_WORKLOAD_ID = "connected-demo-service";
const CONNECTED_HEALTH_CHECK_ID = "check-connected-demo-service-health";
const CONNECTED_RECOVERY_ACTION_ID = "restart-connected-demo-service";
const CONNECTED_RECOVERY_REQUEST_LIMIT = 5;
const CONNECTED_TERMINAL_HISTORY_LIMIT = 50;

type Harness = TestConvex<typeof schema>;

async function addOwner(t: Harness, suffix: string) {
  const ownerId = await t.run((ctx) =>
    ctx.db.insert("users", { email: `${suffix}@example.com` }),
  );
  return {
    ownerId,
    client: t.withIdentity({ subject: `${ownerId}|session-${suffix}` }),
  };
}

async function createPendingEnrollment(
  client: ReturnType<Harness["withIdentity"]>,
  codeDigest = CODE_DIGEST,
) {
  return await client.mutation(createEnrollment, {
    codeDigest,
    label: "staging-web-1",
  });
}

async function consumeEnrollment(
  t: Harness,
  overrides: Record<string, string> = {},
) {
  return await t.mutation(pairRunner, {
    agentVersion: "0.1.0",
    architecture: "arm64",
    codeDigest: CODE_DIGEST,
    credentialDigest: CREDENTIAL_DIGEST,
    clientAddressDigest: CLIENT_ADDRESS_DIGEST,
    requestSecret: SERVER_SECRET,
    runnerId: RUNNER_ID,
    ...overrides,
  });
}

async function createConnectedRunner(t: Harness, ownerSuffix = "connected-owner") {
  const owner = await addOwner(t, ownerSuffix);
  await createPendingEnrollment(owner.client);
  await consumeEnrollment(t);
  return owner;
}

async function connectedHeartbeat(
  t: Harness,
  overrides: Record<string, unknown> = {},
) {
  return await t.mutation(recordHeartbeat, {
    agentVersion: "0.2.0",
    capabilityId: CONNECTED_CAPABILITY_ID,
    clientAddressDigest: CLIENT_ADDRESS_DIGEST,
    credentialDigest: CREDENTIAL_DIGEST,
    requestSecret: SERVER_SECRET,
    runnerId: RUNNER_ID,
    ...overrides,
  });
}

function fixedHealth(
  healthStatus: "healthy" | "unhealthy",
  instanceId = "instance-initial",
) {
  return {
    workloadId: CONNECTED_WORKLOAD_ID,
    healthCheckId: CONNECTED_HEALTH_CHECK_ID,
    healthStatus,
    detailCode:
      healthStatus === "healthy" ? "exact_http_200" : "connection_failed",
    ...(healthStatus === "healthy" ? { instanceId } : {}),
  };
}

async function registerConnectedWorkload(t: Harness, ownerSuffix?: string) {
  const owner = await createConnectedRunner(t, ownerSuffix);
  await connectedHeartbeat(t);
  await owner.client.mutation(registerFixedWorkload, {});
  return owner;
}

async function createPendingRecovery(t: Harness, ownerSuffix?: string) {
  const owner = await registerConnectedWorkload(t, ownerSuffix);
  await connectedHeartbeat(t, {
    healthReport: fixedHealth("healthy", "instance-before-recovery"),
  });
  await connectedHeartbeat(t, { healthReport: fixedHealth("unhealthy") });
  const request = await owner.client.mutation(requestFixedRecovery, {});
  return { owner, request };
}

describe("owner-bound runner pairing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    vi.stubEnv("RUNNER_PAIRING_REQUEST_SECRET", SERVER_SECRET);
  });

  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("requires sign-in and keeps each owner's records private", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(createEnrollment, {
        codeDigest: CODE_DIGEST,
        label: "staging-web-1",
      }),
    ).rejects.toThrow("Authentication required");

    const first = await addOwner(t, "first");
    const second = await addOwner(t, "second");
    await createPendingEnrollment(first.client);

    const firstView = await first.client.query(listMine, {});
    const secondView = await second.client.query(listMine, {});

    expect(firstView).toMatchObject({
      enrollment: { label: "staging-web-1", state: "waiting" },
      runner: null,
    });
    expect(secondView).toEqual({
      enrollment: null,
      latestRecovery: null,
      runner: null,
      workload: null,
    });
    expect(JSON.stringify(firstView)).not.toContain(CODE_DIGEST);
  });

  it("checks the dedicated server secret before revealing pairing state", async () => {
    const t = convexTest(schema, modules);
    const owner = await addOwner(t, "owner");
    await createPendingEnrollment(owner.client);

    await expect(
      consumeEnrollment(t, { requestSecret: "wrong-secret" }),
    ).rejects.toThrow(/unauthorized/i);

    const documents = await t.run((ctx) =>
      ctx.db.query("registeredRunners").collect(),
    );
    expect(documents).toHaveLength(0);
    expect(
      await t.run((ctx) => ctx.db.query("runnerRateLimitBuckets").collect()),
    ).toHaveLength(0);
  });

  it("expires after ten minutes and consumes a fresh code only once", async () => {
    const t = convexTest(schema, modules);
    const owner = await addOwner(t, "owner");
    await createPendingEnrollment(owner.client);

    vi.setSystemTime(BASE_TIME + 10 * 60_000);
    await expect(consumeEnrollment(t)).resolves.toEqual({
      status: "unavailable",
    });

    await createPendingEnrollment(owner.client, OTHER_CODE_DIGEST);
    const paired = await consumeEnrollment(t, {
      codeDigest: OTHER_CODE_DIGEST,
    });
    expect(paired).toMatchObject({
      label: "staging-web-1",
      runnerId: RUNNER_ID,
      status: "paired",
    });

    await expect(
      consumeEnrollment(t, { codeDigest: OTHER_CODE_DIGEST }),
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("shows an enrollment as expired at the exact expiry instant", async () => {
    const t = convexTest(schema, modules);
    const owner = await addOwner(t, "owner");
    await createPendingEnrollment(owner.client);

    vi.setSystemTime(BASE_TIME + 10 * 60_000);

    expect(await owner.client.query(listMine, {})).toMatchObject({
      enrollment: { state: "expired" },
    });
  });

  it("allows only one winner when the same code is claimed concurrently", async () => {
    const t = convexTest(schema, modules);
    const owner = await addOwner(t, "owner");
    await createPendingEnrollment(owner.client);

    const results = await Promise.allSettled([
      consumeEnrollment(t),
      consumeEnrollment(t, {
        credentialDigest: OTHER_CREDENTIAL_DIGEST,
        runnerId: "gxr_competitor123",
      }),
    ]);

    expect(
      results.filter(
        (result) =>
          result.status === "fulfilled" && result.value.status === "paired",
      ),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          result.status === "fulfilled" &&
          result.value.status === "unavailable",
      ),
    ).toHaveLength(1);
    expect(
      await t.run((ctx) => ctx.db.query("registeredRunners").collect()),
    ).toHaveLength(1);
  });

  it("stores only digests, binds heartbeats, and blocks a revoked runner", async () => {
    const t = convexTest(schema, modules);
    const owner = await addOwner(t, "owner");
    await createPendingEnrollment(owner.client);
    await consumeEnrollment(t);

    await expect(
      t.mutation(recordHeartbeat, {
        agentVersion: "0.1.0",
        clientAddressDigest: CLIENT_ADDRESS_DIGEST,
        credentialDigest: OTHER_CREDENTIAL_DIGEST,
        requestSecret: SERVER_SECRET,
        runnerId: RUNNER_ID,
      }),
    ).resolves.toEqual({ status: "unavailable" });

    vi.setSystemTime(BASE_TIME + 2_000);
    await t.mutation(recordHeartbeat, {
      agentVersion: "0.1.0",
      clientAddressDigest: CLIENT_ADDRESS_DIGEST,
      credentialDigest: CREDENTIAL_DIGEST,
      requestSecret: SERVER_SECRET,
      runnerId: RUNNER_ID,
    });

    const privateDocuments = await t.run(async (ctx) => ({
      invites: await ctx.db.query("runnerPairingInvites").collect(),
      runners: await ctx.db.query("registeredRunners").collect(),
    }));
    expect(privateDocuments.invites[0]).toHaveProperty("codeDigest", CODE_DIGEST);
    expect(privateDocuments.runners[0]).toHaveProperty(
      "credentialDigest",
      CREDENTIAL_DIGEST,
    );
    expect(privateDocuments.runners[0]).not.toHaveProperty("hostname");
    expect(privateDocuments.runners[0]).not.toHaveProperty("ipAddress");
    expect(JSON.stringify(await owner.client.query(listMine, {}))).not.toContain(
      CREDENTIAL_DIGEST,
    );

    await owner.client.mutation(revoke, { runnerId: RUNNER_ID });
    await expect(
      t.mutation(recordHeartbeat, {
        agentVersion: "0.1.0",
        clientAddressDigest: CLIENT_ADDRESS_DIGEST,
        credentialDigest: CREDENTIAL_DIGEST,
        requestSecret: SERVER_SECRET,
        runnerId: RUNNER_ID,
      }),
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("persists pairing limits in Convex across repeated invalid attempts", async () => {
    const t = convexTest(schema, modules);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(consumeEnrollment(t)).resolves.toEqual({
        status: "unavailable",
      });
    }

    await expect(consumeEnrollment(t)).resolves.toMatchObject({
      status: "rate_limited",
    });
    const buckets = await t.run((ctx) =>
      ctx.db.query("runnerRateLimitBuckets").collect(),
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      count: 10,
      deniedCount: 1,
      failedCount: 10,
    });

    vi.setSystemTime(BASE_TIME + 60_000);
    await expect(consumeEnrollment(t)).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("allows exactly ten concurrent pairing attempts in one window", async () => {
    const t = convexTest(schema, modules);
    const results = await Promise.all(
      Array.from({ length: 11 }, () => consumeEnrollment(t)),
    );

    expect(results.filter((result) => result.status === "unavailable")).toHaveLength(10);
    expect(results.filter((result) => result.status === "rate_limited")).toHaveLength(1);
  });

  it("uses an IP-only heartbeat bucket before trusting a rotating runner ID", async () => {
    const t = convexTest(schema, modules);

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await expect(
        t.mutation(recordHeartbeat, {
          agentVersion: "0.1.0",
          clientAddressDigest: CLIENT_ADDRESS_DIGEST,
          credentialDigest: CREDENTIAL_DIGEST,
          requestSecret: SERVER_SECRET,
          runnerId: `gxr_rotating${String(attempt).padStart(4, "0")}`,
        }),
      ).resolves.toEqual({ status: "unavailable" });
    }

    await expect(
      t.mutation(recordHeartbeat, {
        agentVersion: "0.1.0",
        clientAddressDigest: CLIENT_ADDRESS_DIGEST,
        credentialDigest: CREDENTIAL_DIGEST,
        requestSecret: SERVER_SECRET,
        runnerId: "gxr_rotating9999",
      }),
    ).resolves.toMatchObject({ status: "rate_limited" });
    expect(
      await t.run((ctx) => ctx.db.query("runnerRateLimitBuckets").collect()),
    ).toHaveLength(1);
  });

  it("hard-bounds shared rate-limit storage", async () => {
    const t = convexTest(schema, modules);

    for (let attempt = 0; attempt < 256; attempt += 1) {
      await expect(
        consumeEnrollment(t, {
          clientAddressDigest: attempt.toString(16).padStart(64, "0"),
        }),
      ).resolves.toEqual({ status: "unavailable" });
    }

    await expect(
      consumeEnrollment(t, { clientAddressDigest: "f".repeat(64) }),
    ).resolves.toMatchObject({ status: "rate_limited" });
    expect(
      await t.run((ctx) => ctx.db.query("runnerRateLimitBuckets").collect()),
    ).toHaveLength(256);
    expect(
      await t.run((ctx) => ctx.db.query("runnerRateLimitControl").unique()),
    ).toMatchObject({ bucketCount: 256, capacityDeniedCount: 1 });

    vi.setSystemTime(BASE_TIME + 60_000);
    await expect(
      consumeEnrollment(t, { clientAddressDigest: "e".repeat(64) }),
    ).resolves.toEqual({ status: "unavailable" });
    const prunedBuckets = await t.run((ctx) =>
      ctx.db.query("runnerRateLimitBuckets").collect(),
    );
    expect(prunedBuckets.length).toBeLessThanOrEqual(256);
  });

  it("limits a verified runner without letting invalid credentials consume its bucket", async () => {
    const t = convexTest(schema, modules);
    const owner = await addOwner(t, "owner");
    await createPendingEnrollment(owner.client);
    await consumeEnrollment(t);

    for (let attempt = 0; attempt < 45; attempt += 1) {
      await expect(
        t.mutation(recordHeartbeat, {
          agentVersion: "0.1.0",
          clientAddressDigest: CLIENT_ADDRESS_DIGEST,
          credentialDigest: CREDENTIAL_DIGEST,
          requestSecret: SERVER_SECRET,
          runnerId: RUNNER_ID,
        }),
      ).resolves.toMatchObject({ status: "accepted" });
    }
    await expect(
      t.mutation(recordHeartbeat, {
        agentVersion: "0.1.0",
        clientAddressDigest: CLIENT_ADDRESS_DIGEST,
        credentialDigest: CREDENTIAL_DIGEST,
        requestSecret: SERVER_SECRET,
        runnerId: RUNNER_ID,
      }),
    ).resolves.toMatchObject({ status: "rate_limited" });
  });

  it("limits distributed bad credentials separately without blocking a valid heartbeat", async () => {
    const t = convexTest(schema, modules);
    const owner = await addOwner(t, "owner");
    await createPendingEnrollment(owner.client);
    await consumeEnrollment(t);

    for (let attempt = 0; attempt < 45; attempt += 1) {
      await expect(
        t.mutation(recordHeartbeat, {
          agentVersion: "0.1.0",
          clientAddressDigest: attempt.toString(16).padStart(64, "0"),
          credentialDigest: OTHER_CREDENTIAL_DIGEST,
          requestSecret: SERVER_SECRET,
          runnerId: RUNNER_ID,
        }),
      ).resolves.toEqual({ status: "unavailable" });
    }
    await expect(
      t.mutation(recordHeartbeat, {
        agentVersion: "0.1.0",
        clientAddressDigest: "f".repeat(64),
        credentialDigest: OTHER_CREDENTIAL_DIGEST,
        requestSecret: SERVER_SECRET,
        runnerId: RUNNER_ID,
      }),
    ).resolves.toMatchObject({ status: "rate_limited" });

    await expect(
      t.mutation(recordHeartbeat, {
        agentVersion: "0.1.0",
        clientAddressDigest: "a".repeat(64),
        credentialDigest: CREDENTIAL_DIGEST,
        requestSecret: SERVER_SECRET,
        runnerId: RUNNER_ID,
      }),
    ).resolves.toMatchObject({ status: "accepted" });
  });

  it("authenticates and rate-limits before normalizing an opaque result command ID", async () => {
    const t = convexTest(schema, modules);
    await createConnectedRunner(t, "opaque-id-owner");
    const invalidResult = {
      commandId: "not_a_convex_document_id",
      executionNonce: "bounded_nonce",
      actionId: CONNECTED_RECOVERY_ACTION_ID,
      executionResultCode: "restart_failed",
      verificationStatus: "unhealthy",
      verificationDetailCode: "request_timeout",
    };

    await expect(
      t.mutation(recordHeartbeat, {
        agentVersion: "0.2.0",
        clientAddressDigest: CLIENT_ADDRESS_DIGEST,
        credentialDigest: OTHER_CREDENTIAL_DIGEST,
        previousCommandResult: invalidResult,
        requestSecret: SERVER_SECRET,
        runnerId: RUNNER_ID,
      }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("runnerRateLimitBuckets")
          .withIndex("by_bucket_key", (q) =>
            q.eq("bucketKey", `heartbeat_ip:${CLIENT_ADDRESS_DIGEST}`),
          )
          .unique(),
      ),
    ).toMatchObject({ count: 1, failedCount: 1 });

    await expect(
      connectedHeartbeat(t, { previousCommandResult: invalidResult }),
    ).resolves.toMatchObject({
      status: "accepted",
      resultDisposition: "rejected",
    });
  });

  it("requires a fresh fixed capability and registers one safe owner-bound workload", async () => {
    const t = convexTest(schema, modules);
    const owner = await createConnectedRunner(t);

    await expect(t.mutation(registerFixedWorkload, {})).rejects.toThrow(
      "Authentication required",
    );
    await expect(
      owner.client.mutation(registerFixedWorkload, {}),
    ).rejects.toThrow(/FIXED_CAPABILITY_UNAVAILABLE/);

    await connectedHeartbeat(t);
    const first = await owner.client.mutation(registerFixedWorkload, {});
    const repeated = await owner.client.mutation(registerFixedWorkload, {});
    expect(repeated).toEqual(first);

    const view = await owner.client.query(listMine, {});
    expect(view).toMatchObject({
      workload: {
        workloadId: CONNECTED_WORKLOAD_ID,
        healthCheckId: CONNECTED_HEALTH_CHECK_ID,
        recoveryActionId: CONNECTED_RECOVERY_ACTION_ID,
        recoveryMode: "approval_required",
        healthStatus: "unknown",
      },
      latestRecovery: null,
    });
    const other = await addOwner(t, "other-owner");
    expect(await other.client.query(listMine, {})).toEqual({
      enrollment: null,
      latestRecovery: null,
      runner: null,
      workload: null,
    });
    const publicOwnerJson = JSON.stringify(view);
    expect(publicOwnerJson).not.toContain(CREDENTIAL_DIGEST);
    expect(publicOwnerJson).not.toContain("127.0.0.1");
    expect(publicOwnerJson).not.toMatch(/command|filePath|healthUrl|ledger/i);
    expect(
      await t.run((ctx) => ctx.db.query("managedWorkloads").collect()),
    ).toHaveLength(1);
  });

  it("rate-limits owner recovery requests without counting rejected attempts as new rows", async () => {
    const t = convexTest(schema, modules);
    const owner = await registerConnectedWorkload(t, "request-rate-owner");
    await connectedHeartbeat(t, {
      healthReport: fixedHealth("healthy", "rate-limit-instance"),
    });
    await connectedHeartbeat(t, { healthReport: fixedHealth("unhealthy") });

    for (let attempt = 0; attempt < CONNECTED_RECOVERY_REQUEST_LIMIT; attempt += 1) {
      const request = await owner.client.mutation(requestFixedRecovery, {});
      await owner.client.mutation(decideFixedRecovery, {
        commandId: request.commandId,
        decision: "rejected",
      });
    }
    await expect(
      owner.client.mutation(requestFixedRecovery, {}),
    ).rejects.toThrow(/RECOVERY_REQUEST_RATE_LIMITED/);
    expect(
      await t.run((ctx) => ctx.db.query("runnerRecoveryRequests").collect()),
    ).toHaveLength(CONNECTED_RECOVERY_REQUEST_LIMIT);
  });

  it("keeps only the newest bounded terminal recovery audit records", async () => {
    const t = convexTest(schema, modules);
    const owner = await registerConnectedWorkload(t, "history-owner");
    await connectedHeartbeat(t, {
      healthReport: fixedHealth("healthy", "history-instance"),
    });
    await connectedHeartbeat(t, { healthReport: fixedHealth("unhealthy") });

    const seededStart = BASE_TIME - 10_000;
    await t.run(async (ctx) => {
      const runner = await ctx.db
        .query("registeredRunners")
        .withIndex("by_runner_id", (q) => q.eq("runnerId", RUNNER_ID))
        .unique();
      if (!runner) throw new Error("Runner missing in retention setup");
      const workload = await ctx.db
        .query("managedWorkloads")
        .withIndex("by_runner_record", (q) =>
          q.eq("runnerRecordId", runner._id),
        )
        .unique();
      if (!workload) throw new Error("Workload missing in retention setup");

      for (let index = 0; index < 155; index += 1) {
        await ctx.db.insert("runnerRecoveryRequests", {
          ownerId: owner.ownerId,
          workloadRecordId: workload._id,
          runnerRecordId: runner._id,
          runnerId: runner.runnerId,
          workloadId: CONNECTED_WORKLOAD_ID,
          actionId: CONNECTED_RECOVERY_ACTION_ID,
          status: "rejected",
          createdAt: seededStart + index,
          deadlineAt: seededStart + index,
          preActionInstanceId: "history-instance",
          approvalDecidedAt: seededStart + index,
          terminalReason: "owner_rejected",
          finishedAt: seededStart + index,
          stateVersion: 1,
        });
      }
    });

    const request = await owner.client.mutation(requestFixedRecovery, {});
    await owner.client.mutation(decideFixedRecovery, {
      commandId: request.commandId,
      decision: "rejected",
    });
    const terminal = (
      await t.run((ctx) => ctx.db.query("runnerRecoveryRequests").collect())
    )
      .filter((recovery) => recovery.finishedAt !== undefined)
      .sort((left, right) => left.createdAt - right.createdAt);
    expect(terminal).toHaveLength(CONNECTED_TERMINAL_HISTORY_LIMIT);
    expect(terminal[0]?.createdAt).toBe(seededStart + 106);
    expect(terminal.at(-1)?.createdAt).toBe(BASE_TIME);
  });

  it("accepts health only from the matching runner and keeps recovery approval-first", async () => {
    const t = convexTest(schema, modules);
    const owner = await registerConnectedWorkload(t);

    await expect(owner.client.mutation(requestFixedRecovery, {})).rejects.toThrow(
      /UNHEALTHY_REPORT_REQUIRED/,
    );
    await connectedHeartbeat(t, { healthReport: fixedHealth("healthy") });
    await expect(owner.client.mutation(requestFixedRecovery, {})).rejects.toThrow(
      /UNHEALTHY_REPORT_REQUIRED/,
    );
    await expect(
      connectedHeartbeat(t, {
        credentialDigest: OTHER_CREDENTIAL_DIGEST,
        healthReport: fixedHealth("unhealthy"),
      }),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      connectedHeartbeat(t, {
        healthReport: {
          ...fixedHealth("unhealthy"),
          workloadId: "another-service",
        },
      }),
    ).rejects.toThrow();
    await expect(
      connectedHeartbeat(t, {
        healthReport: {
          ...fixedHealth("healthy"),
          checkedAt: BASE_TIME - 60_000,
        },
      }),
    ).rejects.toThrow();

    await connectedHeartbeat(t, { healthReport: fixedHealth("unhealthy") });
    expect((await owner.client.query(listMine, {})).workload).toMatchObject({
      currentInstanceId: null,
      lastHealthyInstanceId: "instance-initial",
    });
    const requested = await owner.client.mutation(requestFixedRecovery, {});
    expect(requested).toMatchObject({
      status: "pending_approval",
      preActionInstanceId: "instance-initial",
      postActionInstanceId: null,
    });
    await expect(
      connectedHeartbeat(t, { healthReport: fixedHealth("unhealthy") }),
    ).resolves.toMatchObject({ command: null, workloadRegistered: true });

    const other = await addOwner(t, "decision-intruder");
    await expect(
      other.client.mutation(decideFixedRecovery, {
        commandId: requested.commandId,
        decision: "approved",
      }),
    ).rejects.toThrow(/RECOVERY_NOT_FOUND/);
    await expect(
      owner.client.mutation(decideFixedRecovery, {
        commandId: requested.commandId,
        decision: "rejected",
      }),
    ).resolves.toMatchObject({ status: "rejected" });
    await expect(
      owner.client.mutation(decideFixedRecovery, {
        commandId: requested.commandId,
        decision: "approved",
      }),
    ).rejects.toThrow(/RECOVERY_NOT_PENDING/);
    expect((await owner.client.query(listMine, {})).latestRecovery).toMatchObject({
      status: "rejected",
    });
  });

  it("allows only one active request and turns an approved recovery into not_needed when health is already fresh", async () => {
    const t = convexTest(schema, modules);
    const owner = await registerConnectedWorkload(t);
    await connectedHeartbeat(t, {
      healthReport: fixedHealth("healthy", "instance-before-request"),
    });
    await connectedHeartbeat(t, { healthReport: fixedHealth("unhealthy") });

    const requests = await Promise.allSettled([
      owner.client.mutation(requestFixedRecovery, {}),
      owner.client.mutation(requestFixedRecovery, {}),
    ]);
    expect(requests.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(requests.filter((result) => result.status === "rejected")).toHaveLength(1);
    const requested = requests.find((result) => result.status === "fulfilled");
    if (!requested || requested.status !== "fulfilled") {
      throw new Error("A recovery request was not created");
    }

    vi.setSystemTime(BASE_TIME + 9_000);
    await expect(
      owner.client.mutation(decideFixedRecovery, {
        commandId: requested.value.commandId,
        decision: "approved",
      }),
    ).rejects.toThrow(/RUNNER_OR_HEALTH_STALE/);

    await connectedHeartbeat(t, { healthReport: fixedHealth("unhealthy") });
    await owner.client.mutation(decideFixedRecovery, {
      commandId: requested.value.commandId,
      decision: "approved",
    });
    await expect(
      connectedHeartbeat(t, { healthReport: fixedHealth("healthy") }),
    ).resolves.toMatchObject({ command: null });
    expect((await owner.client.query(listMine, {})).latestRecovery).toMatchObject({
      status: "not_needed",
      terminalReason: "precondition_changed",
    });
  });

  it("claims one approved command once and accepts one idempotent exact healthy result", async () => {
    const t = convexTest(schema, modules);
    const { owner, request } = await createPendingRecovery(t);
    await owner.client.mutation(decideFixedRecovery, {
      commandId: request.commandId,
      decision: "approved",
    });

    await expect(
      t.mutation(recordHeartbeat, {
        agentVersion: "0.2.0",
        clientAddressDigest: CLIENT_ADDRESS_DIGEST,
        credentialDigest: CREDENTIAL_DIGEST,
        healthReport: fixedHealth("unhealthy"),
        requestSecret: SERVER_SECRET,
        runnerId: RUNNER_ID,
      }),
    ).resolves.toMatchObject({ command: null });
    const claimed = await connectedHeartbeat(t, {
      healthReport: fixedHealth("unhealthy"),
    });
    expect(claimed).toMatchObject({
      workloadRegistered: true,
      command: {
        commandId: request.commandId,
        actionId: CONNECTED_RECOVERY_ACTION_ID,
        workloadId: CONNECTED_WORKLOAD_ID,
      },
    });
    expect(claimed.command.executionNonce).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    await expect(
      connectedHeartbeat(t, { healthReport: fixedHealth("unhealthy") }),
    ).resolves.toMatchObject({ command: null });

    const result = {
      commandId: request.commandId,
      executionNonce: claimed.command.executionNonce,
      actionId: CONNECTED_RECOVERY_ACTION_ID,
      executionResultCode: "restart_succeeded",
      verificationStatus: "healthy",
      verificationDetailCode: "exact_http_200",
      postActionInstanceId: "instance-after-recovery",
    };
    await expect(
      connectedHeartbeat(t, {
        previousCommandResult: { ...result, verifiedAt: BASE_TIME - 60_000 },
        healthReport: fixedHealth("healthy", "instance-after-recovery"),
      }),
    ).rejects.toThrow();
    const accepted = await connectedHeartbeat(t, {
      previousCommandResult: result,
      healthReport: fixedHealth("healthy", "instance-after-recovery"),
    });
    expect(accepted).toMatchObject({ resultDisposition: "accepted" });
    const completed = (await owner.client.query(listMine, {})).latestRecovery;
    expect(completed).toMatchObject({
      status: "succeeded",
      executionResultCode: "restart_succeeded",
      verificationDetailCode: "exact_http_200",
      preActionInstanceId: "instance-before-recovery",
      postActionInstanceId: "instance-after-recovery",
    });
    expect(completed.finishedAt).toEqual(expect.any(Number));
    expect((await owner.client.query(listMine, {})).workload).toMatchObject({
      currentInstanceId: "instance-after-recovery",
      lastHealthyInstanceId: "instance-after-recovery",
    });

    const duplicate = await connectedHeartbeat(t, {
      previousCommandResult: result,
      healthReport: fixedHealth("healthy", "instance-after-recovery"),
    });
    expect(duplicate).toMatchObject({ resultDisposition: "duplicate" });
    expect((await owner.client.query(listMine, {})).latestRecovery).toEqual(
      completed,
    );

    await expect(
      connectedHeartbeat(t, {
        previousCommandResult: {
          ...result,
          executionNonce: "wrong_terminal_nonce",
        },
        healthReport: fixedHealth("healthy", "instance-after-recovery"),
      }),
    ).resolves.toMatchObject({ resultDisposition: "rejected" });
    await expect(
      connectedHeartbeat(t, {
        previousCommandResult: {
          commandId: result.commandId,
          executionNonce: result.executionNonce,
          actionId: result.actionId,
          executionResultCode: "restart_failed",
          verificationStatus: "unhealthy",
          verificationDetailCode: "connection_failed",
        },
        healthReport: fixedHealth("healthy", "instance-after-recovery"),
      }),
    ).resolves.toMatchObject({ resultDisposition: "rejected" });
    expect((await owner.client.query(listMine, {})).latestRecovery).toEqual(
      completed,
    );
  });

  it("does not hide a newly claimed command behind a rejected prior result", async () => {
    const t = convexTest(schema, modules);
    const { owner, request: firstRequest } = await createPendingRecovery(
      t,
      "rejected-result-claim-owner",
    );
    await owner.client.mutation(decideFixedRecovery, {
      commandId: firstRequest.commandId,
      decision: "approved",
    });
    const firstClaim = await connectedHeartbeat(t, {
      healthReport: fixedHealth("unhealthy"),
    });
    const firstResult = {
      commandId: firstRequest.commandId,
      executionNonce: firstClaim.command.executionNonce,
      actionId: CONNECTED_RECOVERY_ACTION_ID,
      executionResultCode: "restart_succeeded",
      verificationStatus: "healthy",
      verificationDetailCode: "exact_http_200",
      postActionInstanceId: "instance-after-first-recovery",
    };
    await connectedHeartbeat(t, {
      previousCommandResult: firstResult,
      healthReport: fixedHealth("healthy", "instance-after-first-recovery"),
    });

    await connectedHeartbeat(t, { healthReport: fixedHealth("unhealthy") });
    const secondRequest = await owner.client.mutation(requestFixedRecovery, {});
    await owner.client.mutation(decideFixedRecovery, {
      commandId: secondRequest.commandId,
      decision: "approved",
    });

    const rejectedHeartbeat = await connectedHeartbeat(t, {
      previousCommandResult: {
        ...firstResult,
        executionNonce: "wrong_old_nonce",
      },
      healthReport: fixedHealth("unhealthy"),
    });
    expect(rejectedHeartbeat).toMatchObject({
      command: null,
      resultDisposition: "rejected",
    });
    expect((await owner.client.query(listMine, {})).latestRecovery).toMatchObject({
      commandId: secondRequest.commandId,
      status: "approved",
    });

    await expect(
      connectedHeartbeat(t, { healthReport: fixedHealth("unhealthy") }),
    ).resolves.toMatchObject({
      command: { commandId: secondRequest.commandId },
      resultDisposition: "none",
    });
  });

  it("never treats process success with unhealthy verification as recovery", async () => {
    const t = convexTest(schema, modules);
    const { owner, request } = await createPendingRecovery(t);
    await owner.client.mutation(decideFixedRecovery, {
      commandId: request.commandId,
      decision: "approved",
    });
    const claimed = await connectedHeartbeat(t, {
      healthReport: fixedHealth("unhealthy"),
    });

    await connectedHeartbeat(t, {
      previousCommandResult: {
        commandId: request.commandId,
        executionNonce: claimed.command.executionNonce,
        actionId: CONNECTED_RECOVERY_ACTION_ID,
        executionResultCode: "restart_succeeded",
        verificationStatus: "unhealthy",
        verificationDetailCode: "connection_failed",
      },
      healthReport: fixedHealth("unhealthy"),
    });

    expect((await owner.client.query(listMine, {})).latestRecovery).toMatchObject({
      status: "failed",
      terminalReason: "verification_failed",
    });
  });

  it("never treats the pre-action instance as fresh recovery proof", async () => {
    const t = convexTest(schema, modules);
    const { owner, request } = await createPendingRecovery(t);
    await owner.client.mutation(decideFixedRecovery, {
      commandId: request.commandId,
      decision: "approved",
    });
    const claimed = await connectedHeartbeat(t, {
      healthReport: fixedHealth("unhealthy"),
    });

    await connectedHeartbeat(t, {
      previousCommandResult: {
        commandId: request.commandId,
        executionNonce: claimed.command.executionNonce,
        actionId: CONNECTED_RECOVERY_ACTION_ID,
        executionResultCode: "restart_succeeded",
        verificationStatus: "healthy",
        verificationDetailCode: "exact_http_200",
        postActionInstanceId: "instance-before-recovery",
      },
      healthReport: fixedHealth("healthy", "instance-before-recovery"),
    });

    expect((await owner.client.query(listMine, {})).latestRecovery).toMatchObject({
      status: "failed",
      terminalReason: "verification_failed",
      preActionInstanceId: "instance-before-recovery",
      postActionInstanceId: "instance-before-recovery",
    });
  });

  it("expires unclaimed work on revoke but records claimed work as execution_unknown", async () => {
    const beforeClaim = convexTest(schema, modules);
    const pending = await createPendingRecovery(beforeClaim, "revoke-before");
    await pending.owner.client.mutation(decideFixedRecovery, {
      commandId: pending.request.commandId,
      decision: "approved",
    });
    await pending.owner.client.mutation(revoke, { runnerId: RUNNER_ID });
    expect(
      (await pending.owner.client.query(listMine, {})).latestRecovery,
    ).toMatchObject({
      status: "expired",
      terminalReason: "runner_revoked_before_claim",
    });

    const afterClaim = convexTest(schema, modules);
    const claimedRecovery = await createPendingRecovery(afterClaim, "revoke-after");
    await claimedRecovery.owner.client.mutation(decideFixedRecovery, {
      commandId: claimedRecovery.request.commandId,
      decision: "approved",
    });
    await connectedHeartbeat(afterClaim, {
      healthReport: fixedHealth("unhealthy"),
    });
    await claimedRecovery.owner.client.mutation(revoke, { runnerId: RUNNER_ID });
    expect(
      (await claimedRecovery.owner.client.query(listMine, {})).latestRecovery,
    ).toMatchObject({
      status: "execution_unknown",
      terminalReason: "runner_revoked_after_claim",
    });
  });

  it("watchdog terminalizes pending, approved, and claimed work in a bounded batch", async () => {
    const pendingHarness = convexTest(schema, modules);
    const pending = await createPendingRecovery(pendingHarness, "pending-timeout");
    vi.setSystemTime(BASE_TIME + 5 * 60_000);
    await pendingHarness.mutation(watchFixedRecoveryCommands, {});
    expect(
      (await pending.owner.client.query(listMine, {})).latestRecovery,
    ).toMatchObject({ status: "expired", terminalReason: "approval_expired" });

    vi.setSystemTime(BASE_TIME);
    const approvedHarness = convexTest(schema, modules);
    const approved = await createPendingRecovery(approvedHarness, "approved-timeout");
    await approved.owner.client.mutation(decideFixedRecovery, {
      commandId: approved.request.commandId,
      decision: "approved",
    });
    vi.setSystemTime(BASE_TIME + 30_000);
    await approvedHarness.mutation(watchFixedRecoveryCommands, {});
    expect(
      (await approved.owner.client.query(listMine, {})).latestRecovery,
    ).toMatchObject({ status: "expired", terminalReason: "command_expired" });

    vi.setSystemTime(BASE_TIME);
    const claimedHarness = convexTest(schema, modules);
    const claimed = await createPendingRecovery(claimedHarness, "claimed-timeout");
    await claimed.owner.client.mutation(decideFixedRecovery, {
      commandId: claimed.request.commandId,
      decision: "approved",
    });
    const claimedCommand = await connectedHeartbeat(claimedHarness, {
      healthReport: fixedHealth("unhealthy"),
    });
    vi.setSystemTime(BASE_TIME + 15_000);
    await claimedHarness.mutation(watchFixedRecoveryCommands, {});
    expect(
      (await claimed.owner.client.query(listMine, {})).latestRecovery,
    ).toMatchObject({
      status: "execution_unknown",
      terminalReason: "runner_lost_during_action",
    });

    const lateResult = {
      commandId: claimed.request.commandId,
      executionNonce: claimedCommand.command.executionNonce,
      actionId: CONNECTED_RECOVERY_ACTION_ID,
      executionResultCode: "restart_succeeded",
      verificationStatus: "healthy",
      verificationDetailCode: "exact_http_200",
      postActionInstanceId: "late-instance",
    };
    await expect(
      connectedHeartbeat(claimedHarness, {
        previousCommandResult: lateResult,
        healthReport: fixedHealth("healthy", "late-instance"),
      }),
    ).resolves.toMatchObject({ resultDisposition: "ignored" });
    await expect(
      connectedHeartbeat(claimedHarness, {
        previousCommandResult: {
          ...lateResult,
          executionNonce: "wrong_late_nonce",
        },
        healthReport: fixedHealth("healthy", "late-instance"),
      }),
    ).resolves.toMatchObject({ resultDisposition: "rejected" });
    expect(
      (await claimed.owner.client.query(listMine, {})).latestRecovery,
    ).toMatchObject({ status: "execution_unknown" });
  });

  it("cannot approve a pending request at its exact deadline", async () => {
    const t = convexTest(schema, modules);
    const { owner, request } = await createPendingRecovery(t, "expired-decision");
    vi.setSystemTime(BASE_TIME + 5 * 60_000);
    await connectedHeartbeat(t, { healthReport: fixedHealth("unhealthy") });

    await expect(
      owner.client.mutation(decideFixedRecovery, {
        commandId: request.commandId,
        decision: "approved",
      }),
    ).resolves.toMatchObject({
      status: "expired",
      terminalReason: "approval_expired",
    });
    expect((await owner.client.query(listMine, {})).latestRecovery).toMatchObject({
      status: "expired",
      terminalReason: "approval_expired",
    });
  });
});
