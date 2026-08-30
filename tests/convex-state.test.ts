import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

const DEMO_SECRET = "demo-test-secret-with-enough-entropy";
const RUNNER_TOKEN = "runner-test-token-with-enough-entropy";
const RUNNER_ID = "gx-local-runner";
const OTHER_RUNNER_ID = "not-the-demo-runner";
const CLAIM_NONCE = "stable-test-claim";
const BASE_TIME = Date.UTC(2026, 7, 30, 12, 0, 0);
const UTC_DAY = "2026-08-30";

const requestRun = makeFunctionReference<"mutation">("demo:requestRun");
const getPublicState = makeFunctionReference<"query">("demo:getPublicState");
const heartbeat = makeFunctionReference<"mutation">("runner:heartbeat");
const getPendingDemoCommand = makeFunctionReference<"query">(
  "runner:getPendingDemoCommand",
);
const getActiveDemoCommand = makeFunctionReference<"query">(
  "runner:getActiveDemoCommand",
);
const claimDemoCommand = makeFunctionReference<"mutation">(
  "runner:claimDemoCommand",
);
const renewLease = makeFunctionReference<"mutation">("runner:renewLease");
const failDemoCommand = makeFunctionReference<"mutation">(
  "runner:failDemoCommand",
);
const markResetApplied = makeFunctionReference<"mutation">(
  "runner:markResetApplied",
);
const markFailureConfirmed = makeFunctionReference<"mutation">(
  "runner:markFailureConfirmed",
);
const createIncidentFromConfirmedFailure = makeFunctionReference<"mutation">(
  "runner:createIncidentFromConfirmedFailure",
);
const appendStep = makeFunctionReference<"mutation">("runner:appendStep");
const createRecoveryCommand = makeFunctionReference<"mutation">(
  "runner:createRecoveryCommand",
);
const updateIncidentPhase = makeFunctionReference<"mutation">(
  "runner:updateIncidentPhase",
);
const completeIncident = makeFunctionReference<"mutation">(
  "runner:completeIncident",
);

type ConvexHarness = TestConvex<typeof schema>;

type DemoCommandResult = {
  demoCommandId: string;
};

type VersionResult = {
  stateVersion: number;
  leaseExpiresAt?: number;
  recoveryCompletedAt?: number;
};

type IncidentResult = {
  incidentId: string;
  stateVersion: number;
};

type RecoveryResult = {
  recoveryCommandId: string;
  stateVersion: number;
};

async function expectErrorCode(
  operation: Promise<unknown>,
  expectedCode: string,
) {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject({ data: { code: expectedCode } });
    return error;
  }

  throw new Error(`Expected operation to fail with ${expectedCode}`);
}

async function expectGenericAuthorizationFailure(
  operation: Promise<unknown>,
  suppliedSecret: string,
) {
  try {
    await operation;
  } catch (error) {
    const serialized = JSON.stringify(error);
    expect(String(error)).toMatch(/unauthorized/i);
    if (suppliedSecret) {
      expect(String(error)).not.toContain(suppliedSecret);
      expect(serialized).not.toContain(suppliedSecret);
    }
    expect(serialized).not.toContain(DEMO_SECRET);
    expect(serialized).not.toContain(RUNNER_TOKEN);
    return;
  }

  throw new Error("Expected an authorization failure");
}

function createHarness() {
  return convexTest(schema, modules);
}

async function makeRunnerFresh(t: ConvexHarness, runnerId = RUNNER_ID) {
  const result = await t.mutation(heartbeat, {
    runnerToken: RUNNER_TOKEN,
    runnerId,
  });
  await patchControl(t, { enabled: true });
  return result;
}

async function createQueuedCommand(t: ConvexHarness) {
  await makeRunnerFresh(t);
  return (await t.mutation(requestRun, {
    requestSecret: DEMO_SECRET,
  })) as DemoCommandResult;
}

async function getControl(t: ConvexHarness) {
  return await t.run(async (ctx) => {
    const controls = await ctx.db.query("demoControl" as never).collect();
    expect(controls).toHaveLength(1);
    return controls[0] as Record<string, unknown> & { _id: string };
  });
}

async function patchControl(t: ConvexHarness, patch: Record<string, unknown>) {
  const control = await getControl(t);
  await t.run(async (ctx) => {
    await ctx.db.patch(control._id as never, patch as never);
  });
}

async function tableRows(t: ConvexHarness, table: string) {
  return await t.run(async (ctx) => {
    return (await ctx.db.query(table as never).collect()) as Array<
      Record<string, unknown>
    >;
  });
}

async function authoritativeSnapshot(t: ConvexHarness) {
  return {
    commands: await tableRows(t, "demoCommands"),
    incidents: await tableRows(t, "incidents"),
    recoveries: await tableRows(t, "recoveryCommands"),
    control: await getControl(t),
  };
}

async function claimQueuedCommand(t: ConvexHarness) {
  const { demoCommandId } = await createQueuedCommand(t);
  const pending = (await t.query(getPendingDemoCommand, {
    runnerToken: RUNNER_TOKEN,
    runnerId: RUNNER_ID,
  })) as { _id: string; stateVersion: number };

  expect(pending._id).toBe(demoCommandId);

  const claimed = (await t.mutation(claimDemoCommand, {
    runnerToken: RUNNER_TOKEN,
    runnerId: RUNNER_ID,
    demoCommandId,
    expectedStateVersion: pending.stateVersion,
    claimNonce: CLAIM_NONCE,
  })) as VersionResult;

  return { demoCommandId, claimed };
}

async function confirmFailure(t: ConvexHarness) {
  const { demoCommandId, claimed } = await claimQueuedCommand(t);
  const reset = (await t.mutation(markResetApplied, {
    runnerToken: RUNNER_TOKEN,
    runnerId: RUNNER_ID,
    demoCommandId,
    expectedStateVersion: claimed.stateVersion,
  })) as VersionResult;
  const confirmed = (await t.mutation(markFailureConfirmed, {
    runnerToken: RUNNER_TOKEN,
    runnerId: RUNNER_ID,
    demoCommandId,
    expectedStateVersion: reset.stateVersion,
  })) as VersionResult;

  return { demoCommandId, confirmed };
}

async function createDetectedIncident(t: ConvexHarness) {
  const { demoCommandId, confirmed } = await confirmFailure(t);
  const incident = (await t.mutation(createIncidentFromConfirmedFailure, {
    runnerToken: RUNNER_TOKEN,
    runnerId: RUNNER_ID,
    demoCommandId,
    expectedCommandStateVersion: confirmed.stateVersion,
    initialHealth: "failed",
  })) as IncidentResult;

  return {
    demoCommandId,
    commandStateVersion: confirmed.stateVersion,
    incident,
  };
}

async function moveIncidentToInvestigating(t: ConvexHarness) {
  const created = await createDetectedIncident(t);
  const investigating = (await t.mutation(updateIncidentPhase, {
    runnerToken: RUNNER_TOKEN,
    runnerId: RUNNER_ID,
    demoCommandId: created.demoCommandId,
    incidentId: created.incident.incidentId,
    expectedPhase: "failed_detected",
    nextPhase: "investigating",
    expectedStateVersion: created.incident.stateVersion,
    expectedCommandStateVersion: created.commandStateVersion,
  })) as VersionResult;

  return { ...created, incidentStateVersion: investigating.stateVersion };
}

async function moveIncidentToPolicyCheck(
  t: ConvexHarness,
  decision: {
    incidentCategory?: string;
    requiresHuman?: boolean;
    proposedActionId?: "restart_demo_service" | "no_action";
  } = {},
) {
  const investigatingRun = await moveIncidentToInvestigating(t);
  const managerReview = (await t.mutation(updateIncidentPhase, {
    runnerToken: RUNNER_TOKEN,
    runnerId: RUNNER_ID,
    demoCommandId: investigatingRun.demoCommandId,
    incidentId: investigatingRun.incident.incidentId,
    expectedPhase: "investigating",
    nextPhase: "manager_review",
    expectedStateVersion: investigatingRun.incidentStateVersion,
    expectedCommandStateVersion: investigatingRun.commandStateVersion,
    incidentCategory: decision.incidentCategory ?? "service_stopped",
    diagnosisEvidence: [
      "Health check healthy: false",
      "Container status: exited",
    ],
    diagnosisSummary: "The fixed demo service is stopped.",
    confidence: 0.91,
    proposedActionId: decision.proposedActionId ?? "restart_demo_service",
    requiresHuman: decision.requiresHuman ?? false,
  })) as VersionResult;
  const policyCheck = (await t.mutation(updateIncidentPhase, {
    runnerToken: RUNNER_TOKEN,
    runnerId: RUNNER_ID,
    demoCommandId: investigatingRun.demoCommandId,
    incidentId: investigatingRun.incident.incidentId,
    expectedPhase: "manager_review",
    nextPhase: "policy_check",
    expectedStateVersion: managerReview.stateVersion,
    expectedCommandStateVersion: investigatingRun.commandStateVersion,
  })) as VersionResult;

  return {
    ...investigatingRun,
    incidentStateVersion: policyCheck.stateVersion,
  };
}

async function createAllowedRecovery(
  t: ConvexHarness,
  executionNonce = "allowed-recovery",
) {
  const ready = await moveIncidentToPolicyCheck(t);
  const recovery = (await t.mutation(createRecoveryCommand, {
    runnerToken: RUNNER_TOKEN,
    runnerId: RUNNER_ID,
    demoCommandId: ready.demoCommandId,
    incidentId: ready.incident.incidentId,
    expectedCommandStateVersion: ready.commandStateVersion,
    expectedIncidentPhase: "policy_check",
    expectedIncidentStateVersion: ready.incidentStateVersion,
    actionId: "restart_demo_service",
    executionNonce,
  })) as RecoveryResult;

  return { ...ready, recovery, executionNonce };
}

