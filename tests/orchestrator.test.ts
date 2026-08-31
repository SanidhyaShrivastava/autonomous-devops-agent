import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HealthEvidence,
  RecoveryActionResult,
  SafeContainerState,
  SafeLogTail,
} from "../runner/docker-adapter";
import type { InvestigationResult } from "../runner/codex-investigator";
import {
  createRecoveryOrchestrator,
  type CompleteIncidentInput,
  type DemoWorkloadPort,
  type RecoveryCommandSnapshot,
  type RecoveryStatePort,
  type RunnerStepInput,
  type UpdateIncidentPhaseInput,
} from "../runner/orchestrator";
import { evaluateRecoveryPolicy } from "../src/lib/policy";

const BASE_TIME = Date.UTC(2026, 7, 30, 14, 0, 0);
const SERVER_RECOVERY_COMPLETED_AT = BASE_TIME + 2_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const QUEUED_COMMAND: RecoveryCommandSnapshot = {
  id: "command_1",
  kind: "RESET_DEMO_V1",
  status: "queued",
  createdAt: BASE_TIME,
  expiresAt: BASE_TIME + 90_000,
  leaseExpiresAt: null,
  stateVersion: 0,
  incident: null,
  recovery: null,
  stepNonces: [],
};

const FAILED_HEALTH: HealthEvidence = {
  healthy: false,
  httpStatus: null,
  service: null,
  status: null,
  requestStartedAt: BASE_TIME + 100,
  checkedAt: BASE_TIME + 120,
  attempts: 1,
};

const HEALTHY_AFTER_RECOVERY: HealthEvidence = {
  healthy: true,
  httpStatus: 200,
  service: "gx-autodevops-demo-service",
  status: "healthy",
  requestStartedAt: SERVER_RECOVERY_COMPLETED_AT,
  checkedAt: SERVER_RECOVERY_COMPLETED_AT + 20,
  attempts: 2,
};

const RUNNING_STATE: SafeContainerState = {
  status: "running",
  exitCode: 0,
  oomKilled: false,
  finishedAt: "0001-01-01T00:00:00Z",
  demoLabel: "autonomous-devops-agent",
};

const EXITED_STATE: SafeContainerState = {
  status: "exited",
  exitCode: 0,
  oomKilled: false,
  finishedAt: "2026-08-30T14:00:00.000Z",
  demoLabel: "autonomous-devops-agent",
};

const SAFE_LOGS: SafeLogTail = {
  lines: [
    "demo-service received SIGTERM",
    "health request could not connect",
  ],
  lineCount: 2,
  characterCount: 62,
  truncated: false,
};

function successfulInvestigation(
  overrides: Partial<
    Extract<InvestigationResult, { status: "succeeded" }>["diagnosis"]
  > = {},
): InvestigationResult {
  return {
    status: "succeeded",
    diagnosis: {
      incidentCategory: "service_stopped",
      summary: "The disposable demo service is stopped.",
      evidence: [
        "Health check healthy: false",
        "Container status: exited",
      ],
      confidence: 0.96,
      proposedActionId: "restart_demo_service",
      requiresHuman: false,
      ...overrides,
    },
    usage: {
      inputTokens: 6_967,
      cachedInputTokens: 0,
      outputTokens: 93,
    },
    startedAt: BASE_TIME + 200,
    finishedAt: BASE_TIME + 8_438,
    latencyMs: 8_238,
    costStatus: "unavailable_chatgpt_subscription",
  };
}

class FakeRecoveryState implements RecoveryStatePort {
  readonly steps: RunnerStepInput[] = [];
  readonly completions: CompleteIncidentInput[] = [];
  readonly phaseUpdates: UpdateIncidentPhaseInput[] = [];
  failOn: string | null = null;

  constructor(private readonly calls: string[]) {}

  private checkFailure(operation: string) {
    if (this.failOn === operation) {
      throw new Error(`synthetic ${operation} rejection`);
    }
  }

