import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serverMock = vi.hoisted(() => ({
  pairRunner: vi.fn(),
  recordRunnerHeartbeat: vi.fn(),
}));

vi.mock("@/lib/server/runner-enrollment", () => ({
  pairRunner: serverMock.pairRunner,
  recordRunnerHeartbeat: serverMock.recordRunnerHeartbeat,
}));
vi.mock("server-only", () => ({}));

import { POST as pair } from "@/app/api/runners/pair/route";
import { POST as heartbeat } from "@/app/api/runners/heartbeat/route";

const APP_ORIGIN = "https://autonomous-devops-agent.vercel.app";
const PAIRING_CODE = `gxpair_${"a".repeat(43)}`;
const RUNNER_CREDENTIAL = `gxrun_${"b".repeat(43)}`;
const RUNNER_ID = "gxr_abcdefghijklmnopqrstuvwx";
const CAPABILITY_ID = "fixed_disposable_service_v1";
const WORKLOAD_ID = "connected-demo-service";
const HEALTH_CHECK_ID = "check-connected-demo-service-health";
const ACTION_ID = "restart-connected-demo-service";
const COMMAND_ID = "command_123";
const EXECUTION_NONCE = "execution_nonce_123";

function jsonRequest(path: string, body: unknown, headers?: HeadersInit) {
  return new Request(`${APP_ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("runner enrollment routes", () => {
  beforeEach(() => {
    vi.stubEnv("RUNNER_PAIRING_REQUEST_SECRET", "test-route-secret");
    vi.stubEnv("VERCEL", "1");
    serverMock.pairRunner.mockReset();
    serverMock.recordRunnerHeartbeat.mockReset();
    serverMock.pairRunner.mockImplementation(
      async (args: { runnerId: string }) => ({
        label: "staging-web-1",
        runnerId: args.runnerId,
        status: "paired",
      }),
    );
    serverMock.recordRunnerHeartbeat.mockResolvedValue({
      status: "accepted",
      heartbeatIntervalMs: 2_000,
      workloadRegistered: false,
      command: null,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("pairs from strict JSON and returns a new credential exactly once", async () => {
    const response = await pair(
      jsonRequest("/api/runners/pair", {
        agentVersion: "0.1.0",
        architecture: "arm64",
        pairingCode: PAIRING_CODE,
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.runnerId).toMatch(/^gxr_[A-Za-z0-9_-]{24}$/);
    expect(body.credential).toMatch(/^gxrun_[A-Za-z0-9_-]{43}$/);
    expect(body.heartbeatIntervalMs).toBe(2_000);

    const call = serverMock.pairRunner.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(call.clientAddressDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(call.codeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(call.credentialDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(call).not.toHaveProperty("pairingCode");
    expect(JSON.stringify(call)).not.toContain(PAIRING_CODE);
    expect(JSON.stringify(body)).not.toContain(PAIRING_CODE);
  });

  it.each([
    ["missing content type", new Request(`${APP_ORIGIN}/api/runners/pair`, { method: "POST", body: "{}" }), 415],
    [
      "JSON lookalike content type",
      new Request(`${APP_ORIGIN}/api/runners/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/jsonp" },
        body: JSON.stringify({
          agentVersion: "0.1.0",
          architecture: "arm64",
          pairingCode: PAIRING_CODE,
        }),
      }),
      415,
    ],
    [
      "unknown field",
      jsonRequest("/api/runners/pair", {
        agentVersion: "0.1.0",
        architecture: "arm64",
        pairingCode: PAIRING_CODE,
        command: "whoami",
      }),
      400,
    ],
    [
      "malformed code",
      jsonRequest("/api/runners/pair", {
        agentVersion: "0.1.0",
        architecture: "arm64",
        pairingCode: "short",
      }),
      400,
    ],
    [
      "oversized body",
      jsonRequest("/api/runners/pair", {
        agentVersion: "0.1.0",
        architecture: "arm64",
        pairingCode: PAIRING_CODE,
        padding: "x".repeat(4_096),
      }),
      413,
    ],
  ])("rejects %s before contacting Convex", async (_label, request, status) => {
    const response = await pair(request);

    expect(response.status).toBe(status);
    expect(serverMock.pairRunner).not.toHaveBeenCalled();
  });

  it("cancels a streamed request as soon as its real bytes exceed the cap", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(3_000)));
        controller.enqueue(new TextEncoder().encode("x".repeat(3_000)));
      },
      cancel,
    });
    const request = new Request(`${APP_ORIGIN}/api/runners/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await pair(request);

    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(serverMock.pairRunner).not.toHaveBeenCalled();
  });

  it("uses Vercel's trusted address header instead of a caller's forwarded value", async () => {
    const body = {
      agentVersion: "0.1.0",
      architecture: "arm64",
      pairingCode: PAIRING_CODE,
    };
    await pair(
      jsonRequest("/api/runners/pair", body, {
        "x-forwarded-for": "198.51.100.10",
        "x-vercel-forwarded-for": "203.0.113.55",
      }),
    );
    await pair(
      jsonRequest("/api/runners/pair", body, {
        "x-forwarded-for": "198.51.100.11",
        "x-vercel-forwarded-for": "203.0.113.55",
      }),
    );

    const first = serverMock.pairRunner.mock.calls[0]?.[0];
    const second = serverMock.pairRunner.mock.calls[1]?.[0];
    expect(first.clientAddressDigest).toBe(second.clientAddressDigest);
    expect(JSON.stringify(first)).not.toContain("203.0.113.55");
    expect(JSON.stringify(first)).not.toContain("198.51.100.10");
  });

  it("does not trust forwarded address headers outside Vercel", async () => {
    vi.stubEnv("VERCEL", "0");
    const body = {
      agentVersion: "0.1.0",
      architecture: "arm64",
      pairingCode: PAIRING_CODE,
    };
    await pair(
      jsonRequest("/api/runners/pair", body, {
        "x-forwarded-for": "198.51.100.10",
      }),
    );
    await pair(
      jsonRequest("/api/runners/pair", body, {
        "x-forwarded-for": "198.51.100.11",
      }),
    );

    expect(serverMock.pairRunner.mock.calls[0]?.[0].clientAddressDigest).toBe(
      serverMock.pairRunner.mock.calls[1]?.[0].clientAddressDigest,
    );
  });

  it("returns the shared backend rate-limit decision", async () => {
    serverMock.pairRunner.mockResolvedValue({
      retryAfterSeconds: 42,
      status: "rate_limited",
    });

    const response = await pair(
      jsonRequest("/api/runners/pair", {
        agentVersion: "0.1.0",
        architecture: "arm64",
        pairingCode: PAIRING_CODE,
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
  });

  it("uses one generic response for an unknown, expired, or reused code", async () => {
    serverMock.pairRunner.mockResolvedValue({ status: "unavailable" });

    const response = await pair(
      jsonRequest("/api/runners/pair", {
        agentVersion: "0.1.0",
        architecture: "x64",
        pairingCode: PAIRING_CODE,
      }),
    );
    const text = await response.text();

    expect(response.status).toBe(401);
    expect(text).toContain("Pairing failed");
    expect(text).not.toContain(PAIRING_CODE);
    expect(text).not.toMatch(/expired|reused|unknown/i);
  });

  it("keeps the legacy heartbeat body compatible and returns a bounded command envelope", async () => {
    const response = await heartbeat(
      jsonRequest(
        "/api/runners/heartbeat",
        { agentVersion: "0.1.0", runnerId: RUNNER_ID },
        { Authorization: `Bearer ${RUNNER_CREDENTIAL}` },
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toEqual({
      heartbeatIntervalMs: 2_000,
      workloadRegistered: false,
      command: null,
    });
    const call = serverMock.recordRunnerHeartbeat.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(call.clientAddressDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(call.credentialDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(call).not.toHaveProperty("credential");
    expect(JSON.stringify(call)).not.toContain(RUNNER_CREDENTIAL);
  });

  it("passes only the exact fixed capability and healthy workload report", async () => {
    const response = await heartbeat(
      jsonRequest(
        "/api/runners/heartbeat",
        {
          agentVersion: "0.2.0",
          runnerId: RUNNER_ID,
          capabilityId: CAPABILITY_ID,
          healthReport: {
            workloadId: WORKLOAD_ID,
            healthCheckId: HEALTH_CHECK_ID,
            healthStatus: "healthy",
            detailCode: "exact_http_200",
            instanceId: "service_instance_1",
          },
        },
        { Authorization: `Bearer ${RUNNER_CREDENTIAL}` },
      ),
    );

    expect(response.status).toBe(200);
    expect(serverMock.recordRunnerHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentVersion: "0.2.0",
        runnerId: RUNNER_ID,
        capabilityId: CAPABILITY_ID,
        healthReport: {
          workloadId: WORKLOAD_ID,
          healthCheckId: HEALTH_CHECK_ID,
          healthStatus: "healthy",
          detailCode: "exact_http_200",
          instanceId: "service_instance_1",
        },
      }),
    );
  });

  it("accepts the exact unhealthy report without an instance ID", async () => {
    const response = await heartbeat(
      jsonRequest(
        "/api/runners/heartbeat",
        {
          agentVersion: "0.2.0",
          runnerId: RUNNER_ID,
          capabilityId: CAPABILITY_ID,
          healthReport: {
            workloadId: WORKLOAD_ID,
            healthCheckId: HEALTH_CHECK_ID,
            healthStatus: "unhealthy",
            detailCode: "connection_failed",
          },
        },
        { Authorization: `Bearer ${RUNNER_CREDENTIAL}` },
      ),
    );

    expect(response.status).toBe(200);
    expect(serverMock.recordRunnerHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        healthReport: expect.objectContaining({
          healthStatus: "unhealthy",
          detailCode: "connection_failed",
        }),
      }),
    );
  });

  it("passes an exact prior command result bound to its execution nonce", async () => {
    const previousCommandResult = {
      commandId: COMMAND_ID,
      executionNonce: EXECUTION_NONCE,
      actionId: ACTION_ID,
      executionResultCode: "restart_succeeded",
      verificationStatus: "healthy",
      verificationDetailCode: "exact_http_200",
      postActionInstanceId: "service_instance_2",
    };
    const response = await heartbeat(
      jsonRequest(
        "/api/runners/heartbeat",
        {
          agentVersion: "0.2.0",
          runnerId: RUNNER_ID,
          capabilityId: CAPABILITY_ID,
          previousCommandResult,
        },
        { Authorization: `Bearer ${RUNNER_CREDENTIAL}` },
      ),
    );

    expect(response.status).toBe(200);
    expect(serverMock.recordRunnerHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ previousCommandResult }),
    );
  });

  it("accepts the largest request allowed by the heartbeat protocol", async () => {
    const body = {
      agentVersion: "v".repeat(32),
      runnerId: RUNNER_ID,
      capabilityId: CAPABILITY_ID,
      healthReport: {
        workloadId: WORKLOAD_ID,
        healthCheckId: HEALTH_CHECK_ID,
        healthStatus: "healthy",
        detailCode: "exact_http_200",
        instanceId: "h".repeat(128),
      },
      previousCommandResult: {
        commandId: "c".repeat(128),
        executionNonce: "n".repeat(128),
        actionId: ACTION_ID,
        executionResultCode: "restart_succeeded",
        verificationStatus: "healthy",
        verificationDetailCode: "exact_http_200",
        postActionInstanceId: "p".repeat(128),
      },
    };

    expect(JSON.stringify(body).length).toBeGreaterThan(1_024);

    const response = await heartbeat(
      jsonRequest("/api/runners/heartbeat", body, {
        Authorization: `Bearer ${RUNNER_CREDENTIAL}`,
      }),
    );

    expect(response.status).toBe(200);
    expect(serverMock.recordRunnerHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining(body),
    );
  });

  it("returns only the fixed bounded command response", async () => {
    serverMock.recordRunnerHeartbeat.mockResolvedValue({
      status: "accepted",
      heartbeatIntervalMs: 2_000,
      workloadRegistered: true,
      command: {
        commandId: COMMAND_ID,
        executionNonce: EXECUTION_NONCE,
        workloadId: WORKLOAD_ID,
        actionId: ACTION_ID,
      },
    });

    const response = await heartbeat(
      jsonRequest(
        "/api/runners/heartbeat",
        { agentVersion: "0.2.0", runnerId: RUNNER_ID },
        { Authorization: `Bearer ${RUNNER_CREDENTIAL}` },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      heartbeatIntervalMs: 2_000,
      workloadRegistered: true,
      command: {
        commandId: COMMAND_ID,
        executionNonce: EXECUTION_NONCE,
        workloadId: WORKLOAD_ID,
        actionId: ACTION_ID,
      },
    });
  });

  it.each([
    [
      "unknown root field",
      {
        agentVersion: "0.2.0",
        runnerId: RUNNER_ID,
        command: "restart-connected-demo-service",
      },
    ],
    [
      "caller-supplied health URL",
      {
        agentVersion: "0.2.0",
        runnerId: RUNNER_ID,
        capabilityId: CAPABILITY_ID,
        healthReport: {
          workloadId: WORKLOAD_ID,
          healthCheckId: HEALTH_CHECK_ID,
          healthStatus: "healthy",
          detailCode: "exact_http_200",
          instanceId: "service_instance_1",
          url: "http://127.0.0.1:3001/health",
        },
      },
    ],
    [
      "caller-supplied local path",
      {
        agentVersion: "0.2.0",
        runnerId: RUNNER_ID,
        capabilityId: CAPABILITY_ID,
        path: "/tmp/service.mjs",
      },
    ],
    [
      "healthy report without an instance ID",
      {
        agentVersion: "0.2.0",
        runnerId: RUNNER_ID,
        capabilityId: CAPABILITY_ID,
        healthReport: {
          workloadId: WORKLOAD_ID,
          healthCheckId: HEALTH_CHECK_ID,
          healthStatus: "healthy",
          detailCode: "exact_http_200",
        },
      },
    ],
    [
      "unhealthy report with healthy evidence",
      {
        agentVersion: "0.2.0",
        runnerId: RUNNER_ID,
        capabilityId: CAPABILITY_ID,
        healthReport: {
          workloadId: WORKLOAD_ID,
          healthCheckId: HEALTH_CHECK_ID,
          healthStatus: "unhealthy",
          detailCode: "exact_http_200",
        },
      },
    ],
    [
      "malformed command ID",
      {
        agentVersion: "0.2.0",
        runnerId: RUNNER_ID,
        previousCommandResult: {
          commandId: "bad command id",
          executionNonce: EXECUTION_NONCE,
          actionId: ACTION_ID,
          executionResultCode: "restart_failed",
          verificationStatus: "unhealthy",
          verificationDetailCode: "request_timeout",
        },
      },
    ],
    [
      "malformed execution nonce",
      {
        agentVersion: "0.2.0",
        runnerId: RUNNER_ID,
        previousCommandResult: {
          commandId: COMMAND_ID,
          executionNonce: "nonce with spaces",
          actionId: ACTION_ID,
          executionResultCode: "restart_failed",
          verificationStatus: "unhealthy",
          verificationDetailCode: "request_timeout",
        },
      },
    ],
  ])("rejects %s before contacting Convex", async (_label, body) => {
    const response = await heartbeat(
      jsonRequest("/api/runners/heartbeat", body, {
        Authorization: `Bearer ${RUNNER_CREDENTIAL}`,
      }),
    );

    expect(response.status).toBe(400);
    expect(serverMock.recordRunnerHeartbeat).not.toHaveBeenCalled();
  });

  it("rejects an oversized heartbeat body before contacting Convex", async () => {
    const response = await heartbeat(
      jsonRequest(
        "/api/runners/heartbeat",
        {
          agentVersion: "0.2.0",
          runnerId: RUNNER_ID,
          padding: "x".repeat(4_096),
        },
        { Authorization: `Bearer ${RUNNER_CREDENTIAL}` },
      ),
    );

    expect(response.status).toBe(413);
    expect(serverMock.recordRunnerHeartbeat).not.toHaveBeenCalled();
  });

  it.each([
    [
      "missing content type",
      new Request(`${APP_ORIGIN}/api/runners/heartbeat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${RUNNER_CREDENTIAL}` },
        body: JSON.stringify({ agentVersion: "0.1.0", runnerId: RUNNER_ID }),
      }),
    ],
    [
      "JSON lookalike content type",
      new Request(`${APP_ORIGIN}/api/runners/heartbeat`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RUNNER_CREDENTIAL}`,
          "Content-Type": "application/jsonp",
        },
        body: JSON.stringify({ agentVersion: "0.1.0", runnerId: RUNNER_ID }),
      }),
    ],
  ])("rejects a heartbeat with %s", async (_label, request) => {
    const response = await heartbeat(request);

    expect(response.status).toBe(415);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(serverMock.recordRunnerHeartbeat).not.toHaveBeenCalled();
  });

  it("hashes Vercel's trusted client address for heartbeat requests", async () => {
    const body = { agentVersion: "0.1.0", runnerId: RUNNER_ID };
    await heartbeat(
      jsonRequest("/api/runners/heartbeat", body, {
        Authorization: `Bearer ${RUNNER_CREDENTIAL}`,
        "x-forwarded-for": "198.51.100.10",
        "x-vercel-forwarded-for": "203.0.113.55",
      }),
    );
    await heartbeat(
      jsonRequest("/api/runners/heartbeat", body, {
        Authorization: `Bearer ${RUNNER_CREDENTIAL}`,
        "x-forwarded-for": "198.51.100.11",
        "x-vercel-forwarded-for": "203.0.113.55",
      }),
    );

    const first = serverMock.recordRunnerHeartbeat.mock.calls[0]?.[0];
    const second = serverMock.recordRunnerHeartbeat.mock.calls[1]?.[0];
    expect(first.clientAddressDigest).toBe(second.clientAddressDigest);
    expect(JSON.stringify(first)).not.toContain("203.0.113.55");
    expect(JSON.stringify(first)).not.toContain("198.51.100.10");
  });

  it("rejects malformed command output from the backend without exposing it", async () => {
    serverMock.recordRunnerHeartbeat.mockResolvedValue({
      status: "accepted",
      heartbeatIntervalMs: 2_000,
      workloadRegistered: true,
      command: {
        commandId: COMMAND_ID,
        executionNonce: EXECUTION_NONCE,
        workloadId: WORKLOAD_ID,
        actionId: ACTION_ID,
        path: "/tmp/service.mjs",
      },
    });

    const response = await heartbeat(
      jsonRequest(
        "/api/runners/heartbeat",
        { agentVersion: "0.2.0", runnerId: RUNNER_ID },
        { Authorization: `Bearer ${RUNNER_CREDENTIAL}` },
      ),
    );
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(text).toContain("Heartbeat is temporarily unavailable");
    expect(text).not.toContain("/tmp/service.mjs");
  });

  it("returns one generic no-store error when the backend fails", async () => {
    serverMock.recordRunnerHeartbeat.mockRejectedValue(
      new Error(`backend failed for ${RUNNER_CREDENTIAL}`),
    );

    const response = await heartbeat(
      jsonRequest(
        "/api/runners/heartbeat",
        { agentVersion: "0.1.0", runnerId: RUNNER_ID },
        { Authorization: `Bearer ${RUNNER_CREDENTIAL}` },
      ),
    );
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(text).toContain("Heartbeat is temporarily unavailable");
    expect(text).not.toContain(RUNNER_CREDENTIAL);
    expect(text).not.toContain("backend failed");
  });

  it.each([
    ["missing bearer", {}, 401],
    ["wrong bearer shape", { Authorization: "Basic value" }, 401],
  ])("rejects a %s without contacting Convex", async (_label, headers, status) => {
    const response = await heartbeat(
      jsonRequest(
        "/api/runners/heartbeat",
        { agentVersion: "0.1.0", runnerId: "gxr_abcdefghijklmnopqrstuvwx" },
        headers,
      ),
    );

    expect(response.status).toBe(status);
    expect(serverMock.recordRunnerHeartbeat).not.toHaveBeenCalled();
  });

  it("does not reveal whether a heartbeat runner or credential was wrong", async () => {
    serverMock.recordRunnerHeartbeat.mockResolvedValue({
      status: "unavailable",
    });

    const response = await heartbeat(
      jsonRequest(
        "/api/runners/heartbeat",
        { agentVersion: "0.1.0", runnerId: "gxr_abcdefghijklmnopqrstuvwx" },
        { Authorization: `Bearer ${RUNNER_CREDENTIAL}` },
      ),
    );
    const text = await response.text();

    expect(response.status).toBe(401);
    expect(text).toContain("Runner authentication failed");
    expect(text).not.toContain(RUNNER_CREDENTIAL);
    expect(text).not.toMatch(/credential|runner not found/i);
  });

  it("returns the shared heartbeat rate-limit decision", async () => {
    serverMock.recordRunnerHeartbeat.mockResolvedValue({
      retryAfterSeconds: 17,
      status: "rate_limited",
    });

    const response = await heartbeat(
      jsonRequest(
        "/api/runners/heartbeat",
        { agentVersion: "0.1.0", runnerId: "gxr_abcdefghijklmnopqrstuvwx" },
        { Authorization: `Bearer ${RUNNER_CREDENTIAL}` },
      ),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
  });
});