async function moveRecoveryToVerifying(
  t: ConvexHarness,
  executionNonce = "verified-recovery",
) {
  const ready = await createAllowedRecovery(t, executionNonce);
  const executing = (await t.mutation(updateIncidentPhase, {
    runnerToken: RUNNER_TOKEN,
    runnerId: RUNNER_ID,
    demoCommandId: ready.demoCommandId,
    incidentId: ready.incident.incidentId,
    expectedPhase: "policy_check",
    nextPhase: "executing",
    expectedStateVersion: ready.incidentStateVersion,
    expectedCommandStateVersion: ready.commandStateVersion,
    recoveryCommandId: ready.recovery.recoveryCommandId,
    expectedRecoveryStateVersion: ready.recovery.stateVersion,
    executionNonce,
  })) as VersionResult;
  vi.setSystemTime(Date.now() + 1_000);
  const verifying = (await t.mutation(updateIncidentPhase, {
    runnerToken: RUNNER_TOKEN,
    runnerId: RUNNER_ID,
    demoCommandId: ready.demoCommandId,
    incidentId: ready.incident.incidentId,
    expectedPhase: "executing",
    nextPhase: "verifying",
    expectedStateVersion: executing.stateVersion,
    expectedCommandStateVersion: ready.commandStateVersion,
    recoveryCommandId: ready.recovery.recoveryCommandId,
    expectedRecoveryStateVersion: 1,
    executionNonce,
    executionEvidence: {
      commandLabel: "docker start fixed demo service",
      exitCode: 0,
      startedAt: BASE_TIME,
      finishedAt: BASE_TIME + 100,
      latencyMs: 100,
    },
  })) as VersionResult;

  return { ...ready, verifying, recoveryStateVersion: 2 };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
  vi.stubEnv("DEMO_REQUEST_SECRET", DEMO_SECRET);
  vi.stubEnv("RUNNER_TOKEN", RUNNER_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("secret-protected demo requests", () => {
  it("rejects a missing or wrong request secret generically and writes nothing", async () => {
    for (const suppliedSecret of ["", "wrong-demo-secret"]) {
      const t = createHarness();
      await makeRunnerFresh(t);

      await expectGenericAuthorizationFailure(
        t.mutation(requestRun, { requestSecret: suppliedSecret }),
        suppliedSecret,
      );

      expect(await tableRows(t, "demoCommands")).toHaveLength(0);
      expect(await tableRows(t, "incidents")).toHaveLength(0);
      expect(await tableRows(t, "recoveryCommands")).toHaveLength(0);
      expect(await tableRows(t, "steps")).toHaveLength(0);
    }
  });

  it("accepts no caller-controlled scenario, command, action, path, URL, or prompt", async () => {
    const t = createHarness();
    await makeRunnerFresh(t);

    await expect(
      t.mutation(requestRun, {
        requestSecret: DEMO_SECRET,
        scenario: "stop-any-container",
      }),
    ).rejects.toThrow();

    expect(await tableRows(t, "demoCommands")).toHaveLength(0);
  });
});

describe("bounded demo command creation", () => {
  it("creates the operator kill switch disabled by default", async () => {
    const t = createHarness();

    await t.mutation(heartbeat, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
    });

    expect(await getControl(t)).toMatchObject({ enabled: false });
    await expectErrorCode(
      t.mutation(requestRun, { requestSecret: DEMO_SECRET }),
      "DEMO_DISABLED",
    );
    expect(await tableRows(t, "demoCommands")).toHaveLength(0);
  });

  it("creates only one fixed queued command with a 90-second expiry", async () => {
    const t = createHarness();
    const result = await createQueuedCommand(t);

    const commands = await tableRows(t, "demoCommands");
    const incidents = await tableRows(t, "incidents");
    const recoveryCommands = await tableRows(t, "recoveryCommands");
    const steps = await tableRows(t, "steps");
    const control = await getControl(t);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      _id: result.demoCommandId,
      status: "queued",
      createdAt: BASE_TIME,
      expiresAt: BASE_TIME + 90_000,
      stateVersion: 0,
    });
    expect(commands[0].idempotencyKey).toEqual(expect.any(String));
    expect(String(commands[0].idempotencyKey)).not.toContain(DEMO_SECRET);
    expect(commands[0]).not.toHaveProperty("scenario");
    expect(commands[0]).not.toHaveProperty("actionId");
    expect(commands[0]).not.toHaveProperty("command");
    expect(commands[0]).not.toHaveProperty("prompt");
    expect(incidents).toHaveLength(0);
    expect(recoveryCommands).toHaveLength(0);
    expect(steps).toHaveLength(0);
    expect(control).toMatchObject({
      activeDemoCommandId: result.demoCommandId,
      dayKey: UTC_DAY,
      dayCount: 1,
      lastRequestedAt: BASE_TIME,
    });
  });

  it("serializes simultaneous requests so exactly one command wins", async () => {
    const t = createHarness();
    await makeRunnerFresh(t);

    const results = await Promise.allSettled([
      t.mutation(requestRun, { requestSecret: DEMO_SECRET }),
      t.mutation(requestRun, { requestSecret: DEMO_SECRET }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(await tableRows(t, "demoCommands")).toHaveLength(1);
    expect((await getControl(t)).dayCount).toBe(1);
  });

  it("rejects requests while the operator kill switch is disabled", async () => {
    const t = createHarness();
    await makeRunnerFresh(t);
    await patchControl(t, { enabled: false });

    await expectErrorCode(
      t.mutation(requestRun, { requestSecret: DEMO_SECRET }),
      "DEMO_DISABLED",
    );
    expect(await tableRows(t, "demoCommands")).toHaveLength(0);
  });

  it("treats a 15-second heartbeat as fresh and 15,001ms as offline", async () => {
    const freshBoundary = createHarness();
    await makeRunnerFresh(freshBoundary);
    vi.setSystemTime(BASE_TIME + 15_000);
    await expect(
      freshBoundary.mutation(requestRun, { requestSecret: DEMO_SECRET }),
    ).resolves.toMatchObject({ demoCommandId: expect.any(String) });

    vi.setSystemTime(BASE_TIME);
    const stale = createHarness();
    await makeRunnerFresh(stale);
    vi.setSystemTime(BASE_TIME + 15_001);
    await expectErrorCode(
      stale.mutation(requestRun, { requestSecret: DEMO_SECRET }),
      "RUNNER_OFFLINE",
    );
    expect(await tableRows(stale, "demoCommands")).toHaveLength(0);
  });

  it("rejects when a command or incident is already active", async () => {
    const t = createHarness();
    await createQueuedCommand(t);

    await expectErrorCode(
      t.mutation(requestRun, { requestSecret: DEMO_SECRET }),
      "ACTIVE_RUN",
    );
    expect(await tableRows(t, "demoCommands")).toHaveLength(1);

    const incidentActive = createHarness();
    await createDetectedIncident(incidentActive);
    await patchControl(incidentActive, {
      activeDemoCommandId: undefined,
      lastRequestedAt: undefined,
    });
    await expectErrorCode(
      incidentActive.mutation(requestRun, { requestSecret: DEMO_SECRET }),
      "ACTIVE_RUN",
    );
  });

  it("enforces a 60-second cooldown and accepts exactly at the boundary", async () => {
    const t = createHarness();
    await makeRunnerFresh(t);
    await patchControl(t, {
      activeDemoCommandId: undefined,
      activeIncidentId: undefined,
      lastRequestedAt: BASE_TIME - 59_999,
      dayKey: UTC_DAY,
      dayCount: 1,
    });

    await expectErrorCode(
      t.mutation(requestRun, { requestSecret: DEMO_SECRET }),
      "COOLDOWN",
    );

    await patchControl(t, { lastRequestedAt: BASE_TIME - 60_000 });
    await expect(
      t.mutation(requestRun, { requestSecret: DEMO_SECRET }),
    ).resolves.toMatchObject({ demoCommandId: expect.any(String) });
  });

  it("caps accepted requests at 30 per UTC day and resets on rollover", async () => {
    const t = createHarness();
    await makeRunnerFresh(t);
    await patchControl(t, {
      activeDemoCommandId: undefined,
      activeIncidentId: undefined,
      lastRequestedAt: undefined,
      dayKey: UTC_DAY,
      dayCount: 30,
    });

    await expectErrorCode(
      t.mutation(requestRun, { requestSecret: DEMO_SECRET }),
      "DAILY_CAP",
    );

    const nextDay = Date.UTC(2026, 7, 31, 0, 0, 0);
    vi.setSystemTime(nextDay);
    await makeRunnerFresh(t);
    const accepted = (await t.mutation(requestRun, {
      requestSecret: DEMO_SECRET,
    })) as DemoCommandResult;

    expect(accepted.demoCommandId).toEqual(expect.any(String));
    expect(await getControl(t)).toMatchObject({
      dayKey: "2026-08-31",
      dayCount: 1,
    });
  });
});

describe("runner authentication and atomic claims", () => {
  it("checks the runner token before heartbeat, pending reads, claims, or writes", async () => {
    const wrongToken = "wrong-runner-token";
    const t = createHarness();

    await expectGenericAuthorizationFailure(
      t.mutation(heartbeat, {
        runnerToken: wrongToken,
        runnerId: RUNNER_ID,
      }),
      wrongToken,
    );
    expect(await tableRows(t, "demoControl")).toHaveLength(0);

    await makeRunnerFresh(t);
    const { demoCommandId } = (await t.mutation(requestRun, {
      requestSecret: DEMO_SECRET,
    })) as DemoCommandResult;

    await expectGenericAuthorizationFailure(
      t.query(getPendingDemoCommand, {
        runnerToken: wrongToken,
        runnerId: RUNNER_ID,
      }),
      wrongToken,
    );
    await expectGenericAuthorizationFailure(
      t.mutation(claimDemoCommand, {
        runnerToken: wrongToken,
        runnerId: RUNNER_ID,
        demoCommandId,
        expectedStateVersion: 0,
        claimNonce: "unauthorized-claim",
      }),
      wrongToken,
    );
    await expectGenericAuthorizationFailure(
      t.mutation(appendStep, {
        runnerToken: wrongToken,
        runnerId: RUNNER_ID,
        demoCommandId,
        expectedCommandStateVersion: 0,
        stepNonce: "unauthorized-step",
        role: "incident_manager",
        kind: "status",
        status: "running",
        sanitizedOutput: "must not be written",
        startedAt: BASE_TIME,
      }),
      wrongToken,
    );

    expect(await tableRows(t, "steps")).toHaveLength(0);
    expect(await tableRows(t, "demoCommands")).toEqual([
      expect.objectContaining({ status: "queued", stateVersion: 0 }),
    ]);
  });

  it("checks the token first on every incident and recovery write", async () => {
    const wrongToken = "wrong-token-for-all-writes";
    const t = createHarness();
    const ready = await moveIncidentToPolicyCheck(t);
    const recovery = (await t.mutation(createRecoveryCommand, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: ready.demoCommandId,
      incidentId: ready.incident.incidentId,
      expectedCommandStateVersion: ready.commandStateVersion,
      expectedIncidentPhase: "policy_check",
      expectedIncidentStateVersion: ready.incidentStateVersion,
      actionId: "restart_demo_service",
      executionNonce: "authorized-fixture-execution",
    })) as RecoveryResult;
    const before = {
      commands: await tableRows(t, "demoCommands"),
      incidents: await tableRows(t, "incidents"),
      recoveries: await tableRows(t, "recoveryCommands"),
      steps: await tableRows(t, "steps"),
    };

    const protectedWrites = [
      () =>
        t.mutation(markResetApplied, {
          runnerToken: wrongToken,
          runnerId: RUNNER_ID,
          demoCommandId: ready.demoCommandId,
          expectedStateVersion: ready.commandStateVersion,
        }),
      () =>
        t.mutation(markFailureConfirmed, {
          runnerToken: wrongToken,
          runnerId: RUNNER_ID,
          demoCommandId: ready.demoCommandId,
          expectedStateVersion: ready.commandStateVersion,
        }),
      () =>
        t.mutation(createIncidentFromConfirmedFailure, {
          runnerToken: wrongToken,
          runnerId: RUNNER_ID,
          demoCommandId: ready.demoCommandId,
          expectedCommandStateVersion: ready.commandStateVersion,
          initialHealth: "failed",
        }),
      () =>
        t.mutation(appendStep, {
          runnerToken: wrongToken,
          runnerId: RUNNER_ID,
          demoCommandId: ready.demoCommandId,
          incidentId: ready.incident.incidentId,
          expectedCommandStateVersion: ready.commandStateVersion,
          expectedIncidentStateVersion: ready.incidentStateVersion,
          stepNonce: "blocked-step",
          role: "investigator",
          kind: "evidence",
          status: "succeeded",
          sanitizedOutput: "must not be stored",
          startedAt: BASE_TIME,
        }),
      () =>
        t.mutation(createRecoveryCommand, {
          runnerToken: wrongToken,
          runnerId: RUNNER_ID,
          demoCommandId: ready.demoCommandId,
          incidentId: ready.incident.incidentId,
          expectedCommandStateVersion: ready.commandStateVersion,
          expectedIncidentPhase: "policy_check",
          expectedIncidentStateVersion: ready.incidentStateVersion,
          actionId: "restart_demo_service",
          executionNonce: "blocked-execution",
        }),
      () =>
        t.mutation(updateIncidentPhase, {
          runnerToken: wrongToken,
          runnerId: RUNNER_ID,
          demoCommandId: ready.demoCommandId,
          incidentId: ready.incident.incidentId,
          expectedPhase: "policy_check",
          nextPhase: "executing",
          expectedStateVersion: ready.incidentStateVersion,
          expectedCommandStateVersion: ready.commandStateVersion,
          recoveryCommandId: recovery.recoveryCommandId,
          expectedRecoveryStateVersion: recovery.stateVersion,
          executionNonce: "authorized-fixture-execution",
        }),
      () =>
        t.mutation(completeIncident, {
          runnerToken: wrongToken,
          runnerId: RUNNER_ID,
          demoCommandId: ready.demoCommandId,
          incidentId: ready.incident.incidentId,
          recoveryCommandId: recovery.recoveryCommandId,
          executionNonce: "authorized-fixture-execution",
          expectedPhase: "verifying",
          expectedIncidentStateVersion: ready.incidentStateVersion,
          expectedCommandStateVersion: ready.commandStateVersion,
          expectedRecoveryStateVersion: recovery.stateVersion,
          terminalState: "resolved",
          finalHealth: "healthy",
          verification: {
            service: "gx-autodevops-demo-service",
            status: "healthy",
            httpStatus: 200,
            requestStartedAt: BASE_TIME + 1_000,
            checkedAt: BASE_TIME + 1_001,
          },
        }),
    ];

    for (const operation of protectedWrites) {
      await expectGenericAuthorizationFailure(operation(), wrongToken);
    }

    expect({
      commands: await tableRows(t, "demoCommands"),
      incidents: await tableRows(t, "incidents"),
      recoveries: await tableRows(t, "recoveryCommands"),
      steps: await tableRows(t, "steps"),
    }).toEqual(before);
  });

  it("lets only one runner claim a queued command", async () => {
    const t = createHarness();
    const { demoCommandId } = await createQueuedCommand(t);

    const claims = await Promise.allSettled([
      t.mutation(claimDemoCommand, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId,
        expectedStateVersion: 0,
        claimNonce: "competing-claim-a",
      }),
      t.mutation(claimDemoCommand, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId,
        expectedStateVersion: 0,
        claimNonce: "competing-claim-b",
      }),
    ]);

    expect(
      claims.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      claims.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(await tableRows(t, "demoCommands")).toEqual([
      expect.objectContaining({
        _id: demoCommandId,
        status: "claimed",
        runnerId: RUNNER_ID,
        stateVersion: 1,
        leaseExpiresAt: BASE_TIME + 30_000,
      }),
    ]);
  });

  it("does not claim an expired queued command", async () => {
    const t = createHarness();
    const { demoCommandId } = await createQueuedCommand(t);
    vi.setSystemTime(BASE_TIME + 90_001);

    await expect(
      t.mutation(claimDemoCommand, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId,
        expectedStateVersion: 0,
        claimNonce: "expired-command-claim",
      }),
    ).resolves.toEqual({ status: "expired", code: "COMMAND_EXPIRED" });
    expect(await tableRows(t, "demoCommands")).toEqual([
      expect.objectContaining({ status: "expired" }),
    ]);
  });

  it("rejects the wrong runner, stale lease, stale version, and wrong phase", async () => {
    const wrongRunner = createHarness();
    const wrongRunnerClaim = await claimQueuedCommand(wrongRunner);
    await expectErrorCode(
      wrongRunner.mutation(markResetApplied, {
        runnerToken: RUNNER_TOKEN,
        runnerId: OTHER_RUNNER_ID,
        demoCommandId: wrongRunnerClaim.demoCommandId,
        expectedStateVersion: wrongRunnerClaim.claimed.stateVersion,
      }),
      "RUNNER_MISMATCH",
    );

    const staleVersion = createHarness();
    const staleVersionClaim = await claimQueuedCommand(staleVersion);
    await expectErrorCode(
      staleVersion.mutation(markResetApplied, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: staleVersionClaim.demoCommandId,
        expectedStateVersion: 0,
      }),
      "STALE_STATE",
    );

    const leaseBoundary = createHarness();
    const leaseBoundaryClaim = await claimQueuedCommand(leaseBoundary);
    vi.setSystemTime(leaseBoundaryClaim.claimed.leaseExpiresAt ?? BASE_TIME);
    await expect(
      leaseBoundary.mutation(markResetApplied, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: leaseBoundaryClaim.demoCommandId,
        expectedStateVersion: leaseBoundaryClaim.claimed.stateVersion,
      }),
    ).resolves.toMatchObject({ stateVersion: 2 });

    vi.setSystemTime(BASE_TIME);
    const staleLease = createHarness();
    const staleLeaseClaim = await claimQueuedCommand(staleLease);
    vi.setSystemTime((staleLeaseClaim.claimed.leaseExpiresAt ?? BASE_TIME) + 1);
    await expectErrorCode(
      staleLease.mutation(markResetApplied, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: staleLeaseClaim.demoCommandId,
        expectedStateVersion: staleLeaseClaim.claimed.stateVersion,
      }),
      "LEASE_EXPIRED",
    );

    vi.setSystemTime(BASE_TIME);
    const wrongPhase = createHarness();
    const wrongPhaseClaim = await claimQueuedCommand(wrongPhase);
    await expectErrorCode(
      wrongPhase.mutation(markFailureConfirmed, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: wrongPhaseClaim.demoCommandId,
        expectedStateVersion: wrongPhaseClaim.claimed.stateVersion,
      }),
      "INVALID_STATE",
    );
  });
});

