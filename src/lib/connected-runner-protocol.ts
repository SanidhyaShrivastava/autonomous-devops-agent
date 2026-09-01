import { z } from "zod";

export const CONNECTED_RUNNER_CAPABILITY_ID =
  "fixed_disposable_service_v1" as const;
export const CONNECTED_WORKLOAD_ID = "connected-demo-service" as const;
export const CONNECTED_HEALTH_CHECK_ID =
  "check-connected-demo-service-health" as const;
export const CONNECTED_RECOVERY_ACTION_ID =
  "restart-connected-demo-service" as const;
export const CONNECTED_SERVICE_HEALTH_URL =
  "http://127.0.0.1:3001/health" as const;
export const HOST_AGENT_VERSION = "0.2.0" as const;
export const CONNECTED_HEARTBEAT_INTERVAL_MS = 2_000 as const;

export const connectedHealthDetailCodeSchema = z.enum([
  "exact_http_200",
  "connection_failed",
  "request_timeout",
  "unexpected_response",
]);

export const connectedHealthReportSchema = z
  .object({
    workloadId: z.literal(CONNECTED_WORKLOAD_ID),
    healthCheckId: z.literal(CONNECTED_HEALTH_CHECK_ID),
    healthStatus: z.enum(["healthy", "unhealthy"]),
    detailCode: connectedHealthDetailCodeSchema,
    instanceId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict()
  .superRefine((report, context) => {
    const exactHealthy =
      report.healthStatus === "healthy" &&
      report.detailCode === "exact_http_200" &&
      report.instanceId !== undefined;
    const exactUnhealthy =
      report.healthStatus === "unhealthy" &&
      report.detailCode !== "exact_http_200" &&
      report.instanceId === undefined;
    if (!exactHealthy && !exactUnhealthy) {
      context.addIssue({
        code: "custom",
        message: "Health status and detail code do not agree",
      });
    }
  });

const commandIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const connectedRecoveryCommandSchema = z
  .object({
    commandId: commandIdSchema,
    executionNonce: commandIdSchema,
    workloadId: z.literal(CONNECTED_WORKLOAD_ID),
    actionId: z.literal(CONNECTED_RECOVERY_ACTION_ID),
  })
  .strict();

export const connectedCommandResultSchema = z
  .object({
    commandId: commandIdSchema,
    executionNonce: commandIdSchema,
    actionId: z.literal(CONNECTED_RECOVERY_ACTION_ID),
    executionResultCode: z.enum(["restart_succeeded", "restart_failed"]),
    verificationStatus: z.enum(["healthy", "unhealthy"]),
    verificationDetailCode: connectedHealthDetailCodeSchema,
    postActionInstanceId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict()
  .superRefine((result, context) => {
    const exactHealthy =
      result.verificationStatus === "healthy" &&
      result.verificationDetailCode === "exact_http_200" &&
      result.postActionInstanceId !== undefined;
    const exactUnhealthy =
      result.verificationStatus === "unhealthy" &&
      result.verificationDetailCode !== "exact_http_200" &&
      result.postActionInstanceId === undefined;
    if (!exactHealthy && !exactUnhealthy) {
      context.addIssue({
        code: "custom",
        message: "Verification status and detail code do not agree",
      });
    }
  });

export const connectedRunnerHeartbeatRequestSchema = z
  .object({
    runnerId: z.string().regex(/^gxr_[A-Za-z0-9_-]{24}$/),
    agentVersion: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/),
    capabilityId: z.literal(CONNECTED_RUNNER_CAPABILITY_ID).optional(),
    healthReport: connectedHealthReportSchema.optional(),
    previousCommandResult: connectedCommandResultSchema.optional(),
  })
  .strict();

export const connectedRunnerHeartbeatResponseSchema = z
  .object({
    heartbeatIntervalMs: z.literal(CONNECTED_HEARTBEAT_INTERVAL_MS),
    workloadRegistered: z.boolean(),
    command: connectedRecoveryCommandSchema.nullable(),
  })
  .strict();

export type ConnectedHealthReport = z.infer<
  typeof connectedHealthReportSchema
>;
export type ConnectedRecoveryCommand = z.infer<
  typeof connectedRecoveryCommandSchema
>;
export type ConnectedCommandResult = z.infer<
  typeof connectedCommandResultSchema
>;
