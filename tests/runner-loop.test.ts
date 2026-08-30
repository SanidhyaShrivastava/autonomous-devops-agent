import type { ConnectionState } from "convex/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConvexRunnerClient } from "../runner/convex-client";
import type {
  OrchestrationResult,
  RecoveryCommandSnapshot,
  RecoveryOrchestrator,
} from "../runner/orchestrator";
import {
  startRunnerLoop,
  verifyIdleDemoWorkloadReady,
} from "../runner/index";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const command = (id: string): RecoveryCommandSnapshot => ({
  id,
  kind: "RESET_DEMO_V1",
  status: "queued",
  createdAt: 1,
  expiresAt: 10_000,
  leaseExpiresAt: null,
  stateVersion: 0,
  incident: null,
  recovery: null,
  stepNonces: [],
});

class FakeRunnerClient {
  readonly heartbeat = vi.fn(async () => ({ runnerHeartbeatAt: Date.now() }));
  readonly getActiveCommand = vi.fn(
    async (): Promise<RecoveryCommandSnapshot | null> => null,
  );
  throwOnCommandSubscription = false;
  throwOnConnectionState = false;
  throwOnConnectionSubscription = false;
  commandCallback:
    | ((command: RecoveryCommandSnapshot | null) => unknown)
    | null = null;
  commandErrorCallback: ((error: Error) => unknown) | null = null;
  readonly unsubscribeCommand = vi.fn();
  readonly unsubscribeConnection = vi.fn();
  readonly close = vi.fn(async () => undefined);

  subscribeToActiveCommand(
    callback: (command: RecoveryCommandSnapshot | null) => unknown,
    onError: (error: Error) => unknown,
  ) {
    if (this.throwOnCommandSubscription) {
      throw new Error("synthetic command subscription failure");
    }
    this.commandCallback = callback;
    this.commandErrorCallback = onError;
    return this.unsubscribeCommand;
  }

  connectionState(): ConnectionState {
    if (this.throwOnConnectionState) {
      throw new Error("synthetic connection state failure");
    }
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
    if (this.throwOnConnectionSubscription) {
      throw new Error("synthetic connection subscription failure");
    }
    return this.unsubscribeConnection;
  }
}