  async claimDemoCommand(
    input: Parameters<RecoveryStatePort["claimDemoCommand"]>[0],
  ) {
    this.calls.push("state.claim");
    this.checkFailure("claimDemoCommand");
    return {
      status: "claimed" as const,
      stateVersion: input.expectedStateVersion + 1,
      leaseExpiresAt: BASE_TIME + 30_000,
    };
  }

  async renewLease(
    input: Parameters<RecoveryStatePort["renewLease"]>[0],
  ) {
    this.calls.push("state.renewLease");
    this.checkFailure("renewLease");
    return {
      stateVersion: input.expectedStateVersion,
      leaseExpiresAt: BASE_TIME + 60_000,
    };
  }

  async failDemoCommand(
    input: Parameters<RecoveryStatePort["failDemoCommand"]>[0],
  ) {
    this.calls.push("state.failDemoCommand");
    this.checkFailure("failDemoCommand");
    return {
      status: "failed" as const,
      stateVersion: input.expectedStateVersion + 1,
    };
  }

  async markResetApplied(
    input: Parameters<RecoveryStatePort["markResetApplied"]>[0],
  ) {
    this.calls.push("state.markResetApplied");
    this.checkFailure("markResetApplied");
    return {
      stateVersion: input.expectedStateVersion + 1,
      leaseExpiresAt: BASE_TIME + 30_000,
    };
  }

  async markFailureConfirmed(
    input: Parameters<RecoveryStatePort["markFailureConfirmed"]>[0],
  ) {
    this.calls.push("state.markFailureConfirmed");
    this.checkFailure("markFailureConfirmed");
    return {
      stateVersion: input.expectedStateVersion + 1,
      leaseExpiresAt: BASE_TIME + 30_000,
    };
  }

  async createIncident() {
    this.calls.push("state.createIncident");
    this.checkFailure("createIncident");
    return { incidentId: "incident_1", stateVersion: 0 };
  }

  async appendStep(input: RunnerStepInput) {
    this.calls.push(`state.append:${input.kind}`);
    this.checkFailure(`appendStep:${input.kind}`);
    this.steps.push(input);
    return { stepId: `step_${this.steps.length}`, sequence: this.steps.length };
  }

  async updateIncidentPhase(input: UpdateIncidentPhaseInput) {
    this.calls.push(`state.update:${input.nextPhase}`);
    this.checkFailure(`updateIncidentPhase:${input.nextPhase}`);
    this.phaseUpdates.push(input);
    return {
      stateVersion: input.expectedStateVersion + 1,
      recoveryStateVersion:
        input.expectedRecoveryStateVersion === undefined
          ? undefined
          : input.expectedRecoveryStateVersion + 1,
      recoveryCompletedAt:
        input.nextPhase === "verifying"
          ? SERVER_RECOVERY_COMPLETED_AT
          : undefined,
      leaseExpiresAt: BASE_TIME + 30_000,
    };
  }

  async createRecoveryCommand() {
    this.calls.push("state.createRecoveryCommand");
    this.checkFailure("createRecoveryCommand");
    return { recoveryCommandId: "recovery_1", stateVersion: 0 };
  }

  async completeIncident(input: CompleteIncidentInput) {
    this.calls.push(`state.complete:${input.terminalState}`);
    this.checkFailure(`completeIncident:${input.terminalState}`);
    this.completions.push(input);
    return {
      stateVersion: input.expectedIncidentStateVersion + 1,
      terminalState: input.terminalState,
    };
  }
}

class FakeWorkload implements DemoWorkloadPort {
  restartAttempts = 0;
  commandLabel: RecoveryActionResult["commandLabel"] =
    "docker start fixed demo service";
  stopped = false;
  stopFailure = false;
  restartFailure = false;
  inspectCalls = 0;
  inspectFailureOnCall: number | null = null;
  logsFailure = false;
  verification = HEALTHY_AFTER_RECOVERY;

  constructor(private readonly calls: string[]) {}

  async inspectSafeState() {
    this.calls.push("workload.inspect");
    this.inspectCalls += 1;
    if (this.inspectFailureOnCall === this.inspectCalls) {
      throw new Error("synthetic safe inspection failure");
    }
    return this.stopped ? EXITED_STATE : RUNNING_STATE;
  }

