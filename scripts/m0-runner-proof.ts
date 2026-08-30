import { DockerAdapter } from "../runner/docker-adapter";
import {
  DEMO_ACTION_ID,
  DEMO_CONTAINER_NAME,
  DEMO_LABEL_KEY,
  DEMO_LABEL_VALUE,
  DEMO_WORKLOAD_ID,
} from "../runner/config";

async function main(): Promise<void> {
  const adapter = new DockerAdapter();
  const initialState = await adapter.ensureDemoService();
  const initialHealth = await adapter.verifyFreshHealth(0);
  if (!initialHealth.healthy) {
    throw new Error("Disposable demo service did not become healthy during setup");
  }

  let unknownActionRejected = false;
  try {
    await adapter.executeRecoveryAction({
      actionId: "unknown_action",
      workloadId: DEMO_WORKLOAD_ID,
      executionId: "m0-unknown-action",
    });
  } catch {
    unknownActionRejected = true;
  }
  if (!unknownActionRejected) {
    throw new Error("Unknown recovery action was not rejected");
  }

  await adapter.stopDemoService();
  const failedHealth = await adapter.checkHealthOnce();
  if (failedHealth.healthy) {
    throw new Error("Seeded stop did not produce a failed health check");
  }

  const failedState = await adapter.inspectSafeState();
  const logs = await adapter.readSafeLogTail();
  const executionId = `m0-proof-${Date.now()}`;
  const action = await adapter.executeRecoveryAction({
    actionId: DEMO_ACTION_ID,
    workloadId: DEMO_WORKLOAD_ID,
    executionId,
  });

  let duplicateActionRejected = false;
  try {
    await adapter.executeRecoveryAction({
      actionId: DEMO_ACTION_ID,
      workloadId: DEMO_WORKLOAD_ID,
      executionId,
    });
  } catch {
    duplicateActionRejected = true;
  }
  if (!duplicateActionRejected) {
    throw new Error("Duplicate recovery action was not rejected");
  }

  const verification = await adapter.verifyFreshHealth(action.finishedAt);
  if (!verification.healthy) {
    throw new Error("Fresh health verification failed after the fixed restart");
  }

  const recoveredState = await adapter.inspectSafeState();

  console.log(
    JSON.stringify(
      {
        surface: "controlled_staged",
        container: DEMO_CONTAINER_NAME,
        label: `${DEMO_LABEL_KEY}=${DEMO_LABEL_VALUE}`,
        initial: {
          status: initialState.status,
          health: initialHealth.healthy,
        },
        safety: {
          unknownActionRejected,
          duplicateActionRejected,
          arbitraryShellAccess: false,
        },
        failure: {
          health: failedHealth.healthy,
          safeState: failedState,
          logLineCount: logs.lineCount,
          logCharacterCount: logs.characterCount,
          logOutputTruncated: logs.truncated,
        },
        recovery: {
          actionId: action.actionId,
          commandLabel: action.commandLabel,
          exitCode: action.exitCode,
          startedAt: action.startedAt,
          finishedAt: action.finishedAt,
        },
        verification: {
          requestStartedAt: verification.requestStartedAt,
          checkedAt: verification.checkedAt,
          fresh: verification.requestStartedAt >= action.finishedAt,
          httpStatus: verification.httpStatus,
          service: verification.service,
          status: verification.status,
          healthy: verification.healthy,
          attempts: verification.attempts,
        },
        final: {
          status: recoveredState.status,
          health: verification.healthy,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "M0 runner proof failed");
  process.exitCode = 1;
});