function asClient(fake: FakeRunnerClient) {
  return fake as unknown as ConvexRunnerClient;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runner process loop", () => {
  it("closes the client if the first heartbeat cannot connect", async () => {
    const fakeClient = new FakeRunnerClient();
    fakeClient.heartbeat.mockRejectedValueOnce(
      new Error("synthetic initial connection failure"),
    );

    await expect(
      startRunnerLoop({
        client: asClient(fakeClient),
        orchestrator: {
          async run(snapshot): Promise<OrchestrationResult> {
            return { status: "ignored", demoCommandId: snapshot.id };
          },
        },
      }),
    ).rejects.toThrow("synthetic initial connection failure");
    expect(fakeClient.close).toHaveBeenCalledOnce();
  });

  it("runs live commands one at a time", async () => {
    const fakeClient = new FakeRunnerClient();
    const firstRun = deferred<OrchestrationResult>();
    let activeRuns = 0;
    let maximumActiveRuns = 0;
    const seen: string[] = [];
    const orchestrator: RecoveryOrchestrator = {
      async run(snapshot): Promise<OrchestrationResult> {
        seen.push(snapshot.id);
        activeRuns += 1;
        maximumActiveRuns = Math.max(maximumActiveRuns, activeRuns);
        if (snapshot.id === "command_1") {
          await firstRun.promise;
        }
        activeRuns -= 1;
        return {
          status: "ignored",
          demoCommandId: snapshot.id,
        };
      },
    };
    const runtime = await startRunnerLoop({
      client: asClient(fakeClient),
      orchestrator,
      heartbeatIntervalMs: 60_000,
    });

    fakeClient.commandCallback?.(command("command_1"));
    await flushPromises();
    fakeClient.commandCallback?.(command("command_2"));
    await flushPromises();

    expect(seen).toEqual(["command_1"]);
    expect(maximumActiveRuns).toBe(1);

    firstRun.resolve({ status: "ignored", demoCommandId: "command_1" });
    await flushPromises();

    expect(seen).toEqual(["command_1", "command_2"]);
    expect(maximumActiveRuns).toBe(1);
    await runtime.stop();
  });

  it("waits for one heartbeat to finish before scheduling another", async () => {
    vi.useFakeTimers();
    const fakeClient = new FakeRunnerClient();
    const secondHeartbeat = deferred<{ runnerHeartbeatAt: number }>();
    fakeClient.heartbeat
      .mockResolvedValueOnce({ runnerHeartbeatAt: 1 })
      .mockReturnValueOnce(secondHeartbeat.promise)
      .mockResolvedValue({ runnerHeartbeatAt: 3 });
    const runtime = await startRunnerLoop({
      client: asClient(fakeClient),
      orchestrator: {
        async run(snapshot): Promise<OrchestrationResult> {
          return { status: "ignored", demoCommandId: snapshot.id };
        },
      },
      heartbeatIntervalMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fakeClient.heartbeat).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fakeClient.heartbeat).toHaveBeenCalledTimes(2);

    secondHeartbeat.resolve({ runnerHeartbeatAt: 2 });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fakeClient.heartbeat).toHaveBeenCalledTimes(3);
    await runtime.stop();
  });

  it("reports live-subscription failures without exposing the backend message", async () => {
    const fakeClient = new FakeRunnerClient();
    const logError = vi.fn();
    const runtime = await startRunnerLoop({
      client: asClient(fakeClient),
      orchestrator: {
        async run(snapshot): Promise<OrchestrationResult> {
          return { status: "ignored", demoCommandId: snapshot.id };
        },
      },
      heartbeatIntervalMs: 60_000,
      logError,
    });

    fakeClient.commandErrorCallback?.(
      new Error("RUNNER_TOKEN=do-not-print private backend detail"),
    );

    expect(logError).toHaveBeenCalledWith(
      "Runner lost its live command feed; Convex will reconnect automatically.",
    );
    expect(JSON.stringify(logError.mock.calls)).not.toContain("do-not-print");
    await runtime.stop();
  });

  it("cancels future recovery work, waits for the active command, and closes once", async () => {
    const fakeClient = new FakeRunnerClient();
    const activeRun = deferred<OrchestrationResult>();
    let activeSignal: AbortSignal | undefined;
    const orchestrator: RecoveryOrchestrator = {
      run: vi.fn(async (_snapshot, signal) => {
        activeSignal = signal;
        return await activeRun.promise;
      }),
    };
    const runtime = await startRunnerLoop({
      client: asClient(fakeClient),
      orchestrator,
      heartbeatIntervalMs: 60_000,
    });
    fakeClient.commandCallback?.(command("command_1"));
    await flushPromises();

    const stopping = runtime.stop();
    await flushPromises();
    expect(activeSignal?.aborted).toBe(true);
    expect(fakeClient.close).not.toHaveBeenCalled();

    activeRun.resolve({ status: "ignored", demoCommandId: "command_1" });
    await stopping;
    await runtime.stop();

    expect(fakeClient.unsubscribeCommand).toHaveBeenCalledOnce();
    expect(fakeClient.unsubscribeConnection).toHaveBeenCalledOnce();
    expect(fakeClient.close).toHaveBeenCalledOnce();
  });

  it("closes after a bounded wait when an in-flight heartbeat never settles", async () => {
    vi.useFakeTimers();
    const fakeClient = new FakeRunnerClient();
    const stuckHeartbeat = deferred<{ runnerHeartbeatAt: number }>();
    fakeClient.heartbeat
      .mockResolvedValueOnce({ runnerHeartbeatAt: 1 })
      .mockReturnValueOnce(stuckHeartbeat.promise);
    const runtime = await startRunnerLoop({
      client: asClient(fakeClient),
      orchestrator: {
        async run(snapshot): Promise<OrchestrationResult> {
          return { status: "ignored", demoCommandId: snapshot.id };
        },
      },
      heartbeatIntervalMs: 5_000,
      shutdownGraceMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    const stopping = runtime.stop();
    await vi.advanceTimersByTimeAsync(999);
    expect(fakeClient.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stopping;

    expect(fakeClient.close).toHaveBeenCalledOnce();
    stuckHeartbeat.resolve({ runnerHeartbeatAt: 2 });
  });

  it("keeps Convex open past the network grace while Docker is still changing", async () => {
    vi.useFakeTimers();
    const fakeClient = new FakeRunnerClient();
    const dockerMutation = deferred<void>();
    const stuckTail = deferred<OrchestrationResult>();
    const runtime = await startRunnerLoop({
      client: asClient(fakeClient),
      orchestrator: {
        async run(snapshot, _signal, activity): Promise<OrchestrationResult> {
          activity?.onCriticalMutationStart();
          await dockerMutation.promise;
          activity?.onCriticalMutationEnd();
          return await stuckTail.promise;
        },
      },
      heartbeatIntervalMs: 60_000,
      shutdownGraceMs: 1_000,
    });
    fakeClient.commandCallback?.(command("command_1"));
    await flushPromises();

    const stopping = runtime.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fakeClient.close).not.toHaveBeenCalled();

    dockerMutation.resolve();
    await stopping;

    expect(fakeClient.close).toHaveBeenCalledOnce();
    stuckTail.resolve({ status: "ignored", demoCommandId: "command_1" });
  });

  it.each([
    "command",
    "connection-state",
    "connection-subscription",
  ] as const)(
    "cleans up after a %s setup failure",
    async (failurePoint) => {
      const fakeClient = new FakeRunnerClient();
      fakeClient.throwOnCommandSubscription = failurePoint === "command";
      fakeClient.throwOnConnectionState = failurePoint === "connection-state";
      fakeClient.throwOnConnectionSubscription =
        failurePoint === "connection-subscription";

      await expect(
        startRunnerLoop({
          client: asClient(fakeClient),
          orchestrator: {
            async run(snapshot): Promise<OrchestrationResult> {
              return { status: "ignored", demoCommandId: snapshot.id };
            },
          },
        }),
      ).rejects.toThrow("synthetic");

      expect(fakeClient.close).toHaveBeenCalledOnce();
      expect(fakeClient.unsubscribeCommand).toHaveBeenCalledTimes(
        failurePoint === "command" ? 0 : 1,
      );
      expect(fakeClient.unsubscribeConnection).not.toHaveBeenCalled();
    },
  );

  it("still closes when subscription cleanup itself throws", async () => {
    const fakeClient = new FakeRunnerClient();
    const logError = vi.fn();
    const runtime = await startRunnerLoop({
      client: asClient(fakeClient),
      orchestrator: {
        async run(snapshot): Promise<OrchestrationResult> {
          return { status: "ignored", demoCommandId: snapshot.id };
        },
      },
      heartbeatIntervalMs: 60_000,
      logError,
    });
    fakeClient.unsubscribeCommand.mockImplementationOnce(() => {
      throw new Error("synthetic unsubscribe failure");
    });
    fakeClient.unsubscribeConnection.mockImplementationOnce(() => {
      throw new Error("synthetic unsubscribe failure");
    });

    await runtime.stop();

    expect(fakeClient.close).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it("preserves a setup error even when partial cleanup throws", async () => {
    const fakeClient = new FakeRunnerClient();
    fakeClient.throwOnConnectionSubscription = true;
    fakeClient.unsubscribeCommand.mockImplementationOnce(() => {
      throw new Error("synthetic cleanup failure");
    });

    await expect(
      startRunnerLoop({
        client: asClient(fakeClient),
        orchestrator: {
          async run(snapshot): Promise<OrchestrationResult> {
            return { status: "ignored", demoCommandId: snapshot.id };
          },
        },
      }),
    ).rejects.toThrow("synthetic connection subscription failure");
    expect(fakeClient.close).toHaveBeenCalledOnce();
  });
});

describe("runner startup readiness", () => {
  const readyState = {
    status: "running",
    exitCode: 0,
    oomKilled: false,
    finishedAt: "0001-01-01T00:00:00Z",
    demoLabel: "autonomous-devops-agent" as const,
  };
  const healthy = {
    healthy: true,
    httpStatus: 200,
    service: "gx-autodevops-demo-service",
    status: "healthy",
    requestStartedAt: 100,
    checkedAt: 110,
    attempts: 1,
  };

  it("proves the exact idle workload is running and healthy", async () => {
    const client = { getActiveCommand: vi.fn(async () => null) };
    const workload = {
      inspectSafeState: vi.fn(async () => readyState),
      checkHealthOnce: vi.fn(async () => healthy),
    };

    await expect(
      verifyIdleDemoWorkloadReady(client, workload),
    ).resolves.toEqual({ status: "idle_workload_ready" });
  });

  it("refuses to advertise an unhealthy idle workload as online", async () => {
    const client = { getActiveCommand: vi.fn(async () => null) };
    const workload = {
      inspectSafeState: vi.fn(async () => readyState),
      checkHealthOnce: vi.fn(async () => ({ ...healthy, healthy: false })),
    };

    await expect(
      verifyIdleDemoWorkloadReady(client, workload),
    ).rejects.toThrow("not healthy");
  });

  it("resumes a freshly leased command after validating container identity", async () => {
    const client = {
      getActiveCommand: vi.fn(async () => ({
        ...command("command_1"),
        status: "failure_confirmed" as const,
        leaseExpiresAt: 200,
      })),
    };
    const workload = {
      inspectSafeState: vi.fn(async () => readyState),
      checkHealthOnce: vi.fn(),
    };

    await expect(
      verifyIdleDemoWorkloadReady(client, workload, () => 100),
    ).resolves.toEqual({ status: "resuming_active_command" });
    expect(workload.inspectSafeState).toHaveBeenCalledOnce();
    expect(workload.checkHealthOnce).not.toHaveBeenCalled();
  });

  it("does not let an expired active command bypass idle readiness", async () => {
    const client = {
      getActiveCommand: vi.fn(async () => ({
        ...command("command_1"),
        status: "claimed" as const,
        leaseExpiresAt: 99,
      })),
    };
    const workload = {
      inspectSafeState: vi.fn(async () => ({
        ...readyState,
        status: "exited",
      })),
      checkHealthOnce: vi.fn(),
    };

    await expect(
      verifyIdleDemoWorkloadReady(client, workload, () => 100),
    ).rejects.toThrow("not running");
    expect(workload.checkHealthOnce).not.toHaveBeenCalled();
  });
});
