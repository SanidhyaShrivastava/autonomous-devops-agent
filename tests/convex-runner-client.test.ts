import type { ConvexClient, ConnectionState } from "convex/browser";
import { describe, expect, it, vi } from "vitest";

import {
  createConvexRunnerClient,
  normalizeConvexDeploymentUrl,
  parseRecoveryLabel,
} from "../runner/convex-client";

const RUNNER_TOKEN = "runner-test-token-with-enough-entropy";
const RUNNER_ID = "gx-local-runner";

class FakeConvexClient {
  readonly mutationCalls: Array<{ args: Record<string, unknown> }> = [];
  readonly mutationResults: unknown[] = [];
  readonly queryCalls: Array<{ args: Record<string, unknown> }> = [];
  readonly queryResults: unknown[] = [];
  updateCallback: ((value: unknown) => unknown) | null = null;
  updateErrorCallback: ((error: Error) => unknown) | null = null;
  readonly unsubscribe = vi.fn();
  readonly close = vi.fn(async () => undefined);

  async mutation(
    _reference: unknown,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.mutationCalls.push({ args });
    if (this.mutationResults.length === 0) {
      throw new Error("Missing fake mutation result");
    }
    return this.mutationResults.shift();
  }

  async query(
    _reference: unknown,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.queryCalls.push({ args });
    if (this.queryResults.length === 0) {
      throw new Error("Missing fake query result");
    }
    return this.queryResults.shift();
  }

  onUpdate(
    _reference: unknown,
    _args: Record<string, unknown>,
    callback: (value: unknown) => unknown,
    onError?: (error: Error) => unknown,
  ) {
    this.updateCallback = callback;
    this.updateErrorCallback = onError ?? null;
    return this.unsubscribe;
  }

  connectionState(): ConnectionState {
    return {
      hasInflightRequests: false,
      isWebSocketConnected: true,
      timeOfOldestInflightRequest: null,
      hasEverConnected: true,
      connectionCount: 1,
      connectionRetries: 0,
      inflightMutations: 0,
      inflightActions: 0,
    };
  }

  subscribeToConnectionState() {
    return vi.fn();
  }
}

function makeClient(fake: FakeConvexClient) {
  return createConvexRunnerClient({
    convexUrl: "https://example.convex.cloud",
    runnerToken: RUNNER_TOKEN,
    runnerId: RUNNER_ID,
    client: fake as unknown as ConvexClient,
  });
}

