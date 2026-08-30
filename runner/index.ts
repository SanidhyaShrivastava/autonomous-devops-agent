import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { config as loadEnvironment } from "dotenv";

import {
  DEMO_HEALTHY_STATUS,
  DEMO_RUNNER_ID,
  DEMO_SERVICE_IDENTITY,
} from "../src/lib/contracts";
import {
  createConvexRunnerClient,
  type ConvexRunnerClient,
  type HeartbeatResult,
} from "./convex-client";
import { createCodexInvestigator } from "./codex-investigator";
import { DEMO_LABEL_VALUE } from "./config";
import { DockerAdapter } from "./docker-adapter";
import {
  createEnvironmentRestorer,
  type EnvironmentRecoveryRequest,
  type EnvironmentRestorationResult,
  type EnvironmentRestorer,
} from "./environment-restorer";
import {
  createRecoveryOrchestrator,
  type DemoWorkloadPort,
  type RecoveryActivityObserver,
  type RecoveryCommandSnapshot,
  type RecoveryOrchestrator,
} from "./orchestrator";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;

export interface RunnerLoopOptions {
  readonly client: ConvexRunnerClient;
  readonly orchestrator: RecoveryOrchestrator;
  readonly heartbeatIntervalMs?: number;
  readonly shutdownGraceMs?: number;
  readonly environmentRestorer?: EnvironmentRestorer;
  readonly verifyStartupReady?: () => Promise<void>;
  readonly logInfo?: (message: string) => void;
  readonly logError?: (message: string) => void;
}

export interface RunnerLoop {
  stop(): Promise<void>;
}

