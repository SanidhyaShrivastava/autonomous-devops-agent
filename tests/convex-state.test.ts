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
const APPROVAL_CAPABILITY_DIGEST = "a".repeat(64);
const OTHER_APPROVAL_CAPABILITY_DIGEST = "b".repeat(64);

const requestRun = makeFunctionReference<"mutation">("demo:requestRun");
const getPublicState = makeFunctionReference<"query">("demo:getPublicState");
const getApprovalSession = makeFunctionReference<"query">(
  "demo:getApprovalSession",
);
const decideApproval = makeFunctionReference<"mutation">(
  "demo:decideApproval",
);
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
const watchActiveRun = makeFunctionReference<"mutation">(
  "runner:watchActiveRun",
);
const claimEnvironmentRecovery = makeFunctionReference<"mutation">(
  "runner:claimEnvironmentRecovery",
);
const completeEnvironmentRecovery = makeFunctionReference<"mutation">(
  "runner:completeEnvironmentRecovery",
);
const failEnvironmentRecovery = makeFunctionReference<"mutation">(
  "runner:failEnvironmentRecovery",
);

type ConvexHarness = TestConvex<typeof schema>;

type DemoCommandResult = {
  demoCommandId: string;
};

type RunRequestOptions = {
  executionMode?: "autonomous" | "approval_required";
  approvalCapabilityDigest?: string;
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

type ApprovalRecoveryResult = RecoveryResult & {
  status: "proposed";
  approvalStatus: "pending";
  approvalRequestedAt: number;
  approvalExpiresAt: number;
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

async function createQueuedCommand(
  t: ConvexHarness,
  options: RunRequestOptions = {},
) {
  await makeRunnerFresh(t);
  return (await t.mutation(requestRun, {
    requestSecret: DEMO_SECRET,
    ...options,
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

async function markEnvironmentRestoredForTest(
  t: ConvexHarness,
  incidentId: string,
) {
  await t.run(async (ctx) => {
    await ctx.db.patch(incidentId as never, {
      environmentRecoveryStatus: "restored",
      environmentRecoveryStartedAt: BASE_TIME,
      environmentRecoveredAt: Date.now(),
    } as never);
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

async function claimQueuedCommand(
  t: ConvexHarness,
  options: RunRequestOptions = {},
) {
  const { demoCommandId } = await createQueuedCommand(t, options);
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

async function confirmFailure(
  t: ConvexHarness,
  options: RunRequestOptions = {},
) {
  const { demoCommandId, claimed } = await claimQueuedCommand(t, options);
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

async function createDetectedIncident(
  t: ConvexHarness,
  options: RunRequestOptions = {},
) {
  const { demoCommandId, confirmed } = await confirmFailure(t, options);
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

async function moveIncidentToInvestigating(
  t: ConvexHarness,
  options: RunRequestOptions = {},
) {
  const created = await createDetectedIncident(t, options);
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

type InvestigatingRun = Awaited<ReturnType<typeof moveIncidentToInvestigating>>;

async function appendWatchdogProgressStep(
  t: ConvexHarness,
  run: InvestigatingRun,
  step: {
    nonce: string;
    role: "incident_manager" | "investigator";
    kind: string;
    label: string;
    at: number;
  },
) {
  return await t.mutation(appendStep, {
    runnerToken: RUNNER_TOKEN,
    runnerId: RUNNER_ID,
    demoCommandId: run.demoCommandId,
    incidentId: run.incident.incidentId,
    expectedCommandStateVersion: run.commandStateVersion,
    expectedIncidentStateVersion: run.incidentStateVersion,
    stepNonce: step.nonce,
    role: step.role,
    kind: step.kind,
    status: "succeeded",
    safeCommandLabel: step.label,
    sanitizedOutput: `${step.label} completed`,
    startedAt: step.at,
    finishedAt: step.at,
    latencyMs: 0,
    costStatus: "not_reported",
  });
}

async function appendFirstFourWatchdogSteps(
  t: ConvexHarness,
  run: InvestigatingRun,
  fourthStepAt = BASE_TIME,
) {
  const steps = [
    {
      nonce: "watchdog-step-1",
      role: "incident_manager" as const,
      kind: "reset_demo_service",
      label: "stop disposable service",
      at: BASE_TIME,
    },
    {
      nonce: "watchdog-step-2",
      role: "incident_manager" as const,
      kind: "confirm_failed_health",
      label: "confirm failed health",
      at: BASE_TIME,
    },
    {
      nonce: "watchdog-step-3",
      role: "investigator" as const,
      kind: "inspect_service_state",
      label: "inspect service state",
      at: BASE_TIME,
    },
    {
      nonce: "watchdog-step-4",
      role: "investigator" as const,
      kind: "read_service_logs",
      label: "read service logs",
      at: fourthStepAt,
    },
  ];

  for (const step of steps) {
    await appendWatchdogProgressStep(t, run, step);
  }
}

async function moveIncidentToPolicyCheck(
  t: ConvexHarness,
  decision: {
    incidentCategory?: string;
    requiresHuman?: boolean;
    proposedActionId?: "restart_demo_service" | "no_action";
  } = {},
  options: RunRequestOptions = {},
) {
  const investigatingRun = await moveIncidentToInvestigating(t, options);
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

async function createPendingApproval(
  t: ConvexHarness,
  approvalCapabilityDigest = APPROVAL_CAPABILITY_DIGEST,
  executionNonce = "approval-required-recovery",
) {
  const ready = await moveIncidentToPolicyCheck(
    t,
    {},
    {
      executionMode: "approval_required",
      approvalCapabilityDigest,
    },
  );
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
  })) as ApprovalRecoveryResult;
  await t.mutation(appendStep, {
    runnerToken: RUNNER_TOKEN,
    runnerId: RUNNER_ID,
    demoCommandId: ready.demoCommandId,
    incidentId: ready.incident.incidentId,
    expectedCommandStateVersion: ready.commandStateVersion,
    expectedIncidentStateVersion: ready.incidentStateVersion,
    stepNonce: `approval_requested_${executionNonce}`,
    role: "policy_gate",
    kind: "approval_requested",
    status: "pending",
    safeCommandLabel: "linux agent restart fixed demo service",
    sanitizedOutput: '{"decision":"waiting_for_starting_visitor"}',
    startedAt: BASE_TIME,
    costStatus: "not_reported",
  });
  const awaiting = (await t.mutation(updateIncidentPhase, {
    runnerToken: RUNNER_TOKEN,
    runnerId: RUNNER_ID,
    demoCommandId: ready.demoCommandId,
    incidentId: ready.incident.incidentId,
    expectedPhase: "policy_check",
    nextPhase: "awaiting_approval",
    expectedStateVersion: ready.incidentStateVersion,
    expectedCommandStateVersion: ready.commandStateVersion,
    recoveryCommandId: recovery.recoveryCommandId,
    expectedRecoveryStateVersion: recovery.stateVersion,
    executionNonce,
  })) as VersionResult;

  return { ...ready, recovery, awaiting, executionNonce };
}

async function moveRecoveryToVerifying(
  t: ConvexHarness,
  executionNonce = "verified-recovery",
  commandLabel = "docker start fixed demo service",
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
      commandLabel,
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

  it("stores an explicit bounded execution mode while defaulting old callers to autonomous", async () => {
    const automatic = createHarness();
    await createQueuedCommand(automatic);
    expect(await tableRows(automatic, "demoCommands")).toEqual([
      expect.objectContaining({ executionMode: "autonomous" }),
    ]);

    const approval = createHarness();
    await createQueuedCommand(approval, {
      executionMode: "approval_required",
      approvalCapabilityDigest: APPROVAL_CAPABILITY_DIGEST,
    });
    expect(await tableRows(approval, "demoCommands")).toEqual([
      expect.objectContaining({
        executionMode: "approval_required",
        approvalCapabilityDigest: APPROVAL_CAPABILITY_DIGEST,
      }),
    ]);
  });

  it("requires one exact capability digest only for approval-required runs", async () => {
    const missing = createHarness();
    await makeRunnerFresh(missing);
    await expectErrorCode(
      missing.mutation(requestRun, {
        requestSecret: DEMO_SECRET,
        executionMode: "approval_required",
      }),
      "APPROVAL_CAPABILITY_REQUIRED",
    );

    const malformed = createHarness();
    await makeRunnerFresh(malformed);
    await expectErrorCode(
      malformed.mutation(requestRun, {
        requestSecret: DEMO_SECRET,
        executionMode: "approval_required",
        approvalCapabilityDigest: "not-a-sha256-digest",
      }),
      "INVALID_APPROVAL_CAPABILITY",
    );

    const unexpected = createHarness();
    await makeRunnerFresh(unexpected);
    await expectErrorCode(
      unexpected.mutation(requestRun, {
        requestSecret: DEMO_SECRET,
        executionMode: "autonomous",
        approvalCapabilityDigest: APPROVAL_CAPABILITY_DIGEST,
      }),
      "UNEXPECTED_APPROVAL_CAPABILITY",
    );

    expect(await tableRows(missing, "demoCommands")).toHaveLength(0);
    expect(await tableRows(malformed, "demoCommands")).toHaveLength(0);
    expect(await tableRows(unexpected, "demoCommands")).toHaveLength(0);
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

  it("treats a 3,999ms heartbeat as fresh and 4 seconds as offline", async () => {
    const freshBoundary = createHarness();
    await makeRunnerFresh(freshBoundary);
    vi.setSystemTime(BASE_TIME + 3_999);
    await expect(
      freshBoundary.mutation(requestRun, { requestSecret: DEMO_SECRET }),
    ).resolves.toMatchObject({ demoCommandId: expect.any(String) });

    vi.setSystemTime(BASE_TIME);
    const stale = createHarness();
    await makeRunnerFresh(stale);
    vi.setSystemTime(BASE_TIME + 4_000);
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

  it("terminalizes an expired queued command instead of claiming it", async () => {
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
      expect.objectContaining({ status: "failed", finishedAt: Date.now() }),
    ]);
    const [incident] = await tableRows(t, "incidents");
    expect(incident).toMatchObject({
      demoCommandId,
      status: "failed",
      currentPhase: "investigation_failed",
      terminalReason: "run expired before the runner claimed it",
      lastCompletedStepSequence: 0,
      lastCompletedStepLabel: "no completed step",
      environmentRecoveryStatus: "pending",
      finishedAt: Date.now(),
    });
    const control = await getControl(t);
    expect(control).not.toHaveProperty("activeDemoCommandId");
    expect(control).not.toHaveProperty("activeIncidentId");
    expect(control.lastRequestedAt).toBe(BASE_TIME);
    expect(control.environmentRecoveryIncidentId).toBe(incident._id);
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
    expect(control.lastRequestedAt).toBe(BASE_TIME);

    const [incident] = await tableRows(t, "incidents");
    expect(incident).toMatchObject({
      demoCommandId,
      status: "failed",
      currentPhase: "investigation_failed",
      terminalReason: "failed_to_seed_disposable_service",
      lastCompletedStepSequence: 0,
      lastCompletedStepLabel: "no completed step",
      environmentRecoveryStatus: "pending",
      finishedAt: BASE_TIME,
    });
    expect(control.environmentRecoveryIncidentId).toBe(incident._id);
    expect(await tableRows(t, "steps")).toEqual([
      expect.objectContaining({
        incidentId: incident._id,
        sequence: 1,
        kind: "command_failed",
        status: "failed",
        errorSummary: "failed_to_seed_disposable_service",
        finishedAt: BASE_TIME,
      }),
    ]);
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

  it("heartbeat terminalizes an expired queued command and queues cleanup", async () => {
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
        status: "failed",
        finishedAt: BASE_TIME + 90_001,
      }),
    ]);
    const [incident] = await tableRows(t, "incidents");
    expect(incident).toMatchObject({
      demoCommandId,
      status: "failed",
      currentPhase: "investigation_failed",
      terminalReason: "run expired before the runner claimed it",
      lastCompletedStepSequence: 0,
      lastCompletedStepLabel: "no completed step",
      environmentRecoveryStatus: "pending",
      finishedAt: BASE_TIME + 90_001,
    });
    const control = await getControl(t);
    expect(control).not.toHaveProperty("activeDemoCommandId");
    expect(control).not.toHaveProperty("activeIncidentId");
    expect(control.lastRequestedAt).toBe(BASE_TIME);
    expect(control.environmentRecoveryIncidentId).toBe(incident._id);
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
    const [incident] = await tableRows(t, "incidents");
    expect(incident).toMatchObject({
      demoCommandId,
      status: "failed",
      currentPhase: "investigation_failed",
      terminalReason: "runner lost after step 0: no completed step",
      lastCompletedStepSequence: 0,
      lastCompletedStepLabel: "no completed step",
      environmentRecoveryStatus: "pending",
      finishedAt: Date.now(),
    });
    const control = await getControl(t);
    expect(control).not.toHaveProperty("activeDemoCommandId");
    expect(control).not.toHaveProperty("activeIncidentId");
    expect(control.lastRequestedAt).toBe(BASE_TIME);
    expect(control.environmentRecoveryIncidentId).toBe(incident._id);
    expect(await tableRows(t, "steps")).toEqual([
      expect.objectContaining({
        incidentId: incident._id,
        sequence: 1,
        kind: "runner_lost",
        status: "failed",
        errorSummary: "runner lost after step 0: no completed step",
        finishedAt: Date.now(),
      }),
    ]);
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
        status: "failed",
        currentPhase: "investigation_failed",
        terminalReason: "runner lost after step 0: no completed step",
        environmentRecoveryStatus: "pending",
        finishedAt: Date.now(),
      }),
    ]);
    const control = await getControl(t);
    expect(control).not.toHaveProperty("activeDemoCommandId");
    expect(control).not.toHaveProperty("activeIncidentId");
    expect(control.environmentRecoveryIncidentId).toBe(
      created.incident.incidentId,
    );
  });
});

describe("cloud active-run watchdog", () => {
  it("creates a terminal incident when the runner disappears before incident creation", async () => {
    const t = createHarness();
    const { demoCommandId } = await claimQueuedCommand(t);
    vi.setSystemTime(BASE_TIME + 4_000);

    await t.mutation(watchActiveRun, {});

    const [incident] = await tableRows(t, "incidents");
    expect(incident).toMatchObject({
      demoCommandId,
      status: "failed",
      currentPhase: "investigation_failed",
      terminalReason: "runner lost after step 0: no completed step",
      lastCompletedStepSequence: 0,
      lastCompletedStepLabel: "no completed step",
      environmentRecoveryStatus: "pending",
      finishedAt: BASE_TIME + 4_000,
    });
    expect(await tableRows(t, "demoCommands")).toEqual([
      expect.objectContaining({
        _id: demoCommandId,
        status: "failed",
        finishedAt: BASE_TIME + 4_000,
      }),
    ]);
    expect(await tableRows(t, "steps")).toEqual([
      expect.objectContaining({
        incidentId: incident._id,
        sequence: 1,
        status: "failed",
        errorSummary: "runner lost after step 0: no completed step",
      }),
    ]);
    const control = await getControl(t);
    expect(control).not.toHaveProperty("activeDemoCommandId");
    expect(control).not.toHaveProperty("activeIncidentId");
    expect(control.environmentRecoveryIncidentId).toBe(incident._id);
  });

  it("fails a run after two missed heartbeats, records the exact last progress, restores safety locks, and is idempotent", async () => {
    const t = createHarness();
    const active = await moveIncidentToInvestigating(t);
    await appendFirstFourWatchdogSteps(t, active);
    vi.setSystemTime(BASE_TIME + 4_000);

    await t.mutation(watchActiveRun, {});

    const [command] = await tableRows(t, "demoCommands");
    expect(command).toMatchObject({
      _id: active.demoCommandId,
      status: "failed",
      finishedAt: BASE_TIME + 4_000,
    });

    const [incident] = await tableRows(t, "incidents");
    expect(incident).toMatchObject({
      _id: active.incident.incidentId,
      status: "failed",
      currentPhase: "investigation_failed",
      terminalReason: "runner lost after step 4: read service logs",
      lastCompletedStepSequence: 4,
      lastCompletedStepLabel: "read service logs",
      environmentRecoveryStatus: "pending",
      finishedAt: BASE_TIME + 4_000,
    });

    const stepsAfterFailure = await tableRows(t, "steps");
    expect(stepsAfterFailure).toHaveLength(5);
    expect(stepsAfterFailure).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sequence: 5,
          role: "incident_manager",
          status: "failed",
          errorSummary: "runner lost after step 4: read service logs",
          finishedAt: BASE_TIME + 4_000,
        }),
      ]),
    );

    const control = await getControl(t);
    expect(control).not.toHaveProperty("activeDemoCommandId");
    expect(control).not.toHaveProperty("activeIncidentId");
    expect(control.lastRequestedAt).toBe(BASE_TIME);

    const terminalSnapshot = await authoritativeSnapshot(t);
    await t.mutation(watchActiveRun, {});
    expect(await authoritativeSnapshot(t)).toEqual(terminalSnapshot);
    expect(await tableRows(t, "steps")).toEqual(stepsAfterFailure);

    await t.mutation(heartbeat, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
    });

    await expectErrorCode(
      t.mutation(requestRun, { requestSecret: DEMO_SECRET }),
      "ENVIRONMENT_RECOVERY_PENDING",
    );
    expect(await tableRows(t, "demoCommands")).toHaveLength(1);

    await markEnvironmentRestoredForTest(t, active.incident.incidentId);
    vi.setSystemTime(BASE_TIME + 59_999);
    await t.mutation(heartbeat, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
    });

    await expectErrorCode(
      t.mutation(requestRun, { requestSecret: DEMO_SECRET }),
      "COOLDOWN",
    );
    expect(await tableRows(t, "demoCommands")).toHaveLength(1);

    vi.setSystemTime(BASE_TIME + 60_000);
    await t.mutation(heartbeat, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
    });
    await expect(
      t.mutation(requestRun, { requestSecret: DEMO_SECRET }),
    ).resolves.toMatchObject({ demoCommandId: expect.any(String) });
    expect(await tableRows(t, "demoCommands")).toHaveLength(2);
  });

  it("hands pending cleanup to the runner and restores only after fresh HTTP 200 proof", async () => {
    const t = createHarness();
    const active = await moveIncidentToInvestigating(t);
    await appendFirstFourWatchdogSteps(t, active);
    vi.setSystemTime(BASE_TIME + 4_000);
    await t.mutation(watchActiveRun, {});

    const heartbeatResult = (await t.mutation(heartbeat, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
    })) as {
      environmentRecovery?: { incidentId: string; stateVersion: number };
    };
    expect(heartbeatResult.environmentRecovery).toEqual({
      incidentId: active.incident.incidentId,
      stateVersion: 2,
    });

    await expect(
      t.mutation(claimEnvironmentRecovery, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        incidentId: active.incident.incidentId,
        expectedStateVersion: 2,
      }),
    ).resolves.toEqual({ status: "claimed", stateVersion: 3 });
    expect(await tableRows(t, "incidents")).toEqual([
      expect.objectContaining({
        status: "failed",
        terminalReason: "runner lost after step 4: read service logs",
        environmentRecoveryStatus: "restoring",
        environmentRecoveryStartedAt: BASE_TIME + 4_000,
      }),
    ]);

    const beforeBadVerification = await authoritativeSnapshot(t);
    await expectErrorCode(
      t.mutation(completeEnvironmentRecovery, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        incidentId: active.incident.incidentId,
        expectedStateVersion: 3,
        verification: {
          service: "wrong-service",
          status: "healthy",
          httpStatus: 200,
          requestStartedAt: BASE_TIME + 4_000,
          checkedAt: BASE_TIME + 4_000,
        },
      }),
      "ENVIRONMENT_VERIFICATION_FAILED",
    );
    await expectErrorCode(
      t.mutation(completeEnvironmentRecovery, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        incidentId: active.incident.incidentId,
        expectedStateVersion: 3,
        verification: {
          service: "gx-autodevops-demo-service",
          status: "healthy",
          httpStatus: 200,
          requestStartedAt: BASE_TIME - 1_001,
          checkedAt: BASE_TIME + 4_000,
        },
      }),
      "ENVIRONMENT_VERIFICATION_FAILED",
    );
    expect(await authoritativeSnapshot(t)).toEqual(beforeBadVerification);

    await expectErrorCode(
      t.mutation(failEnvironmentRecovery, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        incidentId: active.incident.incidentId,
        expectedStateVersion: 2,
      }),
      "STALE_STATE",
    );
    await expect(
      t.mutation(failEnvironmentRecovery, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        incidentId: active.incident.incidentId,
        expectedStateVersion: 3,
      }),
    ).resolves.toEqual({ status: "pending", stateVersion: 4 });
    expect(await tableRows(t, "incidents")).toEqual([
      expect.objectContaining({
        status: "failed",
        environmentRecoveryStatus: "pending",
        environmentRecoveryError:
          "Demo environment restoration failed; retry required.",
      }),
    ]);
    const publicFailedCleanup = (await t.query(getPublicState, {
      demoCommandId: active.demoCommandId,
    })) as {
      incident: {
        environmentRecoveryStatus: string | null;
        environmentRecoveryError: string | null;
      } | null;
    };
    expect(publicFailedCleanup.incident).toMatchObject({
      environmentRecoveryStatus: "pending",
      environmentRecoveryError:
        "Demo environment restoration failed; retry required.",
    });
    const afterFailedCleanup = await authoritativeSnapshot(t);
    await expectErrorCode(
      t.mutation(failEnvironmentRecovery, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        incidentId: active.incident.incidentId,
        expectedStateVersion: 3,
      }),
      "STALE_STATE",
    );
    expect(await authoritativeSnapshot(t)).toEqual(afterFailedCleanup);

    const retriedClaim = (await t.mutation(claimEnvironmentRecovery, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      incidentId: active.incident.incidentId,
      expectedStateVersion: 4,
    })) as VersionResult;
    expect(retriedClaim).toEqual({ status: "claimed", stateVersion: 5 });
    await expect(
      t.mutation(completeEnvironmentRecovery, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        incidentId: active.incident.incidentId,
        expectedStateVersion: 5,
        verification: {
          service: "gx-autodevops-demo-service",
          status: "healthy",
          httpStatus: 200,
          requestStartedAt: BASE_TIME + 4_000,
          checkedAt: BASE_TIME + 4_000,
        },
      }),
    ).resolves.toEqual({ status: "restored", stateVersion: 6 });

    const restoredSnapshot = await authoritativeSnapshot(t);
    expect(restoredSnapshot.incidents).toEqual([
      expect.objectContaining({
        status: "failed",
        currentPhase: "investigation_failed",
        terminalReason: "runner lost after step 4: read service logs",
        environmentRecoveryStatus: "restored",
        environmentRecoveredAt: BASE_TIME + 4_000,
      }),
    ]);
    expect(restoredSnapshot.control).not.toHaveProperty(
      "environmentRecoveryIncidentId",
    );
    await expectErrorCode(
      t.mutation(completeEnvironmentRecovery, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        incidentId: active.incident.incidentId,
        expectedStateVersion: 5,
        verification: {
          service: "gx-autodevops-demo-service",
          status: "healthy",
          httpStatus: 200,
          requestStartedAt: BASE_TIME + 4_000,
          checkedAt: BASE_TIME + 4_000,
        },
      }),
      "ENVIRONMENT_RECOVERY_NOT_FOUND",
    );
    expect(await authoritativeSnapshot(t)).toEqual(restoredSnapshot);
    await expect(
      t.mutation(heartbeat, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
      }),
    ).resolves.toEqual({
      runnerHeartbeatAt: BASE_TIME + 4_000,
      environmentRecovery: undefined,
    });
  });

  it("fails at the exact 20-second per-step deadline while the runner heartbeat is fresh", async () => {
    const t = createHarness();
    const active = await moveIncidentToInvestigating(t);
    await appendFirstFourWatchdogSteps(t, active);
    vi.setSystemTime(BASE_TIME + 20_000);
    await t.mutation(heartbeat, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
    });

    await t.mutation(watchActiveRun, {});

    const [incident] = await tableRows(t, "incidents");
    expect(incident).toMatchObject({
      status: "failed",
      lastCompletedStepSequence: 4,
      lastCompletedStepLabel: "read service logs",
      finishedAt: BASE_TIME + 20_000,
    });
    expect(String(incident.terminalReason)).toMatch(/20-second step deadline/i);
  });

  it("fails at the exact 45-second whole-run deadline even after recent progress", async () => {
    const t = createHarness();
    const active = await moveIncidentToInvestigating(t);
    vi.setSystemTime(BASE_TIME + 29_000);
    await t.mutation(renewLease, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: active.demoCommandId,
      expectedStateVersion: active.commandStateVersion,
    });
    await t.mutation(heartbeat, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
    });
    vi.setSystemTime(BASE_TIME + 44_000);
    await appendFirstFourWatchdogSteps(t, active, BASE_TIME + 44_000);
    vi.setSystemTime(BASE_TIME + 45_000);
    await t.mutation(heartbeat, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
    });

    await t.mutation(watchActiveRun, {});

    const [incident] = await tableRows(t, "incidents");
    expect(incident).toMatchObject({
      status: "failed",
      lastCompletedStepSequence: 4,
      lastCompletedStepLabel: "read service logs",
      finishedAt: BASE_TIME + 45_000,
    });
    expect(String(incident.terminalReason)).toMatch(/45-second run deadline/i);
  });
});