describe("Convex runner client", () => {
  it("parses only the two exact recovery command labels", () => {
    expect(parseRecoveryLabel("docker start fixed demo service")).toBe(
      "docker start fixed demo service",
    );
    expect(
      parseRecoveryLabel("linux agent restart fixed demo service"),
    ).toBe("linux agent restart fixed demo service");
    expect(() => parseRecoveryLabel("run anything")).toThrow();
  });

  it("keeps the Convex origin slash-free for its WebSocket path", () => {
    expect(
      normalizeConvexDeploymentUrl("https://example.convex.cloud"),
    ).toBe("https://example.convex.cloud");
    expect(
      normalizeConvexDeploymentUrl("https://example.convex.cloud/"),
    ).toBe("https://example.convex.cloud");
    expect(
      normalizeConvexDeploymentUrl("http://127.0.0.1:3210/"),
    ).toBe("http://127.0.0.1:3210");
  });

  it("rejects unsafe Convex URLs before a runner secret is sent", () => {
    expect(() =>
      normalizeConvexDeploymentUrl("http://remote.example.com"),
    ).toThrow("HTTPS");
    expect(() =>
      normalizeConvexDeploymentUrl(
        "https://user:password@example.convex.cloud",
      ),
    ).toThrow("credentials");
    expect(() =>
      normalizeConvexDeploymentUrl("https://example.convex.cloud/path"),
    ).toThrow("origin");
    expect(() =>
      normalizeConvexDeploymentUrl("https://example.convex.cloud?x=1"),
    ).toThrow("origin");
  });

  it("adds the runner secret internally to every mutation", async () => {
    const fake = new FakeConvexClient();
    fake.mutationResults.push(
      { runnerHeartbeatAt: 100 },
      { status: "claimed", stateVersion: 1, leaseExpiresAt: 200 },
      { stateVersion: 1, leaseExpiresAt: 210 },
      { status: "failed", stateVersion: 2 },
      { stateVersion: 2, leaseExpiresAt: 220 },
      { stateVersion: 3, leaseExpiresAt: 230 },
      { incidentId: "incident_1", stateVersion: 0 },
      { stepId: "step_1", sequence: 1 },
      { stateVersion: 1, leaseExpiresAt: 240 },
      { recoveryCommandId: "recovery_1", stateVersion: 0 },
      { stateVersion: 2, terminalState: "resolved" },
    );
    const client = makeClient(fake);

    await client.heartbeat();
    await client.claimDemoCommand({
      demoCommandId: "command_1",
      expectedStateVersion: 0,
      claimNonce: "claim_command_1",
    });
    await client.renewLease({
      demoCommandId: "command_1",
      expectedStateVersion: 1,
    });
    await client.failDemoCommand({
      demoCommandId: "command_1",
      expectedStateVersion: 1,
      terminalReason: "synthetic test",
    });
    await client.markResetApplied({
      demoCommandId: "command_1",
      expectedStateVersion: 1,
    });
    await client.markFailureConfirmed({
      demoCommandId: "command_1",
      expectedStateVersion: 2,
    });
    await client.createIncident({
      demoCommandId: "command_1",
      expectedCommandStateVersion: 3,
      initialHealth: "failed",
    });
    await client.appendStep({
      demoCommandId: "command_1",
      incidentId: "incident_1",
      expectedCommandStateVersion: 3,
      expectedIncidentStateVersion: 0,
      stepNonce: "step_test_1",
      role: "incident_manager",
      kind: "test_step",
      status: "succeeded",
      startedAt: 100,
      finishedAt: 110,
      latencyMs: 10,
    });
    await client.updateIncidentPhase({
      demoCommandId: "command_1",
      incidentId: "incident_1",
      expectedPhase: "failed_detected",
      nextPhase: "investigating",
      expectedStateVersion: 0,
      expectedCommandStateVersion: 3,
    });
    await client.createRecoveryCommand({
      demoCommandId: "command_1",
      incidentId: "incident_1",
      expectedCommandStateVersion: 3,
      expectedIncidentPhase: "policy_check",
      expectedIncidentStateVersion: 3,
      actionId: "restart_demo_service",
      executionNonce: "execution_command_1",
    });
    await client.completeIncident({
      demoCommandId: "command_1",
      incidentId: "incident_1",
      expectedPhase: "verifying",
      expectedIncidentStateVersion: 5,
      expectedCommandStateVersion: 3,
      terminalState: "resolved",
      finalHealth: "healthy",
    });

    expect(fake.mutationCalls).toHaveLength(11);
    for (const call of fake.mutationCalls) {
      expect(call.args).toMatchObject({
        runnerToken: RUNNER_TOKEN,
        runnerId: RUNNER_ID,
      });
    }
    expect(client).not.toHaveProperty("runnerToken");
  });

  it("maps a live Convex command into the bounded orchestrator snapshot", () => {
    const fake = new FakeConvexClient();
    const client = makeClient(fake);
    const onCommand = vi.fn();
    const onError = vi.fn();

    client.subscribeToActiveCommand(onCommand, onError);
    fake.updateCallback?.({
      _id: "command_1",
      kind: "RESET_DEMO_V1",
      status: "failure_confirmed",
      createdAt: 10,
      expiresAt: 1_000,
      claimedAt: 20,
      leaseExpiresAt: 2_000,
      stateVersion: 3,
      executionMode: "autonomous",
      incidentId: "incident_1",
      incident: {
        _id: "incident_1",
        currentPhase: "policy_check",
        stateVersion: 3,
        incidentCategory: "service_stopped",
        diagnosisEvidence: [
          "Health check healthy: false",
          "Container status: exited",
        ],
        diagnosisSummary: "The fixed demo service is stopped.",
        confidence: 0.99,
        requiresHuman: false,
        proposedActionId: "restart_demo_service",
      },
      recovery: {
        _id: "recovery_1",
        actionId: "restart_demo_service",
        status: "allowed",
        stateVersion: 0,
        executionNonce: "execution_command_1",
        completedAt: null,
        executionEvidence: null,
        approvalStatus: null,
        approvalRequestedAt: null,
        approvalExpiresAt: null,
        approvalDecidedAt: null,
      },
      stepNonces: ["step_failure_confirmed_command_1"],
    });

    expect(onError).not.toHaveBeenCalled();
    expect(onCommand).toHaveBeenCalledWith({
      id: "command_1",
      kind: "RESET_DEMO_V1",
      status: "failure_confirmed",
      createdAt: 10,
      expiresAt: 1_000,
      leaseExpiresAt: 2_000,
      stateVersion: 3,
      executionMode: "autonomous",
      incident: {
        id: "incident_1",
        currentPhase: "policy_check",
        stateVersion: 3,
        incidentCategory: "service_stopped",
        diagnosisEvidence: [
          "Health check healthy: false",
          "Container status: exited",
        ],
        diagnosisSummary: "The fixed demo service is stopped.",
        confidence: 0.99,
        requiresHuman: false,
        proposedActionId: "restart_demo_service",
      },
      recovery: {
        id: "recovery_1",
        actionId: "restart_demo_service",
        status: "allowed",
        stateVersion: 0,
        executionNonce: "execution_command_1",
        completedAt: null,
        executionEvidence: null,
        approvalStatus: null,
        approvalRequestedAt: null,
        approvalExpiresAt: null,
        approvalDecidedAt: null,
      },
      stepNonces: ["step_failure_confirmed_command_1"],
    });
  });

  it("maps a durable pending approval without exposing its capability", () => {
    const fake = new FakeConvexClient();
    const client = makeClient(fake);
    const onCommand = vi.fn();
    const onError = vi.fn();

    client.subscribeToActiveCommand(onCommand, onError);
    fake.updateCallback?.({
      _id: "command_approval",
      kind: "RESET_DEMO_V1",
      status: "failure_confirmed",
      createdAt: 10,
      expiresAt: 1_000,
      claimedAt: 20,
      leaseExpiresAt: 2_000,
      stateVersion: 3,
      executionMode: "approval_required",
      incidentId: "incident_approval",
      incident: {
        _id: "incident_approval",
        currentPhase: "awaiting_approval",
        stateVersion: 5,
        incidentCategory: "service_stopped",
        diagnosisEvidence: ["Container status: exited"],
        diagnosisSummary: "The fixed demo service is stopped.",
        confidence: 0.99,
        requiresHuman: false,
        proposedActionId: "restart_demo_service",
      },
      recovery: {
        _id: "recovery_approval",
        actionId: "restart_demo_service",
        status: "proposed",
        stateVersion: 1,
        executionNonce: "execution_command_approval",
        completedAt: null,
        executionEvidence: null,
        approvalStatus: "pending",
        approvalRequestedAt: 100,
        approvalExpiresAt: 300_100,
        approvalDecidedAt: null,
      },
      stepNonces: ["step_approval_requested_saved"],
    });

    expect(onError).not.toHaveBeenCalled();
    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: "approval_required",
        incident: expect.objectContaining({
          currentPhase: "awaiting_approval",
        }),
        recovery: expect.objectContaining({
          approvalStatus: "pending",
          approvalRequestedAt: 100,
          approvalExpiresAt: 300_100,
          approvalDecidedAt: null,
        }),
      }),
    );
    expect(onCommand.mock.calls[0]?.[0]).not.toHaveProperty(
      "approvalCapabilityDigest",
    );
  });

  it("passes an empty active command through as null", () => {
    const fake = new FakeConvexClient();
    const client = makeClient(fake);
    const onCommand = vi.fn();

    client.subscribeToActiveCommand(onCommand, vi.fn());
    fake.updateCallback?.(null);

    expect(onCommand).toHaveBeenCalledWith(null);
  });

  it("gets the current command once with the private runner identity", async () => {
    const fake = new FakeConvexClient();
    fake.queryResults.push(null);
    const client = makeClient(fake);

    await expect(client.getActiveCommand()).resolves.toBeNull();
    expect(fake.queryCalls).toEqual([
      {
        args: {
          runnerToken: RUNNER_TOKEN,
          runnerId: RUNNER_ID,
        },
      },
    ]);
  });

  it("reports malformed live data and subscription errors without throwing", () => {
    const fake = new FakeConvexClient();
    const client = makeClient(fake);
    const onError = vi.fn();

    client.subscribeToActiveCommand(vi.fn(), onError);
    expect(() => fake.updateCallback?.({ _id: "bad" })).not.toThrow();
    const backendError = new Error("Backend unavailable");
    fake.updateErrorCallback?.(backendError);

    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenLastCalledWith(backendError);
  });

  it("unsubscribes and closes the live Convex connection", async () => {
    const fake = new FakeConvexClient();
    const client = makeClient(fake);
    const unsubscribe = client.subscribeToActiveCommand(vi.fn(), vi.fn());

    unsubscribe();
    await client.close();

    expect(fake.unsubscribe).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledOnce();
  });
});