export async function startRunnerLoop(
  options: RunnerLoopOptions,
): Promise<RunnerLoop> {
  const { client, orchestrator, environmentRestorer } = options;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const logInfo = options.logInfo ?? ((message) => console.log(message));
  const logError = options.logError ?? ((message) => console.error(message));
  if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
    throw new Error("Heartbeat interval must be positive");
  }
  if (!Number.isFinite(shutdownGraceMs) || shutdownGraceMs < 0) {
    throw new Error("Shutdown grace period must not be negative");
  }

  let stopped = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatPromise: Promise<void> | null = null;
  let pendingCommand: RecoveryCommandSnapshot | null | undefined;
  let drainPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let activeAbortController: AbortController | null = null;
  let criticalMutationCount = 0;
  let criticalMutationBoundary: Promise<void> | null = null;
  let resolveCriticalMutationBoundary: (() => void) | null = null;
  let restorationInProgress = false;
  let subscriptionsReady = false;
  let drainCommands: () => void = () => undefined;
  const completedEnvironmentRecoveries = new Set<string>();

  const activityObserver: RecoveryActivityObserver = {
    onCriticalMutationStart() {
      if (stopped) {
        throw new Error("Runner is stopping");
      }
      if (criticalMutationCount === 0) {
        criticalMutationBoundary = new Promise<void>((resolveBoundary) => {
          resolveCriticalMutationBoundary = resolveBoundary;
        });
      }
      criticalMutationCount += 1;
    },
    onCriticalMutationEnd() {
      if (criticalMutationCount === 0) {
        return;
      }
      criticalMutationCount -= 1;
      if (criticalMutationCount === 0) {
        resolveCriticalMutationBoundary?.();
        resolveCriticalMutationBoundary = null;
        criticalMutationBoundary = null;
      }
    },
  };

  const restoreEnvironment = async (
    request: EnvironmentRecoveryRequest,
  ): Promise<EnvironmentRestorationResult> => {
    if (completedEnvironmentRecoveries.has(request.incidentId)) {
      return { status: "ignored", incidentId: request.incidentId };
    }
    if (!environmentRestorer) {
      throw new Error("Environment restoration is not configured");
    }

    restorationInProgress = true;
    pendingCommand = undefined;
    activeAbortController?.abort();
    if (drainPromise) {
      await drainPromise;
    }

    activityObserver.onCriticalMutationStart();
    try {
      const result = await environmentRestorer.restoreDemoEnvironment(request);
      if (result.status === "restored" || result.status === "ignored") {
        completedEnvironmentRecoveries.add(request.incidentId);
      } else {
        logError(
          "Demo environment restoration did not verify healthy; cleanup remains pending.",
        );
      }
      return result;
    } finally {
      activityObserver.onCriticalMutationEnd();
      restorationInProgress = false;
      if (!stopped && subscriptionsReady && pendingCommand !== undefined) {
        drainCommands();
      }
    }
  };

  const handleHeartbeat = async (result: HeartbeatResult) => {
    if (!result.environmentRecovery) {
      return null;
    }
    return await restoreEnvironment(result.environmentRecovery);
  };

  try {
    const initialHeartbeat = await client.heartbeat();
    const initialRestoration = await handleHeartbeat(initialHeartbeat);
    if (initialRestoration?.status !== "failed") {
      await options.verifyStartupReady?.();
    }
  } catch (error) {
    try {
      await client.close();
    } catch {
      // Preserve the original connection or readiness error.
    }
    throw error;
  }

  const scheduleHeartbeat = () => {
    if (stopped || heartbeatTimer) {
      return;
    }
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      heartbeatPromise = client
        .heartbeat()
        .then(handleHeartbeat)
        .then(() => undefined)
        .catch(() => {
          logError(
            "Runner heartbeat failed; Convex will retry the connection automatically.",
          );
        })
        .finally(() => {
          heartbeatPromise = null;
          scheduleHeartbeat();
        });
    }, heartbeatIntervalMs);
  };

  drainCommands = () => {
    if (stopped || restorationInProgress || drainPromise) {
      return;
    }
    const draining = (async () => {
      while (
        !stopped &&
        !restorationInProgress &&
        pendingCommand !== undefined
      ) {
        const command = pendingCommand;
        pendingCommand = undefined;
        if (!command) {
          continue;
        }
        const abortController = new AbortController();
        activeAbortController = abortController;
        try {
          const result = await orchestrator.run(
            command,
            abortController.signal,
            activityObserver,
          );
          logInfo(`Recovery run finished with status: ${result.status}.`);
        } catch {
          logError(
            "Recovery run stopped safely because the runner hit an unexpected error.",
          );
        } finally {
          if (activeAbortController === abortController) {
            activeAbortController = null;
          }
        }
      }
    })();
    drainPromise = draining;
    void draining.finally(() => {
      if (drainPromise === draining) {
        drainPromise = null;
      }
      if (!stopped && pendingCommand !== undefined) {
        drainCommands();
      }
    });
  };

  let unsubscribeCommand: () => void = () => undefined;
  let unsubscribeConnection: () => void = () => undefined;
  const unsubscribeSafely = () => {
    for (const unsubscribe of [unsubscribeCommand, unsubscribeConnection]) {
      try {
        unsubscribe();
      } catch {
        logError("Runner subscription cleanup encountered an error.");
      }
    }
  };
  try {
    unsubscribeCommand = client.subscribeToActiveCommand(
      (command) => {
        if (stopped) {
          return;
        }
        pendingCommand = command;
        if (subscriptionsReady && !restorationInProgress) {
          drainCommands();
        }
      },
      () => {
        logError(
          "Runner lost its live command feed; Convex will reconnect automatically.",
        );
      },
    );

    let wasConnected = client.connectionState().isWebSocketConnected;
    unsubscribeConnection = client.subscribeToConnectionState((state) => {
      if (state.isWebSocketConnected === wasConnected) {
        return;
      }
      wasConnected = state.isWebSocketConnected;
      logInfo(
        wasConnected
          ? "Runner reconnected to Convex."
          : "Runner connection paused; Convex is reconnecting.",
      );
    });

    subscriptionsReady = true;
    if (pendingCommand !== undefined) {
      drainCommands();
    }
    scheduleHeartbeat();
  } catch (error) {
    stopped = true;
    pendingCommand = undefined;
    unsubscribeSafely();
    try {
      await client.close();
    } catch {
      // Preserve the original startup error.
    }
    throw error;
  }

  return {
    stop() {
      if (stopPromise) {
        return stopPromise;
      }
      stopped = true;
      pendingCommand = undefined;
      activeAbortController?.abort();
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      unsubscribeSafely();
      stopPromise = (async () => {
        const activeCriticalMutation = criticalMutationBoundary;
        const pending = [heartbeatPromise, drainPromise].filter(
          (promise): promise is Promise<void> => promise !== null,
        );
        const waitForNetworkGrace = async () => {
          if (pending.length > 0 && shutdownGraceMs > 0) {
            let graceTimer: ReturnType<typeof setTimeout> | null = null;
            await Promise.race([
              Promise.allSettled(pending).then(() => undefined),
              new Promise<void>((resolveGrace) => {
                graceTimer = setTimeout(resolveGrace, shutdownGraceMs);
              }),
            ]);
            if (graceTimer) {
              clearTimeout(graceTimer);
            }
          }
        };
        await Promise.allSettled(
          [waitForNetworkGrace(), activeCriticalMutation].filter(
            (promise): promise is Promise<void> => promise !== null,
          ),
        );
        await client.close();
      })();
      return stopPromise;
    },
  };
}

