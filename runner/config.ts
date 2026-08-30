export const DEMO_CONTAINER_NAME = "gx-autodevops-demo-service" as const;
export const DEMO_LABEL_KEY = "com.growthx.demo" as const;
export const DEMO_LABEL_VALUE = "autonomous-devops-agent" as const;
export const DEMO_IMAGE = "gx-autodevops-demo-service:m0" as const;
export const DEMO_WORKLOAD_ID = "demo-service" as const;
export const DEMO_ACTION_ID = "restart_demo_service" as const;
export const DEMO_HEALTH_URL = "http://127.0.0.1:3400/health" as const;
export const DEMO_EXPECTED_SERVICE = DEMO_CONTAINER_NAME;
export const DEMO_EXPECTED_STATUS = "healthy" as const;

export const DEMO_LOG_LINE_LIMIT = 30;
export const PUBLIC_OUTPUT_CHARACTER_LIMIT = 4_000;
export const PROCESS_MAX_BUFFER_BYTES = 16 * 1024;
export const PROCESS_TIMEOUT_MS = 10_000;

export type DemoWorkloadId = typeof DEMO_WORKLOAD_ID;
export type DemoActionId = typeof DEMO_ACTION_ID;

export const DEMO_RUNNER_CONFIG = Object.freeze({
  containerName: DEMO_CONTAINER_NAME,
  labelKey: DEMO_LABEL_KEY,
  labelValue: DEMO_LABEL_VALUE,
  image: DEMO_IMAGE,
  workloadId: DEMO_WORKLOAD_ID,
  actionId: DEMO_ACTION_ID,
  healthUrl: DEMO_HEALTH_URL,
  expectedService: DEMO_EXPECTED_SERVICE,
  expectedStatus: DEMO_EXPECTED_STATUS,
  logLineLimit: DEMO_LOG_LINE_LIMIT,
  publicOutputCharacterLimit: PUBLIC_OUTPUT_CHARACTER_LIMIT,
  processMaxBufferBytes: PROCESS_MAX_BUFFER_BYTES,
  processTimeoutMs: PROCESS_TIMEOUT_MS,
});
