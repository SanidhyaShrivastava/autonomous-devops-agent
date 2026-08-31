import {
  DEMO_ACTION_ID,
  DEMO_WORKLOAD_ID,
} from "../runner/config";
import { SANDBOX_CONTAINER_NAME } from "../runner/sandbox-container";
import { startLinuxSandbox } from "./linux-sandbox-start";

async function main(): Promise<void> {
  const { adapter, health: initialHealth, state: initialState } =
    await startLinuxSandbox();
  let recoveryCompleted = false;

  try {
    let unknownActionRejected = false;
    try {
      await adapter.executeRecoveryAction({
        actionId: "unknown_action",
        workloadId: DEMO_WORKLOAD_ID,
        executionId: "sandbox-proof-unknown",
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
      throw new Error("The fixed stop did not produce failed health");
    }

    const failedState = await adapter.inspectSafeState();
    const logs = await adapter.readSafeLogTail();
    const executionId = `sandbox-proof-${Date.now()}`;
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
      throw new Error("Fresh health verification failed after recovery");
    }
    recoveryCompleted = true;

    console.log(
      JSON.stringify(
        {
          surface: "controlled_staged_linux_sandbox",
          container: SANDBOX_CONTAINER_NAME,
          initial: {
            status: initialState.status,
            healthy: initialHealth.healthy,
          },
          safety: {
            unknownActionRejected,
            duplicateActionRejected,
            arbitraryShellAccess: false,
            hostFilesystemAccess: false,
          },
          failure: {
            healthy: failedHealth.healthy,
            status: failedState.status,
            logLineCount: logs.lineCount,
            logCharacterCount: logs.characterCount,
            logOutputTruncated: logs.truncated,
          },
          recovery: {
            actionId: action.actionId,
            commandLabel: action.commandLabel,
            exitCode: action.exitCode,
            durationMs: action.durationMs,
          },
          verification: {
            fresh: verification.requestStartedAt >= action.finishedAt,
            httpStatus: verification.httpStatus,
            service: verification.service,
            status: verification.status,
            healthy: verification.healthy,
            attempts: verification.attempts,
          },
          final: { status: "running", healthy: verification.healthy },
        },
        null,
        2,
      ),
    );
  } finally {
    if (!recoveryCompleted) {
      try {
        await adapter.ensureDemoService();
        await adapter.verifyFreshHealth(0);
      } catch {
        console.error("The disposable Linux workload also needs local restoration.");
      }
    }
  }
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Linux sandbox proof failed",
  );
  process.exitCode = 1;
});