describe("runner resume, retry, and lease cleanup", () => {
  it("returns a claimed command so the same runner can resume after restart", async () => {
    const t = createHarness();
    const { demoCommandId, claimed } = await claimQueuedCommand(t);

    await expect(
      t.query(getActiveDemoCommand, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
      }),
    ).resolves.toMatchObject({
      _id: demoCommandId,
      status: "claimed",
      stateVersion: claimed.stateVersion,
      leaseExpiresAt: claimed.leaseExpiresAt,
    });
  });

  it("returns authoritative incident and recovery state needed to resume", async () => {
    const t = createHarness();
    const ready = await createAllowedRecovery(t, "resume-recovery");

    await expect(
      t.query(getActiveDemoCommand, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
      }),
    ).resolves.toMatchObject({
      _id: ready.demoCommandId,
      status: "failure_confirmed",
      stateVersion: ready.commandStateVersion,
      incident: {
        _id: ready.incident.incidentId,
        currentPhase: "policy_check",
        stateVersion: ready.incidentStateVersion,
        incidentCategory: "service_stopped",
        diagnosisEvidence: [
          "Health check healthy: false",
          "Container status: exited",
        ],
        requiresHuman: false,
      },
      recovery: {
        _id: ready.recovery.recoveryCommandId,
        status: "allowed",
        stateVersion: ready.recovery.stateVersion,
        actionId: "restart_demo_service",
        executionNonce: "resume-recovery",
      },
    });
  });

  it("returns existing step nonces so a restarted runner never replays a changed step", async () => {
    const t = createHarness();
    const ready = await moveIncidentToPolicyCheck(t);
    await t.mutation(appendStep, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: ready.demoCommandId,
      incidentId: ready.incident.incidentId,
      expectedCommandStateVersion: ready.commandStateVersion,
      expectedIncidentStateVersion: ready.incidentStateVersion,
      stepNonce: "resume_safe_manager_step",
      role: "incident_manager",
      kind: "manager_evidence_review",
      status: "succeeded",
      sanitizedOutput: "Reviewed the persisted diagnosis.",
      startedAt: BASE_TIME,
      finishedAt: BASE_TIME + 5,
      latencyMs: 5,
      costStatus: "not_reported",
    });

    await expect(
      t.query(getActiveDemoCommand, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
      }),
    ).resolves.toMatchObject({
      stepNonces: ["resume_safe_manager_step"],
    });
  });

  it("fails and releases a claimed pre-incident command immediately", async () => {
    const t = createHarness();
    const { demoCommandId, claimed } = await claimQueuedCommand(t);

    await expect(
      t.mutation(failDemoCommand, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId,
        expectedStateVersion: claimed.stateVersion,
        terminalReason: "failed_to_seed_disposable_service",
      }),
    ).resolves.toEqual({ status: "failed", stateVersion: 2 });

    await expect(
      t.query(getActiveDemoCommand, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
      }),
    ).resolves.toBeNull();
    const control = await getControl(t);
    expect(control).not.toHaveProperty("activeDemoCommandId");
    expect(control).not.toHaveProperty("activeIncidentId");
  });

  it("returns the server recovery timestamp required for a fresh health request", async () => {
    const t = createHarness();
    const ready = await moveRecoveryToVerifying(t, "server-time-recovery");

    expect(ready.verifying.recoveryCompletedAt).toBe(BASE_TIME + 1_000);
    await expect(
      t.query(getActiveDemoCommand, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
      }),
    ).resolves.toMatchObject({
      recovery: { completedAt: BASE_TIME + 1_000 },
    });
  });

  it("renews at the exact lease boundary without changing the state version", async () => {
    const t = createHarness();
    const { demoCommandId, claimed } = await claimQueuedCommand(t);
    vi.setSystemTime(claimed.leaseExpiresAt ?? BASE_TIME);

    await expect(
      t.mutation(renewLease, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId,
        expectedStateVersion: claimed.stateVersion,
      }),
    ).resolves.toEqual({
      stateVersion: claimed.stateVersion,
      leaseExpiresAt: BASE_TIME + 60_000,
    });
  });

  it("rejects lease renewal for a stale version, wrong runner, or expired lease", async () => {
    const staleVersion = createHarness();
    const stale = await claimQueuedCommand(staleVersion);
    await expectErrorCode(
      staleVersion.mutation(renewLease, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: stale.demoCommandId,
        expectedStateVersion: 0,
      }),
      "STALE_STATE",
    );

    const wrongRunner = createHarness();
    const wrong = await claimQueuedCommand(wrongRunner);
    await expectErrorCode(
      wrongRunner.mutation(renewLease, {
        runnerToken: RUNNER_TOKEN,
        runnerId: OTHER_RUNNER_ID,
        demoCommandId: wrong.demoCommandId,
        expectedStateVersion: wrong.claimed.stateVersion,
      }),
      "RUNNER_MISMATCH",
    );

    const expiredLease = createHarness();
    const expired = await claimQueuedCommand(expiredLease);
    vi.setSystemTime((expired.claimed.leaseExpiresAt ?? BASE_TIME) + 1);
    const before = await tableRows(expiredLease, "demoCommands");
    await expectErrorCode(
      expiredLease.mutation(renewLease, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: expired.demoCommandId,
        expectedStateVersion: expired.claimed.stateVersion,
      }),
      "LEASE_EXPIRED",
    );
    expect(await tableRows(expiredLease, "demoCommands")).toEqual(before);
  });

  it("makes exact retries of claim, reset, and failure confirmation idempotent", async () => {
    const t = createHarness();
    const { demoCommandId } = await createQueuedCommand(t);
    const claimArgs = {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId,
      expectedStateVersion: 0,
      claimNonce: "retry-the-same-claim",
    };
    const firstClaim = await t.mutation(claimDemoCommand, claimArgs);
    const secondClaim = await t.mutation(claimDemoCommand, claimArgs);
    expect(secondClaim).toEqual(firstClaim);

    const resetArgs = {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId,
      expectedStateVersion: 1,
    };
    const firstReset = await t.mutation(markResetApplied, resetArgs);
    const secondReset = await t.mutation(markResetApplied, resetArgs);
    expect(secondReset).toEqual(firstReset);

    const failureArgs = {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId,
      expectedStateVersion: 2,
    };
    const firstFailure = await t.mutation(markFailureConfirmed, failureArgs);
    const secondFailure = await t.mutation(markFailureConfirmed, failureArgs);
    expect(secondFailure).toEqual(firstFailure);
    expect(await tableRows(t, "demoCommands")).toEqual([
      expect.objectContaining({
        status: "failure_confirmed",
        stateVersion: 3,
      }),
    ]);
  });

  it("heartbeat expires a queued command and clears its lock without throwing", async () => {
    const t = createHarness();
    const { demoCommandId } = await createQueuedCommand(t);
    vi.setSystemTime(BASE_TIME + 90_001);

    await expect(
      t.mutation(heartbeat, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
      }),
    ).resolves.toMatchObject({ runnerHeartbeatAt: BASE_TIME + 90_001 });
    expect(await tableRows(t, "demoCommands")).toEqual([
      expect.objectContaining({
        _id: demoCommandId,
        status: "expired",
        finishedAt: BASE_TIME + 90_001,
      }),
    ]);
    expect(await getControl(t)).not.toHaveProperty("activeDemoCommandId");
  });

  it("heartbeat fails an expired claimed command before any incident exists", async () => {
    const t = createHarness();
    const { demoCommandId, claimed } = await claimQueuedCommand(t);
    vi.setSystemTime((claimed.leaseExpiresAt ?? BASE_TIME) + 1);

    await t.mutation(heartbeat, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
    });

    expect(await tableRows(t, "demoCommands")).toEqual([
      expect.objectContaining({
        _id: demoCommandId,
        status: "failed",
        finishedAt: Date.now(),
      }),
    ]);
    expect(await tableRows(t, "incidents")).toHaveLength(0);
    const control = await getControl(t);
    expect(control).not.toHaveProperty("activeDemoCommandId");
    expect(control).not.toHaveProperty("activeIncidentId");
  });

  it("heartbeat terminalizes an active incident when its runner lease expires", async () => {
    const t = createHarness();
    const created = await createDetectedIncident(t);
    const [activeCommand] = await tableRows(t, "demoCommands");
    vi.setSystemTime(Number(activeCommand.leaseExpiresAt) + 1);

    await t.mutation(heartbeat, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
    });

    expect(await tableRows(t, "demoCommands")).toEqual([
      expect.objectContaining({
        _id: created.demoCommandId,
        status: "failed",
      }),
    ]);
    expect(await tableRows(t, "incidents")).toEqual([
      expect.objectContaining({
        _id: created.incident.incidentId,
        currentPhase: "investigation_failed",
        terminalReason: "runner_lease_expired",
        finishedAt: Date.now(),
      }),
    ]);
    const control = await getControl(t);
    expect(control).not.toHaveProperty("activeDemoCommandId");
    expect(control).not.toHaveProperty("activeIncidentId");
  });
});

