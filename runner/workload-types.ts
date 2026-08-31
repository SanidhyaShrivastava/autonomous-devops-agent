export const LEGACY_DOCKER_RECOVERY_LABEL =
  "docker start fixed demo service" as const;
export const LINUX_AGENT_RECOVERY_LABEL =
  "linux agent restart fixed demo service" as const;

export type RecoveryCommandLabel =
  | typeof LEGACY_DOCKER_RECOVERY_LABEL
  | typeof LINUX_AGENT_RECOVERY_LABEL;

export interface SafeWorkloadState {
  readonly status: string;
  readonly exitCode: number;
  readonly oomKilled: boolean;
  readonly finishedAt: string;
  readonly demoLabel: "autonomous-devops-agent";
}

export interface SafeLogTail {
  readonly lines: readonly string[];
  readonly lineCount: number;
  readonly characterCount: number;
  readonly truncated: boolean;
}

export interface RecoveryActionResult {
  readonly actionId: "restart_demo_service";
  readonly commandLabel: RecoveryCommandLabel;
  readonly exitCode: 0;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
}

export interface HealthEvidence {
  readonly healthy: boolean;
  readonly httpStatus: number | null;
  readonly service: string | null;
  readonly status: string | null;
  readonly requestStartedAt: number;
  readonly checkedAt: number;
  readonly attempts: number;
}