describe("durable staged approval gate", () => {
  it("reserves the human operator role for the server-side decision mutation", async () => {
    const t = createHarness();
    const active = await moveIncidentToInvestigating(t);

    await expect(
      t.mutation(appendStep, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: active.demoCommandId,
        incidentId: active.incident.incidentId,
        expectedCommandStateVersion: active.commandStateVersion,
        expectedIncidentStateVersion: active.incidentStateVersion,
        stepNonce: "forged_human_decision",
        role: "human_operator",
        kind: "approval_decision",
        status: "succeeded",
        startedAt: BASE_TIME,
        finishedAt: BASE_TIME,
        latencyMs: 0,
        costStatus: "not_reported",
      }),
    ).rejects.toThrow();
    expect(await tableRows(t, "steps")).toHaveLength(0);
  });

  it("persists a proposed pending recovery and exposes only its safe public approval view", async () => {
    const t = createHarness();
    const pending = await createPendingApproval(t);

    expect(pending.recovery).toEqual({
      recoveryCommandId: expect.any(String),
      stateVersion: 0,
      status: "proposed",
      approvalStatus: "pending",
      approvalRequestedAt: BASE_TIME,
      approvalExpiresAt: BASE_TIME + 300_000,
    });
    expect(await tableRows(t, "recoveryCommands")).toEqual([
      expect.objectContaining({
        status: "proposed",
        approvalStatus: "pending",
        approvalCapabilityDigest: APPROVAL_CAPABILITY_DIGEST,
        approvalRequestedAt: BASE_TIME,
        approvalExpiresAt: BASE_TIME + 300_000,
      }),
    ]);
    expect(await tableRows(t, "incidents")).toEqual([
      expect.objectContaining({ currentPhase: "awaiting_approval" }),
    ]);

    await expect(
      t.query(getApprovalSession, {
        requestSecret: DEMO_SECRET,
        approvalCapabilityDigest: APPROVAL_CAPABILITY_DIGEST,
      }),
    ).resolves.toEqual({
      demoCommandId: pending.demoCommandId,
      incidentId: pending.incident.incidentId,
      status: "pending",
      expiresAt: BASE_TIME + 300_000,
      decidedAt: null,
    });

    const publicState = (await t.query(getPublicState, {})) as Record<
      string,
      unknown
    >;
    expect(publicState).toMatchObject({
      executionMode: "approval_required",
      approval: {
        status: "pending",
        actionId: "restart_demo_service",
        actionLabel: "linux agent restart fixed demo service",
        requestedAt: BASE_TIME,
        expiresAt: BASE_TIME + 300_000,
        decidedAt: null,
      },
    });
    expect(JSON.stringify(publicState)).not.toContain(
      APPROVAL_CAPABILITY_DIGEST,
    );
  });

  it("does not enter executing while the durable approval is pending", async () => {
    const t = createHarness();
    const pending = await createPendingApproval(t);
    const before = await authoritativeSnapshot(t);

    await expectErrorCode(
      t.mutation(updateIncidentPhase, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: pending.demoCommandId,
        incidentId: pending.incident.incidentId,
        expectedPhase: "awaiting_approval",
        nextPhase: "executing",
        expectedStateVersion: pending.awaiting.stateVersion,
        expectedCommandStateVersion: pending.commandStateVersion,
        recoveryCommandId: pending.recovery.recoveryCommandId,
        expectedRecoveryStateVersion: pending.recovery.stateVersion,
        executionNonce: pending.executionNonce,
      }),
      "APPROVAL_REQUIRED",
    );
    expect(await authoritativeSnapshot(t)).toEqual(before);
  });

  it("lets the capability owner approve, then lets only the runner enter executing", async () => {
    const t = createHarness();
    const pending = await createPendingApproval(t);

    await expect(
      t.mutation(decideApproval, {
        requestSecret: DEMO_SECRET,
        approvalCapabilityDigest: APPROVAL_CAPABILITY_DIGEST,
        decision: "approved",
      }),
    ).resolves.toEqual({
      demoCommandId: pending.demoCommandId,
      incidentId: pending.incident.incidentId,
      recoveryCommandId: pending.recovery.recoveryCommandId,
      status: "approved",
      decidedAt: BASE_TIME,
    });
    expect(await tableRows(t, "recoveryCommands")).toEqual([
      expect.objectContaining({
        status: "proposed",
        approvalStatus: "approved",
        approvalDecidedAt: BASE_TIME,
        stateVersion: 1,
      }),
    ]);
    expect(
      (await tableRows(t, "steps")).filter(
        (step) => step.role === "human_operator",
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "approval_decision",
        role: "human_operator",
        status: "succeeded",
        stepNonce: `approval_decision_${pending.recovery.recoveryCommandId}`,
      }),
    ]);
    expect(
      (await tableRows(t, "steps")).filter(
        (step) => step.kind === "approval_requested",
      ),
    ).toEqual([
      expect.objectContaining({
        role: "policy_gate",
        status: "succeeded",
        finishedAt: BASE_TIME,
        latencyMs: 0,
      }),
    ]);

    await expect(
      t.mutation(updateIncidentPhase, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: pending.demoCommandId,
        incidentId: pending.incident.incidentId,
        expectedPhase: "awaiting_approval",
        nextPhase: "executing",
        expectedStateVersion: pending.awaiting.stateVersion,
        expectedCommandStateVersion: pending.commandStateVersion,
        recoveryCommandId: pending.recovery.recoveryCommandId,
        expectedRecoveryStateVersion: 1,
        executionNonce: pending.executionNonce,
      }),
    ).resolves.toMatchObject({
      stateVersion: pending.awaiting.stateVersion + 1,
      recoveryStateVersion: 2,
    });
    expect(await tableRows(t, "recoveryCommands")).toEqual([
      expect.objectContaining({
        status: "executing",
        approvalStatus: "approved",
      }),
    ]);
  });

  it("rejects missing, wrong, expired, and replayed approval authority", async () => {
    const t = createHarness();
    await createPendingApproval(t);

    await expect(
      t.query(getApprovalSession, {
        requestSecret: DEMO_SECRET,
        approvalCapabilityDigest: OTHER_APPROVAL_CAPABILITY_DIGEST,
      }),
    ).resolves.toBeNull();
    await expectErrorCode(
      t.mutation(decideApproval, {
        requestSecret: DEMO_SECRET,
        approvalCapabilityDigest: OTHER_APPROVAL_CAPABILITY_DIGEST,
        decision: "approved",
      }),
      "APPROVAL_NOT_FOUND",
    );

    await t.mutation(decideApproval, {
      requestSecret: DEMO_SECRET,
      approvalCapabilityDigest: APPROVAL_CAPABILITY_DIGEST,
      decision: "approved",
    });
    await expectErrorCode(
      t.mutation(decideApproval, {
        requestSecret: DEMO_SECRET,
        approvalCapabilityDigest: APPROVAL_CAPABILITY_DIGEST,
        decision: "approved",
      }),
      "APPROVAL_NOT_PENDING",
    );
    expect(
      (await tableRows(t, "steps")).filter(
        (step) => step.kind === "approval_decision",
      ),
    ).toHaveLength(1);
    expect(
      (await tableRows(t, "steps")).filter(
        (step) => step.kind === "approval_requested",
      ),
    ).toEqual([
      expect.objectContaining({ status: "succeeded" }),
    ]);

    const expired = createHarness();
    await createPendingApproval(expired);
    vi.setSystemTime(BASE_TIME + 300_000);
    await expectErrorCode(
      expired.mutation(decideApproval, {
        requestSecret: DEMO_SECRET,
        approvalCapabilityDigest: APPROVAL_CAPABILITY_DIGEST,
        decision: "approved",
      }),
      "APPROVAL_EXPIRED",
    );
  });

  it.each(["missing", "ambiguous"] as const)(
    "fails closed when the pending approval request step is %s",
    async (scenario) => {
      const t = createHarness();
      await createPendingApproval(t);
      const [requestStep] = await tableRows(t, "steps");
      if (!requestStep) {
        throw new Error("Expected an approval request step");
      }
      await t.run(async (ctx) => {
        if (scenario === "missing") {
          await ctx.db.delete(requestStep._id as never);
          return;
        }
        await ctx.db.insert("steps" as never, {
          demoCommandId: requestStep.demoCommandId,
          incidentId: requestStep.incidentId,
          sequence: Number(requestStep.sequence) + 1,
          stepNonce: "approval_requested_ambiguous",
          role: "policy_gate",
          kind: "approval_requested",
          status: "pending",
          safeCommandLabel: "linux agent restart fixed demo service",
          sanitizedOutput: '{"decision":"waiting_for_starting_visitor"}',
          startedAt: BASE_TIME,
          costStatus: "not_reported",
        } as never);
      });

      await expectErrorCode(
        t.mutation(decideApproval, {
          requestSecret: DEMO_SECRET,
          approvalCapabilityDigest: APPROVAL_CAPABILITY_DIGEST,
          decision: "approved",
        }),
        "APPROVAL_REQUEST_STEP_INVALID",
      );
      const [recovery] = await tableRows(t, "recoveryCommands");
      expect(recovery).toEqual(
        expect.objectContaining({
          status: "proposed",
          approvalStatus: "pending",
        }),
      );
      expect(recovery).not.toHaveProperty("approvalDecidedAt");
      expect(
        (await tableRows(t, "steps")).filter(
          (step) => step.kind === "approval_decision",
        ),
      ).toHaveLength(0);
    },
  );

  it("requires a fresh runner for approval but permits fixed rejection while offline", async () => {
    const approval = createHarness();
    await createPendingApproval(approval);
    vi.setSystemTime(BASE_TIME + 4_000);
    await expectErrorCode(
      approval.mutation(decideApproval, {
        requestSecret: DEMO_SECRET,
        approvalCapabilityDigest: APPROVAL_CAPABILITY_DIGEST,
        decision: "approved",
      }),
      "RUNNER_OFFLINE",
    );

    vi.setSystemTime(BASE_TIME);
    const rejection = createHarness();
    const pending = await createPendingApproval(rejection);
    vi.setSystemTime(BASE_TIME + 4_000);
    await expect(
      rejection.mutation(decideApproval, {
        requestSecret: DEMO_SECRET,
        approvalCapabilityDigest: APPROVAL_CAPABILITY_DIGEST,
        decision: "rejected",
      }),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(await tableRows(rejection, "recoveryCommands")).toEqual([
      expect.objectContaining({
        status: "blocked",
        approvalStatus: "rejected",
        completedAt: BASE_TIME + 4_000,
      }),
    ]);
    expect(await tableRows(rejection, "incidents")).toEqual([
      expect.objectContaining({
        currentPhase: "needs_human",
        status: "needs_human",
        terminalReason: "approval_rejected",
        environmentRecoveryStatus: "pending",
      }),
    ]);
    expect(await tableRows(rejection, "demoCommands")).toEqual([
      expect.objectContaining({ status: "complete" }),
    ]);
    expect(
      (await tableRows(rejection, "steps")).filter(
        (step) => step.kind === "approval_requested",
      ),
    ).toEqual([
      expect.objectContaining({
        status: "blocked",
        finishedAt: BASE_TIME + 4_000,
        latencyMs: 4_000,
      }),
    ]);
    expect(await getControl(rejection)).toMatchObject({
      environmentRecoveryIncidentId: pending.incident.incidentId,
    });
    expect(await getControl(rejection)).not.toHaveProperty(
      "activeDemoCommandId",
    );
    expect(await getControl(rejection)).not.toHaveProperty("activeIncidentId");
    expect((await getControl(rejection)).lastRequestedAt).toBe(BASE_TIME);

    await markEnvironmentRestoredForTest(
      rejection,
      pending.incident.incidentId,
    );
    vi.setSystemTime(BASE_TIME + 59_999);
    await rejection.mutation(heartbeat, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
    });
    await expectErrorCode(
      rejection.mutation(requestRun, { requestSecret: DEMO_SECRET }),
      "COOLDOWN",
    );

    vi.setSystemTime(BASE_TIME + 60_000);
    await rejection.mutation(heartbeat, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
    });
    await expect(
      rejection.mutation(requestRun, { requestSecret: DEMO_SECRET }),
    ).resolves.toMatchObject({ demoCommandId: expect.any(String) });
  });

  it("serializes simultaneous approve and reject so exactly one decision wins", async () => {
    const t = createHarness();
    await createPendingApproval(t);

    const results = await Promise.allSettled([
      t.mutation(decideApproval, {
        requestSecret: DEMO_SECRET,
        approvalCapabilityDigest: APPROVAL_CAPABILITY_DIGEST,
        decision: "approved",
      }),
      t.mutation(decideApproval, {
        requestSecret: DEMO_SECRET,
        approvalCapabilityDigest: APPROVAL_CAPABILITY_DIGEST,
        decision: "rejected",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(await tableRows(t, "recoveryCommands")).toEqual([
      expect.objectContaining({
        approvalStatus: expect.stringMatching(/^(approved|rejected)$/),
      }),
    ]);
  });

  it("keeps a valid pending approval alive past run deadlines while heartbeats stay fresh", async () => {
    const t = createHarness();
    const pending = await createPendingApproval(t);
    vi.setSystemTime(BASE_TIME + 99_000);
    await t.mutation(heartbeat, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
    });
    vi.setSystemTime(BASE_TIME + 100_000);

    await expect(t.mutation(watchActiveRun, {})).resolves.toMatchObject({
      status: "awaiting_approval",
      incidentId: pending.incident.incidentId,
    });
    expect(await tableRows(t, "incidents")).toEqual([
      expect.objectContaining({ currentPhase: "awaiting_approval" }),
    ]);
    expect(await tableRows(t, "demoCommands")).toEqual([
      expect.objectContaining({ status: "failure_confirmed" }),
    ]);
  });

  it("starts a fresh run deadline after a delayed approval enters execution", async () => {
    const t = createHarness();
    const pending = await createPendingApproval(t);

    vi.setSystemTime(BASE_TIME + 100_000);
    await t.mutation(heartbeat, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
    });
    await t.mutation(decideApproval, {
      requestSecret: DEMO_SECRET,
      approvalCapabilityDigest: APPROVAL_CAPABILITY_DIGEST,
      decision: "approved",
    });
    await t.mutation(updateIncidentPhase, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: pending.demoCommandId,
      incidentId: pending.incident.incidentId,
      expectedPhase: "awaiting_approval",
      nextPhase: "executing",
      expectedStateVersion: pending.awaiting.stateVersion,
      expectedCommandStateVersion: pending.commandStateVersion,
      recoveryCommandId: pending.recovery.recoveryCommandId,
      expectedRecoveryStateVersion: 1,
      executionNonce: pending.executionNonce,
    });

    vi.setSystemTime(BASE_TIME + 101_000);
    await t.mutation(heartbeat, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
    });
    vi.setSystemTime(BASE_TIME + 102_000);

    await expect(t.mutation(watchActiveRun, {})).resolves.toEqual({
      status: "active",
    });
    expect(await tableRows(t, "incidents")).toEqual([
      expect.objectContaining({ currentPhase: "executing" }),
    ]);
  });

  it("fails a pending approval visibly when two runner heartbeats are missed", async () => {
    const t = createHarness();
    await createPendingApproval(t);
    vi.setSystemTime(BASE_TIME + 4_000);

    await expect(t.mutation(watchActiveRun, {})).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("runner lost after step"),
    });
    expect(await tableRows(t, "incidents")).toEqual([
      expect.objectContaining({
        currentPhase: "investigation_failed",
        status: "failed",
        environmentRecoveryStatus: "pending",
      }),
    ]);
    expect(await tableRows(t, "recoveryCommands")).toEqual([
      expect.objectContaining({
        status: "failed",
        approvalStatus: "expired",
        approvalDecidedAt: BASE_TIME + 4_000,
      }),
    ]);
    expect(
      (await tableRows(t, "steps")).filter(
        (step) => step.kind === "approval_requested",
      ),
    ).toEqual([
      expect.objectContaining({
        status: "blocked",
        finishedAt: BASE_TIME + 4_000,
        latencyMs: 4_000,
      }),
    ]);
    const control = await getControl(t);
    expect(control).not.toHaveProperty("activeDemoCommandId");
    expect(control.lastRequestedAt).toBe(BASE_TIME);
    await expect(
      t.query(getApprovalSession, {
        requestSecret: DEMO_SECRET,
        approvalCapabilityDigest: APPROVAL_CAPABILITY_DIGEST,
      }),
    ).resolves.toBeNull();
  });

  it("closes a saved approval request if the runner is lost before awaiting is stored", async () => {
    const t = createHarness();
    const ready = await moveIncidentToPolicyCheck(
      t,
      {},
      {
        executionMode: "approval_required",
        approvalCapabilityDigest: APPROVAL_CAPABILITY_DIGEST,
      },
    );
    await t.mutation(createRecoveryCommand, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: ready.demoCommandId,
      incidentId: ready.incident.incidentId,
      expectedCommandStateVersion: ready.commandStateVersion,
      expectedIncidentPhase: "policy_check",
      expectedIncidentStateVersion: ready.incidentStateVersion,
      actionId: "restart_demo_service",
      executionNonce: "approval-before-awaiting",
    });
    await t.mutation(appendStep, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: ready.demoCommandId,
      incidentId: ready.incident.incidentId,
      expectedCommandStateVersion: ready.commandStateVersion,
      expectedIncidentStateVersion: ready.incidentStateVersion,
      stepNonce: "approval_requested_before_awaiting",
      role: "policy_gate",
      kind: "approval_requested",
      status: "pending",
      safeCommandLabel: "linux agent restart fixed demo service",
      startedAt: BASE_TIME,
      costStatus: "not_reported",
    });
    vi.setSystemTime(BASE_TIME + 4_000);

    await expect(t.mutation(watchActiveRun, {})).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("runner lost after step"),
    });
    expect(
      (await tableRows(t, "steps")).filter(
        (step) => step.kind === "approval_requested",
      ),
    ).toEqual([
      expect.objectContaining({
        status: "blocked",
        finishedAt: BASE_TIME + 4_000,
      }),
    ]);
  });

  it("fails safely if the runner is lost before an approval request step is saved", async () => {
    const t = createHarness();
    const ready = await moveIncidentToPolicyCheck(
      t,
      {},
      {
        executionMode: "approval_required",
        approvalCapabilityDigest: APPROVAL_CAPABILITY_DIGEST,
      },
    );
    await t.mutation(createRecoveryCommand, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: ready.demoCommandId,
      incidentId: ready.incident.incidentId,
      expectedCommandStateVersion: ready.commandStateVersion,
      expectedIncidentPhase: "policy_check",
      expectedIncidentStateVersion: ready.incidentStateVersion,
      actionId: "restart_demo_service",
      executionNonce: "approval-before-request-step",
    });
    vi.setSystemTime(BASE_TIME + 4_000);

    await expect(t.mutation(watchActiveRun, {})).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("runner lost after step"),
    });
    expect(await tableRows(t, "incidents")).toEqual([
      expect.objectContaining({
        currentPhase: "investigation_failed",
        status: "failed",
        environmentRecoveryStatus: "pending",
      }),
    ]);
    expect(await tableRows(t, "recoveryCommands")).toEqual([
      expect.objectContaining({
        status: "failed",
        approvalStatus: "expired",
        approvalDecidedAt: BASE_TIME + 4_000,
      }),
    ]);
    expect(
      (await tableRows(t, "steps")).filter(
        (step) => step.kind === "approval_requested",
      ),
    ).toHaveLength(0);
    expect(await getControl(t)).not.toHaveProperty("activeDemoCommandId");
  });

  it("fails closed on ambiguous pending approval requests before awaiting is stored", async () => {
    const t = createHarness();
    const ready = await moveIncidentToPolicyCheck(
      t,
      {},
      {
        executionMode: "approval_required",
        approvalCapabilityDigest: APPROVAL_CAPABILITY_DIGEST,
      },
    );
    await t.mutation(createRecoveryCommand, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
      demoCommandId: ready.demoCommandId,
      incidentId: ready.incident.incidentId,
      expectedCommandStateVersion: ready.commandStateVersion,
      expectedIncidentPhase: "policy_check",
      expectedIncidentStateVersion: ready.incidentStateVersion,
      actionId: "restart_demo_service",
      executionNonce: "ambiguous-approval-before-awaiting",
    });
    for (const stepNonce of ["approval_request_one", "approval_request_two"]) {
      await t.mutation(appendStep, {
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
        demoCommandId: ready.demoCommandId,
        incidentId: ready.incident.incidentId,
        expectedCommandStateVersion: ready.commandStateVersion,
        expectedIncidentStateVersion: ready.incidentStateVersion,
        stepNonce,
        role: "policy_gate",
        kind: "approval_requested",
        status: "pending",
        safeCommandLabel: "linux agent restart fixed demo service",
        startedAt: BASE_TIME,
        costStatus: "not_reported",
      });
    }
    vi.setSystemTime(BASE_TIME + 4_000);

    await expectErrorCode(
      t.mutation(watchActiveRun, {}),
      "APPROVAL_REQUEST_STEP_INVALID",
    );
    expect(await tableRows(t, "incidents")).toEqual([
      expect.objectContaining({ currentPhase: "policy_check" }),
    ]);
    expect(await tableRows(t, "recoveryCommands")).toEqual([
      expect.objectContaining({
        status: "proposed",
        approvalStatus: "pending",
      }),
    ]);
    expect(
      (await tableRows(t, "steps")).filter(
        (step) => step.kind === "approval_requested",
      ),
    ).toHaveLength(2);
    expect(await getControl(t)).toHaveProperty("activeDemoCommandId");
  });

  it("refreshes the waiting lease on heartbeat and expires without executing", async () => {
    const leaseHarness = createHarness();
    await createPendingApproval(leaseHarness);
    vi.setSystemTime(BASE_TIME + 30_001);
    await leaseHarness.mutation(heartbeat, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
    });
    expect(await tableRows(leaseHarness, "demoCommands")).toEqual([
      expect.objectContaining({
        status: "failure_confirmed",
        leaseExpiresAt: BASE_TIME + 60_001,
      }),
    ]);

    vi.setSystemTime(BASE_TIME);
    const expiryHarness = createHarness();
    const pending = await createPendingApproval(expiryHarness);
    vi.setSystemTime(BASE_TIME + 299_000);
    await expiryHarness.mutation(heartbeat, {
      runnerToken: RUNNER_TOKEN,
      runnerId: RUNNER_ID,
    });
    vi.setSystemTime(BASE_TIME + 300_000);
    await expect(
      expiryHarness.mutation(watchActiveRun, {}),
    ).resolves.toMatchObject({
      status: "expired",
      incidentId: pending.incident.incidentId,
    });
    expect(await tableRows(expiryHarness, "recoveryCommands")).toEqual([
      expect.objectContaining({
        status: "blocked",
        approvalStatus: "expired",
      }),
    ]);
    expect(await tableRows(expiryHarness, "incidents")).toEqual([
      expect.objectContaining({
        currentPhase: "needs_human",
        terminalReason: "approval_expired",
        environmentRecoveryStatus: "pending",
      }),
    ]);
    expect(
      (await tableRows(expiryHarness, "steps")).filter(
        (step) => step.kind === "approval_requested",
      ),
    ).toEqual([
      expect.objectContaining({
        status: "blocked",
        finishedAt: BASE_TIME + 300_000,
        latencyMs: 300_000,
      }),
    ]);
    expect(await tableRows(expiryHarness, "steps")).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "recovery_executed" }),
      ]),
    );
    expect((await getControl(expiryHarness)).lastRequestedAt).toBe(BASE_TIME);
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
  it.each([
    {
      name: "legacy Docker",
      label: "docker start fixed demo service",
      nonce: "legacy-label-evidence",
    },
    {
      name: "Linux agent",
      label: "linux agent restart fixed demo service",
      nonce: "linux-label-evidence",
    },
  ])(
    "accepts, persists, and resolves $name recovery evidence",
    async ({ label, nonce }) => {
      const t = createHarness();
      const ready = await moveRecoveryToVerifying(t, nonce, label);

      expect(await tableRows(t, "recoveryCommands")).toEqual([
        expect.objectContaining({
          executionCommandLabel: label,
        }),
      ]);

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
            requestStartedAt: BASE_TIME + 1_000,
            checkedAt: BASE_TIME + 1_001,
          },
        }),
      ).resolves.toMatchObject({ terminalState: "resolved" });
    },
  );

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
        commandLabel: "run anything",
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
    await markEnvironmentRestoredForTest(t, first.incident.incidentId);

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
      expect(control.lastRequestedAt).toBe(BASE_TIME);
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
    expect(control.lastRequestedAt).toBe(BASE_TIME);
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

  it("shows a newer failed command instead of an older resolved incident after reload", async () => {
    const t = createHarness();
    const { failedCommandId } = await t.run(async (ctx) => {
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
      return { failedCommandId };
    });

    const latestState = (await t.query(getPublicState, {})) as {
      demoCommandId: string | null;
      incident: { currentPhase: string } | null;
    };
    expect(latestState).toMatchObject({
      demoCommandId: failedCommandId,
      incident: null,
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
    await markEnvironmentRestoredForTest(t, prior.incident.incidentId);

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