  async stopDemoService() {
    this.calls.push("workload.stop");
    if (this.stopFailure) {
      throw new Error("synthetic stop failure");
    }
    this.stopped = true;
  }

  async checkHealthOnce() {
    this.calls.push("workload.checkHealth");
    return FAILED_HEALTH;
  }

  async readSafeLogTail() {
    this.calls.push("workload.logs");
    if (this.logsFailure) {
      throw new Error("synthetic bounded log failure");
    }
    return SAFE_LOGS;
  }

  async executeRecoveryAction(): Promise<RecoveryActionResult> {
    this.calls.push("workload.execute");
    this.restartAttempts += 1;
    if (this.restartFailure) {
      throw new Error("synthetic restart failure");
    }
    return {
      actionId: "restart_demo_service",
      commandLabel: this.commandLabel,
      exitCode: 0,
      startedAt: BASE_TIME + 1_000,
      finishedAt: BASE_TIME + 1_100,
      durationMs: 100,
    };
  }

  async verifyFreshHealth(notBefore: number) {
    this.calls.push("workload.verify");
    expect(notBefore).toBe(SERVER_RECOVERY_COMPLETED_AT);
    return this.verification;
  }
}

function createHarness(
  investigation: InvestigationResult = successfulInvestigation(),
  timeOffset = 0,
) {
  const calls: string[] = [];
  const state = new FakeRecoveryState(calls);
  const workload = new FakeWorkload(calls);
  let currentInvestigation = investigation;
  let nextTime = BASE_TIME + timeOffset;
  const investigator = {
    investigate: vi.fn(async () => {
      calls.push("investigator.run");
      return currentInvestigation;
    }),
  };
  const policy = vi.fn((input: unknown) => {
    calls.push("policy.evaluate");
    return evaluateRecoveryPolicy(input);
  });
  const orchestrator = createRecoveryOrchestrator({
    state,
    workload,
    investigator,
    evaluatePolicy: policy,
    now: () => {
      nextTime += 10;
      return nextTime;
    },
  });

  return {
    calls,
    investigator,
    orchestrator,
    policy,
    setInvestigation(value: InvestigationResult) {
      currentInvestigation = value;
    },
    state,
    workload,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("complete staged recovery orchestration", () => {
  it("persists the Linux agent label in executor and durable execution evidence", async () => {
    const harness = createHarness();
    harness.workload.commandLabel =
      "linux agent restart fixed demo service";

    await expect(harness.orchestrator.run(QUEUED_COMMAND)).resolves.toMatchObject({
      status: "resolved",
    });

    expect(
      harness.state.phaseUpdates.find(
        (update) => update.nextPhase === "verifying",
      )?.executionEvidence,
    ).toMatchObject({
      commandLabel: "linux agent restart fixed demo service",
    });
    expect(
      harness.state.steps.find((step) => step.kind === "recovery_executed"),
    ).toMatchObject({
      role: "executor",
      safeCommandLabel: "linux agent restart fixed demo service",
    });
  });

  it("persists the exact real success sequence and resolves only after fresh health", async () => {
    const harness = createHarness();

    const result = await harness.orchestrator.run(QUEUED_COMMAND);

    expect(result).toEqual({
      status: "resolved",
      demoCommandId: "command_1",
      incidentId: "incident_1",
    });
    expect(harness.calls).toEqual([
      "state.claim",
      "workload.inspect",
      "workload.stop",
      "state.markResetApplied",
      "state.append:reset_applied",
      "workload.checkHealth",
      "state.markFailureConfirmed",
      "state.append:failure_confirmed",
      "state.createIncident",
      "state.update:investigating",
      "workload.inspect",
      "state.append:safe_state_collected",
      "workload.logs",
      "state.append:safe_logs_collected",
      "investigator.run",
      "state.append:diagnosis_completed",
      "state.update:manager_review",
      "state.append:manager_evidence_review",
      "state.update:policy_check",
      "policy.evaluate",
      "state.append:policy_decision",
      "state.createRecoveryCommand",
      "state.update:executing",
      "workload.execute",
      "state.update:verifying",
      "state.append:recovery_executed",
      "workload.verify",
      "state.append:verification_completed",
      "state.complete:resolved",
    ]);
    expect(harness.workload.restartAttempts).toBe(1);
    expect(
      harness.state.phaseUpdates.find(
        (update) => update.nextPhase === "manager_review",
      ),
    ).toMatchObject({
      diagnosisEvidence: [
        "Health check healthy: false",
        "Container status: exited",
      ],
    });
    expect(harness.state.steps.map((step) => step.role)).toEqual([
      "incident_manager",
      "incident_manager",
      "investigator",
      "investigator",
      "investigator",
      "incident_manager",
      "policy_gate",
      "executor",
      "verifier",
    ]);
    expect(harness.state.steps.map((step) => step.status)).toEqual(
      Array.from({ length: 9 }, () => "succeeded"),
    );
    expect(
      harness.state.steps.find((step) => step.kind === "diagnosis_completed"),
    ).toMatchObject({
      safeCommandLabel: "local codex schema-bound diagnosis",
      reportedInputTokens: 6_967,
      reportedOutputTokens: 93,
      latencyMs: 8_238,
      costStatus: "unavailable_chatgpt_subscription",
    });
    expect(
      harness.state.steps.find(
        (step) => step.kind === "manager_evidence_review",
      ),
    ).toMatchObject({
      sanitizedOutput: expect.stringContaining(
        '"evidenceReviewed":["Health check healthy: false","Container status: exited"]',
      ),
    });
    expect(
      harness.state.steps.find(
        (step) => step.kind === "manager_evidence_review",
      ),
    ).not.toHaveProperty("safeCommandLabel");
    expect(
      harness.state.steps.find((step) => step.kind === "policy_decision"),
    ).not.toHaveProperty("safeCommandLabel");
    expect(harness.state.completions).toEqual([
      expect.objectContaining({
        terminalState: "resolved",
        finalHealth: "healthy",
        verification: {
          service: "gx-autodevops-demo-service",
          status: "healthy",
          httpStatus: 200,
          requestStartedAt: SERVER_RECOVERY_COMPLETED_AT,
          checkedAt: SERVER_RECOVERY_COMPLETED_AT + 20,
        },
      }),
    ]);
  });
});

describe("safe no-restart branches", () => {
  it.each([
    {
      name: "low confidence",
      diagnosis: successfulInvestigation({ confidence: 0.79 }),
    },
    {
      name: "no action",
      diagnosis: successfulInvestigation({
        proposedActionId: "no_action",
        requiresHuman: false,
      }),
    },
    {
      name: "human required",
      diagnosis: successfulInvestigation({ requiresHuman: true }),
    },
  ])("ends in needs_human for $name", async ({ diagnosis }) => {
    const harness = createHarness(diagnosis);

    const result = await harness.orchestrator.run(QUEUED_COMMAND);

    expect(result.status).toBe("needs_human");
    expect(harness.workload.restartAttempts).toBe(0);
    expect(harness.calls).toContain("policy.evaluate");
    expect(
      harness.state.steps.some((step) => step.kind === "policy_decision"),
    ).toBe(true);
    expect(harness.state.completions.at(-1)).toMatchObject({
      terminalState: "needs_human",
      finalHealth: "failed",
    });
  });

  it.each([
    {
      name: "invalid action",
      investigation: successfulInvestigation({
        proposedActionId: "delete_everything" as "restart_demo_service",
      }),
    },
    {
      name: "malformed diagnosis",
      investigation: {
        ...successfulInvestigation(),
        diagnosis: { summary: "missing fields" },
      } as unknown as InvestigationResult,
    },
    {
      name: "Codex timeout",
      investigation: {
        status: "investigation_failed",
        failureReason: "timeout",
        startedAt: BASE_TIME,
        finishedAt: BASE_TIME + 45_000,
        latencyMs: 45_000,
        costStatus: "unavailable_chatgpt_subscription",
      } as InvestigationResult,
    },
  ])("ends in investigation_failed for $name", async ({ investigation }) => {
    const harness = createHarness(investigation);

    const result = await harness.orchestrator.run(QUEUED_COMMAND);

    expect(result.status).toBe("investigation_failed");
    expect(harness.workload.restartAttempts).toBe(0);
    expect(harness.state.completions.at(-1)).toMatchObject({
      terminalState: "investigation_failed",
    });
  });

  it("does not repeat an action when resuming an ambiguous executing state", async () => {
    const harness = createHarness();
    const executing: RecoveryCommandSnapshot = {
      ...QUEUED_COMMAND,
      status: "failure_confirmed",
      stateVersion: 3,
      incident: {
        id: "incident_1",
        currentPhase: "executing",
        stateVersion: 4,
        incidentCategory: "service_stopped",
        diagnosisEvidence: [
          "Health check healthy: false",
          "Container status: exited",
        ],
        diagnosisSummary: "The disposable demo service is stopped.",
        confidence: 0.96,
        requiresHuman: false,
        proposedActionId: "restart_demo_service",
      },
      recovery: {
        id: "recovery_1",
        actionId: "restart_demo_service",
        status: "executing",
        stateVersion: 1,
        executionNonce: "execution_command_1",
        completedAt: null,
        executionEvidence: null,
      },
    };

    const result = await harness.orchestrator.run(executing);

    expect(result.status).toBe("failed_recovery");
    expect(harness.workload.restartAttempts).toBe(0);
    expect(harness.state.completions.at(-1)).toMatchObject({
      terminalState: "failed_recovery",
      terminalReason: "execution_state_ambiguous_after_restart",
    });
  });

  it("rebuilds missing reset and failure audit rows from saved command state", async () => {
    const harness = createHarness();
    const resetApplied: RecoveryCommandSnapshot = {
      ...QUEUED_COMMAND,
      status: "reset_applied",
      stateVersion: 2,
    };

    const result = await harness.orchestrator.run(resetApplied);

    expect(result.status).toBe("resolved");
    expect(
      harness.state.steps.find((step) => step.kind === "reset_applied"),
    ).toMatchObject({
      sanitizedOutput: expect.stringContaining(
        '"restoredFromAuthoritativeCommandState":true',
      ),
    });
    expect(
      harness.state.steps.find((step) => step.kind === "failure_confirmed"),
    ).toBeDefined();
    expect(harness.calls.indexOf("state.append:reset_applied")).toBeLessThan(
      harness.calls.indexOf("state.markFailureConfirmed"),
    );
  });

  it("marks failed_recovery when restart throws", async () => {
    const harness = createHarness();
    harness.workload.restartFailure = true;

    const result = await harness.orchestrator.run(QUEUED_COMMAND);

    expect(result.status).toBe("failed_recovery");
    expect(harness.workload.restartAttempts).toBe(1);
    expect(harness.state.completions.at(-1)).toMatchObject({
      terminalState: "failed_recovery",
    });
  });

  it("never resolves when restart succeeds but fresh health remains failed", async () => {
    const harness = createHarness();
    harness.workload.verification = {
      ...FAILED_HEALTH,
      requestStartedAt: SERVER_RECOVERY_COMPLETED_AT,
      checkedAt: SERVER_RECOVERY_COMPLETED_AT + 20,
      attempts: 40,
    };

    const result = await harness.orchestrator.run(QUEUED_COMMAND);

    expect(result.status).toBe("failed_recovery");
    expect(harness.workload.restartAttempts).toBe(1);
    expect(harness.state.completions.at(-1)).toMatchObject({
      terminalState: "failed_recovery",
      finalHealth: "failed",
    });
  });

  it("stores executed recovery before a later trace write can fail", async () => {
    const harness = createHarness();
    harness.state.failOn = "appendStep:recovery_executed";

    const result = await harness.orchestrator.run(QUEUED_COMMAND);

    expect(result.status).toBe("state_conflict");
    expect(harness.workload.restartAttempts).toBe(1);
    expect(harness.calls.indexOf("state.update:verifying")).toBeGreaterThan(
      harness.calls.indexOf("workload.execute"),
    );
    expect(harness.calls.indexOf("state.update:verifying")).toBeLessThan(
      harness.calls.indexOf("state.append:recovery_executed"),
    );
  });

  it("rebuilds a missing Executor trace from saved execution evidence", async () => {
    const harness = createHarness();
    const verifying: RecoveryCommandSnapshot = {
      ...QUEUED_COMMAND,
      status: "failure_confirmed",
      stateVersion: 3,
      incident: {
        id: "incident_1",
        currentPhase: "verifying",
        stateVersion: 5,
        incidentCategory: "service_stopped",
        diagnosisEvidence: [
          "Health check healthy: false",
          "Container status: exited",
        ],
        diagnosisSummary: "The disposable demo service is stopped.",
        confidence: 0.96,
        requiresHuman: false,
        proposedActionId: "restart_demo_service",
      },
      recovery: {
        id: "recovery_1",
        actionId: "restart_demo_service",
        status: "executed",
        stateVersion: 2,
        executionNonce: "execution_command_1",
        completedAt: SERVER_RECOVERY_COMPLETED_AT,
        executionEvidence: {
          commandLabel: "docker start fixed demo service",
          exitCode: 0,
          startedAt: BASE_TIME + 1_000,
          finishedAt: BASE_TIME + 1_100,
          latencyMs: 100,
        },
      },
      stepNonces: [],
    };

    const result = await harness.orchestrator.run(verifying);

    expect(result.status).toBe("resolved");
    expect(harness.workload.restartAttempts).toBe(0);
    expect(harness.calls.indexOf("state.append:recovery_executed")).toBeLessThan(
      harness.calls.indexOf("workload.verify"),
    );
    expect(
      harness.state.steps.find((step) => step.kind === "recovery_executed"),
    ).toMatchObject({
      role: "executor",
      safeCommandLabel: "docker start fixed demo service",
      latencyMs: 100,
      sanitizedOutput: expect.stringContaining(
        '"restoredFromDurableExecutionRecord":true',
      ),
    });
  });

  it("gives different persisted diagnoses different replay identities", async () => {
    const first = createHarness(
      successfulInvestigation({ summary: "First grounded diagnosis." }),
    );
    const second = createHarness(
      successfulInvestigation({ summary: "Different grounded diagnosis." }),
    );

    await first.orchestrator.run(QUEUED_COMMAND);
    await second.orchestrator.run(QUEUED_COMMAND);

    const firstNonce = first.state.steps.find(
      (step) => step.kind === "diagnosis_completed",
    )?.stepNonce;
    const secondNonce = second.state.steps.find(
      (step) => step.kind === "diagnosis_completed",
    )?.stepNonce;
    expect(firstNonce).toBeTruthy();
    expect(secondNonce).toBeTruthy();
    expect(firstNonce).not.toBe(secondNonce);
  });

  it("keeps one replay identity for the same Manager review after a restart", async () => {
    const first = createHarness(successfulInvestigation(), 0);
    const resumed = createHarness(successfulInvestigation(), 30_000);

    await first.orchestrator.run(QUEUED_COMMAND);
    await resumed.orchestrator.run(QUEUED_COMMAND);

    const firstNonce = first.state.steps.find(
      (step) => step.kind === "manager_evidence_review",
    )?.stepNonce;
    const resumedNonce = resumed.state.steps.find(
      (step) => step.kind === "manager_evidence_review",
    )?.stepNonce;
    expect(firstNonce).toBeTruthy();
    expect(resumedNonce).toBe(firstNonce);
  });

  it.each(["claimDemoCommand", "updateIncidentPhase:policy_check"])(
    "does not restart after authoritative state rejection at %s",
    async (failure) => {
      const harness = createHarness();
      harness.state.failOn = failure;

      const result = await harness.orchestrator.run(QUEUED_COMMAND);

      expect(result.status).toBe("state_conflict");
      expect(harness.workload.restartAttempts).toBe(0);
    },
  );

  it("closes a stop failure before creating an incident", async () => {
    const harness = createHarness();
    harness.workload.stopFailure = true;

    const result = await harness.orchestrator.run(QUEUED_COMMAND);

    expect(result.status).toBe("command_failed");
    expect(harness.calls).toContain("state.failDemoCommand");
    expect(harness.calls).not.toContain("state.createIncident");
    expect(harness.workload.restartAttempts).toBe(0);
  });

  it.each([
    { name: "safe inspection", inspectFailureOnCall: 2, logsFailure: false },
    { name: "bounded logs", inspectFailureOnCall: null, logsFailure: true },
  ])(
    "closes $name collection failures as investigation_failed",
    async ({ inspectFailureOnCall, logsFailure }) => {
      const harness = createHarness();
      harness.workload.inspectFailureOnCall = inspectFailureOnCall;
      harness.workload.logsFailure = logsFailure;

      const result = await harness.orchestrator.run(QUEUED_COMMAND);

      expect(result.status).toBe("investigation_failed");
      expect(harness.workload.restartAttempts).toBe(0);
      expect(harness.state.completions.at(-1)).toMatchObject({
        terminalState: "investigation_failed",
        terminalReason: "evidence_collection_failed",
      });
      expect(
        harness.state.steps.some(
          (step) => step.kind === "evidence_collection_failed",
        ),
      ).toBe(true);
    },
  );

  it("does not execute recovery after the run is cancelled", async () => {
    const calls: string[] = [];
    const state = new FakeRecoveryState(calls);
    const workload = new FakeWorkload(calls);
    const investigation = deferred<InvestigationResult>();
    const abortController = new AbortController();
    const orchestrator = createRecoveryOrchestrator({
      state,
      workload,
      investigator: { investigate: vi.fn(() => investigation.promise) },
      evaluatePolicy: evaluateRecoveryPolicy,
      now: () => BASE_TIME,
    });
    const run = orchestrator.run(QUEUED_COMMAND, abortController.signal);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await Promise.resolve();
      if (calls.includes("workload.logs")) {
        break;
      }
    }

    abortController.abort();
    investigation.resolve(successfulInvestigation());
    const result = await run;

    expect(result.status).toBe("state_conflict");
    expect(workload.restartAttempts).toBe(0);
  });

  it("does not report cancellation during reset as a Docker failure", async () => {
    const harness = createHarness();
    const pendingInspection = deferred<SafeContainerState>();
    vi.spyOn(harness.workload, "inspectSafeState").mockImplementationOnce(
      () => pendingInspection.promise,
    );
    const abortController = new AbortController();

    const run = harness.orchestrator.run(
      QUEUED_COMMAND,
      abortController.signal,
    );
    await Promise.resolve();
    abortController.abort();
    pendingInspection.resolve(RUNNING_STATE);
    const result = await run;

    expect(result.status).toBe("state_conflict");
    expect(harness.calls).not.toContain("workload.stop");
    expect(harness.calls).not.toContain("state.failDemoCommand");
  });
});

describe("claim lease renewal", () => {
  it("validates a resumed claim before its first Docker read or write", async () => {
    const harness = createHarness();
    harness.state.failOn = "renewLease";
    const resumedClaim: RecoveryCommandSnapshot = {
      ...QUEUED_COMMAND,
      status: "claimed",
      stateVersion: 1,
    };

    const result = await harness.orchestrator.run(resumedClaim);

    expect(result.status).toBe("state_conflict");
    expect(harness.calls).toEqual(["state.renewLease"]);
    expect(harness.workload.stopped).toBe(false);
  });

  it("renews during a slow investigation and blocks restart if renewal fails", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const state = new FakeRecoveryState(calls);
    const workload = new FakeWorkload(calls);
    const investigation = deferred<InvestigationResult>();
    const investigator = {
      investigate: vi.fn(() => investigation.promise),
    };
    const orchestrator = createRecoveryOrchestrator({
      state,
      workload,
      investigator,
      evaluatePolicy: evaluateRecoveryPolicy,
      now: () => BASE_TIME,
      leaseRenewalIntervalMs: 10_000,
    });
    const run = orchestrator.run(QUEUED_COMMAND);
    await Promise.resolve();

    state.failOn = "renewLease";
    await vi.advanceTimersByTimeAsync(10_000);
    investigation.resolve(successfulInvestigation());
    const result = await run;

    expect(calls).toContain("state.renewLease");
    expect(result.status).toBe("state_conflict");
    expect(workload.restartAttempts).toBe(0);
  });
});