describe("persisted diagnosis autonomy boundary", () => {
  it("blocks recovery creation when the Investigator required a human", async () => {
    const t = createHarness();
    const ready = await moveIncidentToPolicyCheck(t, {
      requiresHuman: true,
    });

    await expectErrorCode(
      t.mutation(createRecoveryCommand, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: ready.demoCommandId,
        incidentId: ready.incident.incidentId,
        expectedCommandStateVersion: ready.commandStateVersion,
        expectedIncidentPhase: "policy_check",
        expectedIncidentStateVersion: ready.incidentStateVersion,
        actionId: "restart_demo_service",
        executionNonce: "human-required-recovery",
      }),
      "POLICY_DENIED",
    );
  });

  it("blocks recovery when no grounded diagnosis evidence was persisted", async () => {
    const t = createHarness();
    const investigatingRun = await moveIncidentToInvestigating(t);
    const managerReview = (await t.mutation(updateIncidentPhase, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: investigatingRun.demoCommandId,
      incidentId: investigatingRun.incident.incidentId,
      expectedPhase: "investigating",
      nextPhase: "manager_review",
      expectedStateVersion: investigatingRun.incidentStateVersion,
      expectedCommandStateVersion: investigatingRun.commandStateVersion,
      incidentCategory: "service_stopped",
      diagnosisSummary: "The fixed demo service is stopped.",
      confidence: 0.91,
      proposedActionId: "restart_demo_service",
      requiresHuman: false,
    })) as VersionResult;
    const policyCheck = (await t.mutation(updateIncidentPhase, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: investigatingRun.demoCommandId,
      incidentId: investigatingRun.incident.incidentId,
      expectedPhase: "manager_review",
      nextPhase: "policy_check",
      expectedStateVersion: managerReview.stateVersion,
      expectedCommandStateVersion: investigatingRun.commandStateVersion,
    })) as VersionResult;

    await expectErrorCode(
      t.mutation(createRecoveryCommand, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: investigatingRun.demoCommandId,
        incidentId: investigatingRun.incident.incidentId,
        expectedCommandStateVersion: investigatingRun.commandStateVersion,
        expectedIncidentPhase: "policy_check",
        expectedIncidentStateVersion: policyCheck.stateVersion,
        actionId: "restart_demo_service",
        executionNonce: "missing-evidence-recovery",
      }),
      "POLICY_DENIED",
    );
  });
});

