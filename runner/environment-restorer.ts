import {
  DEMO_HEALTHY_STATUS,
  DEMO_SERVICE_IDENTITY,
} from "../src/lib/contracts";
import { DEMO_LABEL_VALUE } from "./config";
import type {
  HealthEvidence,
  SafeWorkloadState,
} from "./workload-types";

const SAFE_ENVIRONMENT_RECOVERY_FAILURE_SUMMARY =
  "The fixed demo environment could not be restored and verified healthy.";

export interface EnvironmentRecoveryRequest {
  readonly incidentId: string;
  readonly stateVersion: number;
}

export interface EnvironmentRecoveryClient {
  claimEnvironmentRecovery(input: {
    readonly incidentId: string;
    readonly expectedStateVersion: number;
  }): Promise<
    | { readonly status: "claimed"; readonly stateVersion: number }
    | { readonly status: "ignored"; readonly stateVersion: number }
  >;
  completeEnvironmentRecovery(input: {
    readonly incidentId: string;
    readonly expectedStateVersion: number;
    readonly verification: {
      readonly service: typeof DEMO_SERVICE_IDENTITY;
      readonly status: typeof DEMO_HEALTHY_STATUS;
      readonly httpStatus: 200;
      readonly requestStartedAt: number;
      readonly checkedAt: number;
    };
  }): Promise<{ readonly status: "restored"; readonly stateVersion: number }>;
  failEnvironmentRecovery(input: {
    readonly incidentId: string;
    readonly expectedStateVersion: number;
    readonly errorSummary: string;
  }): Promise<{ readonly status: "pending"; readonly stateVersion: number }>;
}

export interface EnvironmentRecoveryWorkload {
  ensureDemoService(): Promise<SafeWorkloadState>;
  verifyFreshHealth(notBefore: number): Promise<HealthEvidence>;
}

export type EnvironmentRestorationResult =
  | { readonly status: "restored"; readonly incidentId: string }
  | { readonly status: "failed"; readonly incidentId: string }
  | { readonly status: "ignored"; readonly incidentId: string };

export interface EnvironmentRestorer {
  restoreDemoEnvironment(
    request: EnvironmentRecoveryRequest,
  ): Promise<EnvironmentRestorationResult>;
}

export interface EnvironmentRestorerDependencies {
  readonly client: EnvironmentRecoveryClient;
  readonly workload: EnvironmentRecoveryWorkload;
  readonly now?: () => number;
}

function isExactHealthyDemo(evidence: HealthEvidence) {
  return (
    evidence.healthy &&
    evidence.httpStatus === 200 &&
    evidence.service === DEMO_SERVICE_IDENTITY &&
    evidence.status === DEMO_HEALTHY_STATUS
  );
}

export function createEnvironmentRestorer(
  dependencies: EnvironmentRestorerDependencies,
): EnvironmentRestorer {
  const { client, workload } = dependencies;
  const now = dependencies.now ?? Date.now;

  return {
    async restoreDemoEnvironment(request) {
      const claim = await client.claimEnvironmentRecovery({
        incidentId: request.incidentId,
        expectedStateVersion: request.stateVersion,
      });
      if (claim.status === "ignored") {
        return { status: "ignored", incidentId: request.incidentId };
      }

      const restorationStartedAt = now();
      try {
        const state = await workload.ensureDemoService();
        if (
          state.demoLabel !== DEMO_LABEL_VALUE ||
          state.status !== "running"
        ) {
          throw new Error("The fixed demo service was not restored");
        }

        const verification =
          await workload.verifyFreshHealth(restorationStartedAt);
        if (!isExactHealthyDemo(verification)) {
          throw new Error("The restored demo service did not verify healthy");
        }

        await client.completeEnvironmentRecovery({
          incidentId: request.incidentId,
          expectedStateVersion: claim.stateVersion,
          verification: {
            service: DEMO_SERVICE_IDENTITY,
            status: DEMO_HEALTHY_STATUS,
            httpStatus: 200,
            requestStartedAt: verification.requestStartedAt,
            checkedAt: verification.checkedAt,
          },
        });
        return { status: "restored", incidentId: request.incidentId };
      } catch {
        await client.failEnvironmentRecovery({
          incidentId: request.incidentId,
          expectedStateVersion: claim.stateVersion,
          errorSummary: SAFE_ENVIRONMENT_RECOVERY_FAILURE_SUMMARY,
        });
        return { status: "failed", incidentId: request.incidentId };
      }
    },
  };
}