export async function verifyIdleDemoWorkloadReady(
  client: Pick<ConvexRunnerClient, "getActiveCommand">,
  workload: Pick<DemoWorkloadPort, "inspectSafeState" | "checkHealthOnce">,
  now: () => number = Date.now,
) {
  const activeCommand = await client.getActiveCommand();
  const safeState = await workload.inspectSafeState();
  const hasFreshResumableLease = Boolean(
    activeCommand &&
    activeCommand.status !== "queued" &&
    activeCommand.leaseExpiresAt !== null &&
    activeCommand.leaseExpiresAt >= now(),
  );
  if (hasFreshResumableLease) {
    return { status: "resuming_active_command" as const };
  }

  if (
    safeState.demoLabel !== DEMO_LABEL_VALUE ||
    safeState.status !== "running"
  ) {
    throw new Error("The fixed disposable demo service is not running");
  }

  const health = await workload.checkHealthOnce();
  if (
    !health.healthy ||
    health.httpStatus !== 200 ||
    health.service !== DEMO_SERVICE_IDENTITY ||
    health.status !== DEMO_HEALTHY_STATUS
  ) {
    throw new Error("The fixed disposable demo service is not healthy");
  }

  return { status: "idle_workload_ready" as const };
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: "CONVEX_URL" | "RUNNER_TOKEN" | "RUNNER_ID",
) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function startLocalRunner() {
  loadEnvironment({
    path: [resolve(".env.runner.local"), resolve(".env.local")],
    quiet: true,
  });

  const convexUrl = requiredEnvironment(process.env, "CONVEX_URL");
  const runnerToken = requiredEnvironment(process.env, "RUNNER_TOKEN");
  const runnerId = requiredEnvironment(process.env, "RUNNER_ID");
  if (runnerId !== DEMO_RUNNER_ID) {
    throw new Error("RUNNER_ID does not match the fixed demo runner");
  }

  const workload = new DockerAdapter();
  const client = createConvexRunnerClient({
    convexUrl,
    runnerToken,
    runnerId,
  });
  const environmentRestorer = createEnvironmentRestorer({
    client,
    workload,
  });
  const orchestrator = createRecoveryOrchestrator({
    state: client,
    workload,
    investigator: createCodexInvestigator(),
  });
  const runtime = await startRunnerLoop({
    client,
    orchestrator,
    environmentRestorer,
    verifyStartupReady: async () => {
      await verifyIdleDemoWorkloadReady(client, workload);
    },
  });
  console.log("Autonomous recovery runner is connected and watching.");

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void runtime
      .stop()
      .then(() => {
        console.log("Autonomous recovery runner stopped safely.");
      })
      .catch(() => {
        console.error("Runner shutdown encountered a connection error.");
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function isDirectExecution() {
  const entry = process.argv[1];
  return Boolean(
    entry && pathToFileURL(resolve(entry)).href === import.meta.url,
  );
}

if (isDirectExecution()) {
  void startLocalRunner().catch(() => {
    console.error(
      "Runner could not start. Check Docker, Convex, and the runner settings.",
    );
    process.exitCode = 1;
  });
}