describe("incident creation and ordered trace", () => {
  it("does not create an incident until failed health is confirmed", async () => {
    const t = createHarness();
    const { demoCommandId, claimed } = await claimQueuedCommand(t);

    await expectErrorCode(
      t.mutation(createIncidentFromConfirmedFailure, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId,
        expectedCommandStateVersion: claimed.stateVersion,
        initialHealth: "failed",
      }),
      "INVALID_STATE",
    );
    expect(await tableRows(t, "incidents")).toHaveLength(0);

    const reset = (await t.mutation(markResetApplied, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId,
      expectedStateVersion: claimed.stateVersion,
    })) as VersionResult;
    await expectErrorCode(
      t.mutation(createIncidentFromConfirmedFailure, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId,
        expectedCommandStateVersion: reset.stateVersion,
        initialHealth: "failed",
      }),
      "INVALID_STATE",
    );
    expect(await tableRows(t, "incidents")).toHaveLength(0);

    const confirmed = (await t.mutation(markFailureConfirmed, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId,
      expectedStateVersion: reset.stateVersion,
    })) as VersionResult;
    const created = (await t.mutation(createIncidentFromConfirmedFailure, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId,
      expectedCommandStateVersion: confirmed.stateVersion,
      initialHealth: "failed",
    })) as IncidentResult;

    expect(created.incidentId).toEqual(expect.any(String));
    expect(await tableRows(t, "incidents")).toEqual([
      expect.objectContaining({
        _id: created.incidentId,
        demoCommandId,
        currentPhase: "failed_detected",
        initialHealth: "failed",
        stateVersion: 0,
      }),
    ]);
    expect(await getControl(t)).toMatchObject({
      activeDemoCommandId: demoCommandId,
      activeIncidentId: created.incidentId,
    });
  });

  it("assigns contiguous server sequence numbers under parallel writes", async () => {
    const t = createHarness();
    const created = await createDetectedIncident(t);

    const baseArgs = {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: created.demoCommandId,
      incidentId: created.incident.incidentId,
      expectedCommandStateVersion: created.commandStateVersion,
      expectedIncidentStateVersion: created.incident.stateVersion,
      role: "investigator",
      kind: "evidence",
      status: "succeeded",
      startedAt: BASE_TIME,
    };

    await Promise.all([
      t.mutation(appendStep, {
        ...baseArgs,
        stepNonce: "step-a",
        sanitizedOutput: "first concurrent step",
      }),
      t.mutation(appendStep, {
        ...baseArgs,
        stepNonce: "step-b",
        sanitizedOutput: "second concurrent step",
      }),
      t.mutation(appendStep, {
        ...baseArgs,
        stepNonce: "step-c",
        sanitizedOutput: "third concurrent step",
      }),
    ]);

    const rows = await tableRows(t, "steps");
    expect(rows).toHaveLength(3);
    expect(
      rows.map((row) => row.sequence).sort((a, b) => Number(a) - Number(b)),
    ).toEqual([1, 2, 3]);
  });

  it("uses a stable step nonce so a replay creates no second logical step", async () => {
    const t = createHarness();
    const created = await createDetectedIncident(t);
    const args = {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: created.demoCommandId,
      incidentId: created.incident.incidentId,
      expectedCommandStateVersion: created.commandStateVersion,
      expectedIncidentStateVersion: created.incident.stateVersion,
      stepNonce: "stable-investigation-step",
      role: "investigator",
      kind: "evidence",
      status: "succeeded",
      sanitizedOutput: "Container is stopped.",
      startedAt: BASE_TIME,
    };

    const results = await Promise.all([
      t.mutation(appendStep, args),
      t.mutation(appendStep, args),
    ]);

    expect(results[0]).toMatchObject({
      stepId: expect.any(String),
      sequence: 1,
    });
    expect(results[1]).toMatchObject({
      stepId: (results[0] as { stepId: string }).stepId,
      sequence: 1,
    });
    expect(await tableRows(t, "steps")).toEqual([
      expect.objectContaining({
        stepNonce: "stable-investigation-step",
        sequence: 1,
      }),
    ]);
  });

  it("rejects a conflicting payload that reuses an existing step nonce", async () => {
    const t = createHarness();
    const created = await createDetectedIncident(t);
    const baseArgs = {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: created.demoCommandId,
      incidentId: created.incident.incidentId,
      expectedCommandStateVersion: created.commandStateVersion,
      expectedIncidentStateVersion: created.incident.stateVersion,
      stepNonce: "conflicting-step-retry",
      role: "investigator",
      kind: "evidence",
      status: "succeeded",
      startedAt: BASE_TIME,
    };

    await t.mutation(appendStep, {
      ...baseArgs,
      sanitizedOutput: "The fixed service is stopped.",
    });
    const before = await tableRows(t, "steps");
    await expectErrorCode(
      t.mutation(appendStep, {
        ...baseArgs,
        sanitizedOutput: "A conflicting replacement payload.",
      }),
      "STEP_REPLAY_MISMATCH",
    );
    expect(await tableRows(t, "steps")).toEqual(before);
  });

  it("sanitizes and bounds step output before persistence", async () => {
    const t = createHarness();
    const created = await createDetectedIncident(t);
    const secretOutput = `\u001b[31mtoken=abc123 password=hunter2\u001b[0m ${"x".repeat(5_000)}`;

    await t.mutation(appendStep, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: created.demoCommandId,
      incidentId: created.incident.incidentId,
      expectedCommandStateVersion: created.commandStateVersion,
      expectedIncidentStateVersion: created.incident.stateVersion,
      stepNonce: "redaction-step",
      role: "investigator",
      kind: "tool_output",
      status: "succeeded",
      sanitizedOutput: secretOutput,
      startedAt: BASE_TIME,
    });

    const [stored] = await tableRows(t, "steps");
    expect(stored.sanitizedOutput).not.toContain("abc123");
    expect(stored.sanitizedOutput).not.toContain("hunter2");
    expect(stored.sanitizedOutput).not.toContain("\u001b");
    expect(String(stored.sanitizedOutput)).toContain("[REDACTED]");
    expect(String(stored.sanitizedOutput).length).toBeLessThanOrEqual(4_000);
  });
});

