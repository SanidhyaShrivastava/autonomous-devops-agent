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

async function expectCode(operation: Promise<unknown>, code: string) {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject({ data: { code } });
    return;
  }
  throw new Error(`Expected ${code}`);
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
  });

  it("expires after ten minutes and consumes a fresh code only once", async () => {
    const t = convexTest(schema, modules);
    const owner = await addOwner(t, "owner");
    await createPendingEnrollment(owner.client);

    vi.setSystemTime(BASE_TIME + 10 * 60_000);
    await expectCode(consumeEnrollment(t), "PAIRING_UNAVAILABLE");

    await createPendingEnrollment(owner.client, OTHER_CODE_DIGEST);
    const paired = await consumeEnrollment(t, {
      codeDigest: OTHER_CODE_DIGEST,
    });
    expect(paired).toMatchObject({ label: "staging-web-1", runnerId: RUNNER_ID });

    await expectCode(
      consumeEnrollment(t, { codeDigest: OTHER_CODE_DIGEST }),
      "PAIRING_UNAVAILABLE",
    );
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

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      await t.run((ctx) => ctx.db.query("registeredRunners").collect()),
    ).toHaveLength(1);
  });

  it("stores only digests, binds heartbeats, and blocks a revoked runner", async () => {
    const t = convexTest(schema, modules);
    const owner = await addOwner(t, "owner");
    await createPendingEnrollment(owner.client);
    await consumeEnrollment(t);

    await expectCode(
      t.mutation(recordHeartbeat, {
        agentVersion: "0.1.0",
        credentialDigest: OTHER_CREDENTIAL_DIGEST,
        requestSecret: SERVER_SECRET,
        runnerId: RUNNER_ID,
      }),
      "RUNNER_UNAVAILABLE",
    );

    vi.setSystemTime(BASE_TIME + 2_000);
    await t.mutation(recordHeartbeat, {
      agentVersion: "0.1.0",
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
    await expectCode(
      t.mutation(recordHeartbeat, {
        agentVersion: "0.1.0",
        credentialDigest: CREDENTIAL_DIGEST,
        requestSecret: SERVER_SECRET,
        runnerId: RUNNER_ID,
      }),
      "RUNNER_UNAVAILABLE",
    );
  });
});
