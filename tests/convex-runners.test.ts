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
const CLIENT_ADDRESS_DIGEST = "e".repeat(64);

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
    expect(secondView).toEqual({ enrollment: null, runner: null });
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
});