describe("recovery state and completion", () => {
  it("requires exact successful execution evidence before verification", async () => {
    const t = createHarness();
    const ready = await createAllowedRecovery(t, "evidence-required");
    const executing = (await t.mutation(updateIncidentPhase, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: ready.demoCommandId,
      incidentId: ready.incident.incidentId,
      expectedPhase: "policy_check",
      nextPhase: "executing",
      expectedStateVersion: ready.incidentStateVersion,
      expectedCommandStateVersion: ready.commandStateVersion,
      recoveryCommandId: ready.recovery.recoveryCommandId,
      expectedRecoveryStateVersion: ready.recovery.stateVersion,
      executionNonce: ready.executionNonce,
    })) as VersionResult;
    const baseInput = {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: ready.demoCommandId,
      incidentId: ready.incident.incidentId,
      expectedPhase: "executing" as const,
      nextPhase: "verifying" as const,
      expectedStateVersion: executing.stateVersion,
      expectedCommandStateVersion: ready.commandStateVersion,
      recoveryCommandId: ready.recovery.recoveryCommandId,
      expectedRecoveryStateVersion: 1,
      executionNonce: ready.executionNonce,
    };

    await expectErrorCode(
      t.mutation(updateIncidentPhase, baseInput),
      "EXECUTION_EVIDENCE_REQUIRED",
    );

    for (const executionEvidence of [
      {
        commandLabel: "docker start another service",
        exitCode: 0,
        startedAt: BASE_TIME,
        finishedAt: BASE_TIME + 100,
        latencyMs: 100,
      },
      {
        commandLabel: "docker start fixed demo service",
        exitCode: 1,
        startedAt: BASE_TIME,
        finishedAt: BASE_TIME + 100,
        latencyMs: 100,
      },
      {
        commandLabel: "docker start fixed demo service",
        exitCode: 0,
        startedAt: BASE_TIME - 1,
        finishedAt: BASE_TIME + 99,
        latencyMs: 100,
      },
    ]) {
      await expectErrorCode(
        t.mutation(updateIncidentPhase, {
          ...baseInput,
          executionEvidence,
        }),
        "INVALID_EXECUTION_EVIDENCE",
      );
    }
  });

  it("returns the same recovery for an identical retry and rejects a conflicting nonce", async () => {
    const t = createHarness();
    const ready = await moveIncidentToPolicyCheck(t);
    const recovery = (await t.mutation(createRecoveryCommand, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: ready.demoCommandId,
      incidentId: ready.incident.incidentId,
      expectedCommandStateVersion: ready.commandStateVersion,
      expectedIncidentPhase: "policy_check",
      expectedIncidentStateVersion: ready.incidentStateVersion,
      actionId: "restart_demo_service",
      executionNonce: "execution-once",
    })) as RecoveryResult;

    expect(await tableRows(t, "recoveryCommands")).toEqual([
      expect.objectContaining({
        _id: recovery.recoveryCommandId,
        incidentId: ready.incident.incidentId,
        actionId: "restart_demo_service",
        executionNonce: "execution-once",
      }),
    ]);

    await expect(
      t.mutation(createRecoveryCommand, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: ready.demoCommandId,
        incidentId: ready.incident.incidentId,
        expectedCommandStateVersion: ready.commandStateVersion,
        expectedIncidentPhase: "policy_check",
        expectedIncidentStateVersion: ready.incidentStateVersion,
        actionId: "restart_demo_service",
        executionNonce: "execution-once",
      }),
    ).resolves.toEqual(recovery);

    await expectErrorCode(
      t.mutation(createRecoveryCommand, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: ready.demoCommandId,
        incidentId: ready.incident.incidentId,
        expectedCommandStateVersion: ready.commandStateVersion,
        expectedIncidentPhase: "policy_check",
        expectedIncidentStateVersion: ready.incidentStateVersion,
        actionId: "restart_demo_service",
        executionNonce: "different-execution",
      }),
      "EXECUTION_REPLAY",
    );
    expect(await tableRows(t, "recoveryCommands")).toHaveLength(1);
  });

  it("rejects reuse of an execution nonce for a different incident", async () => {
    const t = createHarness();
    const first = await createAllowedRecovery(t, "global-execution-once");
    await t.mutation(completeIncident, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: first.demoCommandId,
      incidentId: first.incident.incidentId,
      recoveryCommandId: first.recovery.recoveryCommandId,
      executionNonce: first.executionNonce,
      expectedPhase: "policy_check",
      expectedIncidentStateVersion: first.incidentStateVersion,
      expectedCommandStateVersion: first.commandStateVersion,
      expectedRecoveryStateVersion: first.recovery.stateVersion,
      terminalState: "needs_human",
      finalHealth: "failed",
      terminalReason: "human_review_requested",
    });

    vi.setSystemTime(BASE_TIME + 60_000);
    const second = await moveIncidentToPolicyCheck(t);
    await expectErrorCode(
      t.mutation(createRecoveryCommand, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: second.demoCommandId,
        incidentId: second.incident.incidentId,
        expectedCommandStateVersion: second.commandStateVersion,
        expectedIncidentPhase: "policy_check",
        expectedIncidentStateVersion: second.incidentStateVersion,
        actionId: "restart_demo_service",
        executionNonce: "global-execution-once",
      }),
      "EXECUTION_REPLAY",
    );
    expect(await tableRows(t, "recoveryCommands")).toHaveLength(1);
  });

  it.each([
    { name: "confidence", override: { confidence: 0 } },
    {
      name: "approved action",
      override: { proposedActionId: "no_action" },
    },
    {
      name: "diagnosis",
      override: { diagnosisSummary: "A different diagnosis after approval." },
    },
  ])(
    "does not let policy_check to executing rewrite $name",
    async ({ override }) => {
      const t = createHarness();
      const ready = await createAllowedRecovery(t, "frozen-policy-state");
      const before = await authoritativeSnapshot(t);

      await expect(
        t.mutation(updateIncidentPhase, {
          runnerToken: RUNNER_TOKEN,
          runnerId: RUNNER_ID,
          demoCommandId: ready.demoCommandId,
          incidentId: ready.incident.incidentId,
          expectedPhase: "policy_check",
          nextPhase: "executing",
          expectedStateVersion: ready.incidentStateVersion,
          expectedCommandStateVersion: ready.commandStateVersion,
          recoveryCommandId: ready.recovery.recoveryCommandId,
          expectedRecoveryStateVersion: ready.recovery.stateVersion,
          executionNonce: ready.executionNonce,
          ...override,
        }),
      ).rejects.toThrow();

      expect(await authoritativeSnapshot(t)).toEqual(before);
    },
  );

  it.each([
    {
      name: "missing diagnosis",
      patch: {
        diagnosisSummary: undefined,
        confidence: undefined,
        proposedActionId: undefined,
      },
    },
    {
      name: "confidence below 0.80",
      patch: { confidence: 0.79 },
    },
    {
      name: "no-action diagnosis",
      patch: { proposedActionId: "no_action" },
    },
  ])(
    "denies recovery for $name without writing an action",
    async ({ patch }) => {
      const t = createHarness();
      const ready = await moveIncidentToPolicyCheck(t);
      await t.run(async (ctx) => {
        await ctx.db.patch(ready.incident.incidentId as never, patch as never);
      });
      const commandBefore = await tableRows(t, "demoCommands");
      const incidentBefore = await tableRows(t, "incidents");

      await expectErrorCode(
        t.mutation(createRecoveryCommand, {
          runnerToken: RUNNER_TOKEN,
          runnerId: RUNNER_ID,
          demoCommandId: ready.demoCommandId,
          incidentId: ready.incident.incidentId,
          expectedCommandStateVersion: ready.commandStateVersion,
          expectedIncidentPhase: "policy_check",
          expectedIncidentStateVersion: ready.incidentStateVersion,
          actionId: "restart_demo_service",
          executionNonce: `policy-denied-${patch.confidence ?? patch.proposedActionId ?? "missing"}`,
        }),
        "POLICY_DENIED",
      );

      expect(await tableRows(t, "recoveryCommands")).toHaveLength(0);
      expect(await tableRows(t, "demoCommands")).toEqual(commandBefore);
      expect(await tableRows(t, "incidents")).toEqual(incidentBefore);
    },
  );

  it("validates the command version before creating a recovery", async () => {
    const t = createHarness();
    const ready = await moveIncidentToPolicyCheck(t);

    await expectErrorCode(
      t.mutation(createRecoveryCommand, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: ready.demoCommandId,
        incidentId: ready.incident.incidentId,
        expectedCommandStateVersion: ready.commandStateVersion - 1,
        expectedIncidentPhase: "policy_check",
        expectedIncidentStateVersion: ready.incidentStateVersion,
        actionId: "restart_demo_service",
        executionNonce: "stale-command-recovery",
      }),
      "STALE_STATE",
    );
    expect(await tableRows(t, "recoveryCommands")).toHaveLength(0);
  });

  it.each(["needs_human", "investigation_failed"])(
    "rejects %s as an updateIncidentPhase target",
    async (nextPhase) => {
      const t = createHarness();
      const investigating = await moveIncidentToInvestigating(t);
      const before = await tableRows(t, "incidents");

      await expect(
        t.mutation(updateIncidentPhase, {
          runnerToken: RUNNER_TOKEN,
          runnerId: RUNNER_ID,
          demoCommandId: investigating.demoCommandId,
          incidentId: investigating.incident.incidentId,
          expectedPhase: "investigating",
          nextPhase,
          expectedStateVersion: investigating.incidentStateVersion,
          expectedCommandStateVersion: investigating.commandStateVersion,
        }),
      ).rejects.toThrow();
      expect(await tableRows(t, "incidents")).toEqual(before);
    },
  );

  it("rejects failed_recovery as an updateIncidentPhase target", async () => {
    const t = createHarness();
    const ready = await createAllowedRecovery(t, "terminal-update-denied");
    const executing = (await t.mutation(updateIncidentPhase, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: ready.demoCommandId,
      incidentId: ready.incident.incidentId,
      expectedPhase: "policy_check",
      nextPhase: "executing",
      expectedStateVersion: ready.incidentStateVersion,
      expectedCommandStateVersion: ready.commandStateVersion,
      recoveryCommandId: ready.recovery.recoveryCommandId,
      expectedRecoveryStateVersion: ready.recovery.stateVersion,
      executionNonce: ready.executionNonce,
    })) as VersionResult;
    const before = {
      incident: await tableRows(t, "incidents"),
      recovery: await tableRows(t, "recoveryCommands"),
    };

    await expect(
      t.mutation(updateIncidentPhase, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: ready.demoCommandId,
        incidentId: ready.incident.incidentId,
        expectedPhase: "executing",
        nextPhase: "failed_recovery",
        expectedStateVersion: executing.stateVersion,
        expectedCommandStateVersion: ready.commandStateVersion,
        recoveryCommandId: ready.recovery.recoveryCommandId,
        expectedRecoveryStateVersion: 1,
        executionNonce: ready.executionNonce,
      }),
    ).rejects.toThrow();
    expect({
      incident: await tableRows(t, "incidents"),
      recovery: await tableRows(t, "recoveryCommands"),
    }).toEqual(before);
  });

  it("cannot close policy_check as needs_human while omitting its allowed recovery", async () => {
    const t = createHarness();
    const ready = await createAllowedRecovery(t, "linked-policy-recovery");
    const before = await authoritativeSnapshot(t);

    await expectErrorCode(
      t.mutation(completeIncident, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: ready.demoCommandId,
        incidentId: ready.incident.incidentId,
        expectedPhase: "policy_check",
        expectedIncidentStateVersion: ready.incidentStateVersion,
        expectedCommandStateVersion: ready.commandStateVersion,
        terminalState: "needs_human",
        finalHealth: "failed",
        terminalReason: "human_approval_required",
      }),
      "RECOVERY_COMMAND_REQUIRED",
    );
    expect(await authoritativeSnapshot(t)).toEqual(before);
  });

  it("cannot close executing while omitting its executing recovery", async () => {
    const t = createHarness();
    const ready = await createAllowedRecovery(t, "linked-executing-recovery");
    const executing = (await t.mutation(updateIncidentPhase, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: ready.demoCommandId,
      incidentId: ready.incident.incidentId,
      expectedPhase: "policy_check",
      nextPhase: "executing",
      expectedStateVersion: ready.incidentStateVersion,
      expectedCommandStateVersion: ready.commandStateVersion,
      recoveryCommandId: ready.recovery.recoveryCommandId,
      expectedRecoveryStateVersion: ready.recovery.stateVersion,
      executionNonce: ready.executionNonce,
    })) as VersionResult;
    const before = await authoritativeSnapshot(t);

    await expectErrorCode(
      t.mutation(completeIncident, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: ready.demoCommandId,
        incidentId: ready.incident.incidentId,
        expectedPhase: "executing",
        expectedIncidentStateVersion: executing.stateVersion,
        expectedCommandStateVersion: ready.commandStateVersion,
        terminalState: "failed_recovery",
        finalHealth: "failed",
        terminalReason: "recovery_failed",
      }),
      "RECOVERY_COMMAND_REQUIRED",
    );
    expect(await authoritativeSnapshot(t)).toEqual(before);
  });

  it("cannot close verifying while omitting its executed recovery", async () => {
    const t = createHarness();
    const ready = await moveRecoveryToVerifying(t, "linked-verifying-recovery");
    const before = await authoritativeSnapshot(t);

    await expectErrorCode(
      t.mutation(completeIncident, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: ready.demoCommandId,
        incidentId: ready.incident.incidentId,
        expectedPhase: "verifying",
        expectedIncidentStateVersion: ready.verifying.stateVersion,
        expectedCommandStateVersion: ready.commandStateVersion,
        terminalState: "failed_recovery",
        finalHealth: "failed",
        terminalReason: "verification_failed",
      }),
      "RECOVERY_COMMAND_REQUIRED",
    );
    expect(await authoritativeSnapshot(t)).toEqual(before);
  });

  it.each([
    { terminalState: "needs_human", commandStatus: "complete" },
    { terminalState: "investigation_failed", commandStatus: "failed" },
  ])(
    "completeIncident owns $terminalState and clears the run",
    async ({ terminalState, commandStatus }) => {
      const t = createHarness();
      const investigating = await moveIncidentToInvestigating(t);

      await t.mutation(completeIncident, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: investigating.demoCommandId,
        incidentId: investigating.incident.incidentId,
        expectedPhase: "investigating",
        expectedIncidentStateVersion: investigating.incidentStateVersion,
        expectedCommandStateVersion: investigating.commandStateVersion,
        terminalState,
        finalHealth: "failed",
        terminalReason: `${terminalState}_for_test`,
      });

      expect(await tableRows(t, "incidents")).toEqual([
        expect.objectContaining({
          currentPhase: terminalState,
          terminalReason: `${terminalState}_for_test`,
          finishedAt: expect.any(Number),
        }),
      ]);
      expect(await tableRows(t, "demoCommands")).toEqual([
        expect.objectContaining({
          status: commandStatus,
          finishedAt: expect.any(Number),
        }),
      ]);
      const control = await getControl(t);
      expect(control).not.toHaveProperty("activeDemoCommandId");
      expect(control).not.toHaveProperty("activeIncidentId");
    },
  );

  it("completeIncident owns failed_recovery and fails its action", async () => {
    const t = createHarness();
    const ready = await createAllowedRecovery(t, "failed-action");
    const executing = (await t.mutation(updateIncidentPhase, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: ready.demoCommandId,
      incidentId: ready.incident.incidentId,
      expectedPhase: "policy_check",
      nextPhase: "executing",
      expectedStateVersion: ready.incidentStateVersion,
      expectedCommandStateVersion: ready.commandStateVersion,
      recoveryCommandId: ready.recovery.recoveryCommandId,
      expectedRecoveryStateVersion: ready.recovery.stateVersion,
      executionNonce: ready.executionNonce,
    })) as VersionResult;

    await t.mutation(completeIncident, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: ready.demoCommandId,
      incidentId: ready.incident.incidentId,
      recoveryCommandId: ready.recovery.recoveryCommandId,
      executionNonce: ready.executionNonce,
      expectedPhase: "executing",
      expectedIncidentStateVersion: executing.stateVersion,
      expectedCommandStateVersion: ready.commandStateVersion,
      expectedRecoveryStateVersion: 1,
      terminalState: "failed_recovery",
      finalHealth: "failed",
      terminalReason: "restart_did_not_recover_service",
    });

    expect(await tableRows(t, "incidents")).toEqual([
      expect.objectContaining({
        currentPhase: "failed_recovery",
        terminalReason: "restart_did_not_recover_service",
      }),
    ]);
    expect(await tableRows(t, "demoCommands")).toEqual([
      expect.objectContaining({ status: "failed" }),
    ]);
    expect(await tableRows(t, "recoveryCommands")).toEqual([
      expect.objectContaining({ status: "failed", stateVersion: 2 }),
    ]);
    const control = await getControl(t);
    expect(control).not.toHaveProperty("activeDemoCommandId");
    expect(control).not.toHaveProperty("activeIncidentId");
  });

  it("validates command and recovery versions on execution and completion", async () => {
    const updateHarness = createHarness();
    const ready = await createAllowedRecovery(
      updateHarness,
      "version-checked-action",
    );
    const updateBefore = {
      commands: await tableRows(updateHarness, "demoCommands"),
      incidents: await tableRows(updateHarness, "incidents"),
      recoveries: await tableRows(updateHarness, "recoveryCommands"),
    };

    await expectErrorCode(
      updateHarness.mutation(updateIncidentPhase, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: ready.demoCommandId,
        incidentId: ready.incident.incidentId,
        expectedPhase: "policy_check",
        nextPhase: "executing",
        expectedStateVersion: ready.incidentStateVersion,
        expectedCommandStateVersion: ready.commandStateVersion - 1,
        recoveryCommandId: ready.recovery.recoveryCommandId,
        expectedRecoveryStateVersion: ready.recovery.stateVersion,
        executionNonce: ready.executionNonce,
      }),
      "STALE_STATE",
    );
    await expect(
      updateHarness.mutation(updateIncidentPhase, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: ready.demoCommandId,
        incidentId: ready.incident.incidentId,
        expectedPhase: "policy_check",
        nextPhase: "executing",
        expectedStateVersion: ready.incidentStateVersion,
        expectedCommandStateVersion: ready.commandStateVersion,
        recoveryCommandId: ready.recovery.recoveryCommandId,
        expectedRecoveryStateVersion: ready.recovery.stateVersion + 1,
        executionNonce: ready.executionNonce,
      }),
    ).rejects.toThrow();
    expect({
      commands: await tableRows(updateHarness, "demoCommands"),
      incidents: await tableRows(updateHarness, "incidents"),
      recoveries: await tableRows(updateHarness, "recoveryCommands"),
    }).toEqual(updateBefore);

    vi.setSystemTime(BASE_TIME);
    const completeHarness = createHarness();
    const verifying = await moveRecoveryToVerifying(
      completeHarness,
      "complete-version-check",
    );
    const completeBefore = {
      commands: await tableRows(completeHarness, "demoCommands"),
      incidents: await tableRows(completeHarness, "incidents"),
      recoveries: await tableRows(completeHarness, "recoveryCommands"),
    };
    const validCompletion = {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: verifying.demoCommandId,
      incidentId: verifying.incident.incidentId,
      recoveryCommandId: verifying.recovery.recoveryCommandId,
      executionNonce: verifying.executionNonce,
      expectedPhase: "verifying",
      expectedIncidentStateVersion: verifying.verifying.stateVersion,
      expectedCommandStateVersion: verifying.commandStateVersion,
      expectedRecoveryStateVersion: verifying.recoveryStateVersion,
      terminalState: "resolved",
      finalHealth: "healthy",
      verification: {
        service: "gx-autodevops-demo-service",
        status: "healthy",
        httpStatus: 200,
        requestStartedAt: Date.now(),
        checkedAt: Date.now(),
      },
    };

    await expect(
      completeHarness.mutation(completeIncident, {
        ...validCompletion,
        expectedCommandStateVersion: verifying.commandStateVersion - 1,
      }),
    ).rejects.toThrow();
    await expect(
      completeHarness.mutation(completeIncident, {
        ...validCompletion,
        expectedRecoveryStateVersion: verifying.recoveryStateVersion - 1,
      }),
    ).rejects.toThrow();
    expect({
      commands: await tableRows(completeHarness, "demoCommands"),
      incidents: await tableRows(completeHarness, "incidents"),
      recoveries: await tableRows(completeHarness, "recoveryCommands"),
    }).toEqual(completeBefore);
  });

  it.each([
    {
      name: "NaN request time",
      verification: () => ({
        requestStartedAt: Number.NaN,
        checkedAt: Date.now(),
      }),
    },
    {
      name: "infinite checked time",
      verification: () => ({
        requestStartedAt: Date.now(),
        checkedAt: Number.POSITIVE_INFINITY,
      }),
    },
    {
      name: "far-future times",
      verification: () => ({
        requestStartedAt: Date.now() + 86_400_000,
        checkedAt: Date.now() + 86_400_001,
      }),
    },
    {
      name: "pre-execution times",
      verification: () => ({
        requestStartedAt: BASE_TIME - 1,
        checkedAt: BASE_TIME,
      }),
    },
  ])(
    "rejects $name without changing authoritative state",
    async ({ verification }) => {
      const t = createHarness();
      const ready = await moveRecoveryToVerifying(
        t,
        "invalid-verification-time",
      );
      const before = {
        commands: await tableRows(t, "demoCommands"),
        incidents: await tableRows(t, "incidents"),
        recoveries: await tableRows(t, "recoveryCommands"),
        control: await getControl(t),
      };

      await expect(
        t.mutation(completeIncident, {
          runnerToken: RUNNER_TOKEN,
          runnerId: RUNNER_ID,
          demoCommandId: ready.demoCommandId,
          incidentId: ready.incident.incidentId,
          recoveryCommandId: ready.recovery.recoveryCommandId,
          executionNonce: ready.executionNonce,
          expectedPhase: "verifying",
          expectedIncidentStateVersion: ready.verifying.stateVersion,
          expectedCommandStateVersion: ready.commandStateVersion,
          expectedRecoveryStateVersion: ready.recoveryStateVersion,
          terminalState: "resolved",
          finalHealth: "healthy",
          verification: {
            service: "gx-autodevops-demo-service",
            status: "healthy",
            httpStatus: 200,
            ...verification(),
          },
        }),
      ).rejects.toThrow();

      expect({
        commands: await tableRows(t, "demoCommands"),
        incidents: await tableRows(t, "incidents"),
        recoveries: await tableRows(t, "recoveryCommands"),
        control: await getControl(t),
      }).toEqual(before);
    },
  );

  it("finishes once, clears active state, and never reopens a terminal run", async () => {
    const t = createHarness();
    const ready = await moveIncidentToPolicyCheck(t);
    const recovery = (await t.mutation(createRecoveryCommand, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: ready.demoCommandId,
      incidentId: ready.incident.incidentId,
      expectedCommandStateVersion: ready.commandStateVersion,
      expectedIncidentPhase: "policy_check",
      expectedIncidentStateVersion: ready.incidentStateVersion,
      actionId: "restart_demo_service",
      executionNonce: "complete-once",
    })) as RecoveryResult;
    const executing = (await t.mutation(updateIncidentPhase, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: ready.demoCommandId,
      incidentId: ready.incident.incidentId,
      expectedPhase: "policy_check",
      nextPhase: "executing",
      expectedStateVersion: ready.incidentStateVersion,
      expectedCommandStateVersion: ready.commandStateVersion,
      recoveryCommandId: recovery.recoveryCommandId,
      expectedRecoveryStateVersion: recovery.stateVersion,
      executionNonce: "complete-once",
    })) as VersionResult;
    const verifying = (await t.mutation(updateIncidentPhase, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: ready.demoCommandId,
      incidentId: ready.incident.incidentId,
      expectedPhase: "executing",
      nextPhase: "verifying",
      expectedStateVersion: executing.stateVersion,
      expectedCommandStateVersion: ready.commandStateVersion,
      recoveryCommandId: recovery.recoveryCommandId,
      expectedRecoveryStateVersion: 1,
      executionNonce: "complete-once",
      executionEvidence: {
        commandLabel: "docker start fixed demo service",
        exitCode: 0,
        startedAt: BASE_TIME,
        finishedAt: BASE_TIME,
        latencyMs: 0,
      },
    })) as VersionResult;

    await t.mutation(completeIncident, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: ready.demoCommandId,
      incidentId: ready.incident.incidentId,
      recoveryCommandId: recovery.recoveryCommandId,
      executionNonce: "complete-once",
      expectedPhase: "verifying",
      expectedIncidentStateVersion: verifying.stateVersion,
      expectedCommandStateVersion: ready.commandStateVersion,
      expectedRecoveryStateVersion: 2,
      terminalState: "resolved",
      finalHealth: "healthy",
      verification: {
        service: "gx-autodevops-demo-service",
        status: "healthy",
        httpStatus: 200,
        requestStartedAt: BASE_TIME + 1_000,
        checkedAt: BASE_TIME + 1_001,
      },
    });

    expect(await tableRows(t, "incidents")).toEqual([
      expect.objectContaining({
        currentPhase: "resolved",
        finalHealth: "healthy",
        finishedAt: expect.any(Number),
      }),
    ]);
    expect(await tableRows(t, "demoCommands")).toEqual([
      expect.objectContaining({
        status: "complete",
        finishedAt: expect.any(Number),
      }),
    ]);
    const completedControl = await getControl(t);
    expect(completedControl).not.toHaveProperty("activeDemoCommandId");
    expect(completedControl).not.toHaveProperty("activeIncidentId");

    const immediatePublicState = (await t.query(getPublicState, {
      demoCommandId: ready.demoCommandId,
    })) as {
      active: boolean;
      demoCommandId: string | null;
      commandStatus: string | null;
      incident: { currentPhase: string; finalHealth: string | null } | null;
      result: { finalHealth: string | null } | null;
    };
    expect(immediatePublicState).toMatchObject({
      active: false,
      demoCommandId: ready.demoCommandId,
      commandStatus: "complete",
      incident: {
        currentPhase: "resolved",
        finalHealth: "healthy",
      },
      result: { finalHealth: "healthy" },
    });

    await expectErrorCode(
      t.mutation(updateIncidentPhase, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: ready.demoCommandId,
        incidentId: ready.incident.incidentId,
        expectedPhase: "resolved",
        nextPhase: "investigating",
        expectedStateVersion: verifying.stateVersion + 1,
        expectedCommandStateVersion: ready.commandStateVersion + 1,
      }),
      "TERMINAL_STATE",
    );
    expect(await tableRows(t, "incidents")).toEqual([
      expect.objectContaining({ currentPhase: "resolved" }),
    ]);
  });
});

describe("redacted public state", () => {
  it("keeps a claimed run active after only its queue expiry has passed", async () => {
    const t = createHarness();
    const claimedCommandId = await t.run(async (ctx) => {
      return await ctx.db.insert("demoCommands", {
        kind: "RESET_DEMO_V1",
        status: "claimed",
        createdAt: BASE_TIME,
        expiresAt: BASE_TIME + 90_000,
        claimedAt: BASE_TIME + 1_000,
        runnerId: RUNNER_ID,
        claimNonce: "claimed-past-queue-expiry",
        leaseExpiresAt: BASE_TIME + 130_000,
        stateVersion: 1,
        idempotencyKey: "claimed-past-queue-expiry",
      });
    });
    vi.setSystemTime(BASE_TIME + 100_000);

    const exactClaimedState = (await t.query(getPublicState, {
      demoCommandId: claimedCommandId,
    })) as {
      active: boolean;
      commandStatus: string | null;
    };
    expect(exactClaimedState).toMatchObject({
      active: true,
      commandStatus: "claimed",
    });
  });

  it("keeps an exact failed command separate from an older resolved incident", async () => {
    const t = createHarness();
    const { previousCommandId, failedCommandId } = await t.run(async (ctx) => {
      const previousCommandId = await ctx.db.insert("demoCommands", {
        kind: "RESET_DEMO_V1",
        status: "complete",
        createdAt: BASE_TIME,
        expiresAt: BASE_TIME + 90_000,
        finishedAt: BASE_TIME + 12_000,
        stateVersion: 1,
        idempotencyKey: "previous-complete-command",
      });
      await ctx.db.insert("incidents", {
        demoCommandId: previousCommandId,
        runId: "previous-resolved-run",
        staged: true,
        runnerId: RUNNER_ID,
        workloadId: "demo-service",
        currentPhase: "resolved",
        initialHealth: "failed",
        finalHealth: "healthy",
        startedAt: BASE_TIME,
        finishedAt: BASE_TIME + 12_000,
        totalLatencyMs: 12_000,
        costStatus: "not_reported",
        stateVersion: 1,
      });
      const failedCommandId = await ctx.db.insert("demoCommands", {
        kind: "RESET_DEMO_V1",
        status: "failed",
        createdAt: BASE_TIME + 20_000,
        expiresAt: BASE_TIME + 110_000,
        finishedAt: BASE_TIME + 21_000,
        stateVersion: 1,
        idempotencyKey: "new-failed-command",
      });
      return { previousCommandId, failedCommandId };
    });

    const latestState = (await t.query(getPublicState, {})) as {
      demoCommandId: string | null;
      incident: { currentPhase: string } | null;
    };
    expect(latestState).toMatchObject({
      demoCommandId: previousCommandId,
      incident: { currentPhase: "resolved" },
    });

    const exactFailedState = (await t.query(getPublicState, {
      demoCommandId: failedCommandId,
    })) as {
      active: boolean;
      demoCommandId: string | null;
      commandStatus: string | null;
      incident: { currentPhase: string } | null;
    };
    expect(exactFailedState).toEqual(
      expect.objectContaining({
        active: false,
        demoCommandId: failedCommandId,
        commandStatus: "failed",
        incident: null,
      }),
    );
  });

  it("shows no prior incident or steps while a fresh command is active", async () => {
    const t = createHarness();
    const prior = await moveIncidentToInvestigating(t);
    await t.mutation(appendStep, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: prior.demoCommandId,
      incidentId: prior.incident.incidentId,
      expectedCommandStateVersion: prior.commandStateVersion,
      expectedIncidentStateVersion: prior.incidentStateVersion,
      stepNonce: "prior-private-step",
      role: "investigator",
      kind: "evidence",
      status: "succeeded",
      sanitizedOutput: "old incident output must stay hidden",
      startedAt: BASE_TIME,
    });
    await t.mutation(completeIncident, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: prior.demoCommandId,
      incidentId: prior.incident.incidentId,
      expectedPhase: "investigating",
      expectedIncidentStateVersion: prior.incidentStateVersion,
      expectedCommandStateVersion: prior.commandStateVersion,
      terminalState: "investigation_failed",
      finalHealth: "failed",
      terminalReason: "prior_incident_for_isolation_test",
    });

    vi.setSystemTime(BASE_TIME + 60_000);
    const fresh = await createQueuedCommand(t);
    const publicState = (await t.query(getPublicState, {})) as {
      runnerOnline: boolean;
      active: boolean;
      runnerHeartbeatAt: number | null;
      cooldownUntil: number | null;
      incident: unknown;
      steps: unknown[];
      result: unknown;
    };

    expect(fresh.demoCommandId).toEqual(expect.any(String));
    expect(publicState).toMatchObject({
      runnerOnline: true,
      active: true,
      runnerHeartbeatAt: BASE_TIME + 60_000,
      cooldownUntil: BASE_TIME + 120_000,
      incident: null,
      steps: [],
      result: null,
    });
    expect(JSON.stringify(publicState)).not.toContain(
      "old incident output must stay hidden",
    );
  });

  it("returns ordered, bounded, explicitly safe fields without internal controls", async () => {
    const t = createHarness();
    const created = await createDetectedIncident(t);

    expect(await tableRows(t, "demoCommands")).toEqual([
      expect.objectContaining({ claimNonce: CLAIM_NONCE }),
    ]);

    for (let index = 0; index < 110; index += 1) {
      await t.mutation(appendStep, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: created.demoCommandId,
        incidentId: created.incident.incidentId,
        expectedCommandStateVersion: created.commandStateVersion,
        expectedIncidentStateVersion: created.incident.stateVersion,
        stepNonce: `public-step-${index}`,
        role: "investigator",
        kind: "evidence",
        status: "succeeded",
        sanitizedOutput:
          index === 0
            ? `token=should-not-leak ${"z".repeat(5_000)}`
            : `safe output ${index}`,
        startedAt: BASE_TIME + index,
        ...(index === 109
          ? {
              reportedInputTokens: 8_201,
              reportedOutputTokens: 92,
              costStatus: "unavailable_chatgpt_subscription" as const,
            }
          : {}),
      });
    }

    expect(await tableRows(t, "steps")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reportedInputTokens: 8_201,
          reportedOutputTokens: 92,
          costStatus: "unavailable_chatgpt_subscription",
        }),
      ]),
    );

    const publicState = (await t.query(getPublicState, {})) as {
      incident: { staged: boolean } | null;
      steps: Array<Record<string, unknown>>;
    };
    const serialized = JSON.stringify(publicState);
    const sequences = publicState.steps.map((step) => Number(step.sequence));

    expect(publicState.steps.length).toBeLessThanOrEqual(100);
    expect(publicState.incident?.staged).toBe(true);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(
      publicState.steps.every(
        (step) => String(step.sanitizedOutput ?? "").length <= 4_000,
      ),
    ).toBe(true);
    expect(serialized).not.toContain("should-not-leak");
    expect(serialized).not.toContain(DEMO_SECRET);
    expect(serialized).not.toContain(RUNNER_TOKEN);
    expect(serialized).not.toContain("idempotencyKey");
    expect(serialized).not.toContain("leaseExpiresAt");
    expect(serialized).not.toContain("stateVersion");
    expect(serialized).not.toContain("executionNonce");
    expect(serialized).not.toContain("claimNonce");
    expect(serialized).not.toContain("stepNonce");
    expect(serialized).not.toContain("runnerId");
    expect(serialized).not.toContain("rawPrompt");
    expect(serialized).not.toContain("modelEvents");
    expect(serialized).not.toContain("reportedInputTokens");
    expect(serialized).not.toContain("reportedOutputTokens");
    expect(serialized).not.toContain("costStatus");
    expect(serialized).not.toContain("unavailable_chatgpt_subscription");
  });
});
