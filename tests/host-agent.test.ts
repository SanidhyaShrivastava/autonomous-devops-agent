import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadRunnerConfig,
  saveRunnerConfig,
  type RunnerConfig,
} from "../host-agent/config";
import { runHeartbeatLoop } from "../host-agent/connect";
import {
  checkFixedServiceHealth,
  createFixedServiceController,
  type FixedServiceController,
} from "../host-agent/fixed-service";
import { pairWithCode } from "../host-agent/pair";
import { seedStoppedServiceFailure } from "../host-agent/seed-failure";
import {
  CONNECTED_HEARTBEAT_INTERVAL_MS,
  CONNECTED_HEALTH_CHECK_ID,
  CONNECTED_RECOVERY_ACTION_ID,
  CONNECTED_RUNNER_CAPABILITY_ID,
  CONNECTED_WORKLOAD_ID,
  HOST_AGENT_VERSION,
  type ConnectedCommandResult,
  type ConnectedHealthReport,
  type ConnectedRecoveryCommand,
} from "../src/lib/connected-runner-protocol";

const CONFIG: RunnerConfig = {
  agentVersion: "0.1.0",
  baseUrl: "https://autonomous-devops-agent.vercel.app",
  credential: `gxrun_${"b".repeat(43)}`,
  runnerId: "gxr_abcdefghijklmnopqrstuvwx",
};

const HEALTHY_REPORT: ConnectedHealthReport = {
  workloadId: CONNECTED_WORKLOAD_ID,
  healthCheckId: CONNECTED_HEALTH_CHECK_ID,
  healthStatus: "healthy",
  detailCode: "exact_http_200",
  instanceId: "instance-before",
};

const COMMAND: ConnectedRecoveryCommand = {
  commandId: "command-1",
  executionNonce: "nonce-1",
  workloadId: CONNECTED_WORKLOAD_ID,
  actionId: CONNECTED_RECOVERY_ACTION_ID,
};

const RESULT: ConnectedCommandResult = {
  commandId: COMMAND.commandId,
  executionNonce: COMMAND.executionNonce,
  actionId: CONNECTED_RECOVERY_ACTION_ID,
  executionResultCode: "restart_succeeded",
  verificationStatus: "healthy",
  verificationDetailCode: "exact_http_200",
  postActionInstanceId: "instance-after",
};

function heartbeatResponse(command: ConnectedRecoveryCommand | null = null) {
  return new Response(
    JSON.stringify({
      heartbeatIntervalMs: CONNECTED_HEARTBEAT_INTERVAL_MS,
      workloadRegistered: true,
      command,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function fakeController(
  overrides: Partial<FixedServiceController> = {},
): FixedServiceController {
  return {
    checkHealth: vi.fn().mockResolvedValue(HEALTHY_REPORT),
    execute: vi.fn().mockResolvedValue(RESULT),
    markResultDelivered: vi.fn().mockResolvedValue(undefined),
    pendingResult: vi.fn().mockResolvedValue(null),
    stop: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function waitUntilHealthy(controller: FixedServiceController) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const health = await controller.checkHealth();
    if (health.healthStatus === "healthy") return health;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The fixed service did not become healthy");
}

describe.sequential("minimal Linux host agent", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("atomically stores only the scoped runner config with mode 0600", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gx-host-agent-"));
    const configPath = path.join(directory, "private", "runner.json");

    await saveRunnerConfig(configPath, CONFIG);

    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(CONFIG);
    await expect(loadRunnerConfig(configPath)).resolves.toEqual(CONFIG);
  });

  it("pairs as 0.2.0 without changing the saved pairing shape", async () => {
    const pairingCode = `gxpair_${"a".repeat(43)}`;
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          credential: CONFIG.credential,
          heartbeatIntervalMs: 2_000,
          runnerId: CONFIG.runnerId,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await pairWithCode({
      architecture: "arm64",
      baseUrl: CONFIG.baseUrl,
      pairingCode,
      request,
    });

    expect(request).toHaveBeenCalledWith(
      `${CONFIG.baseUrl}/api/runners/pair`,
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    const requestBody = JSON.parse(
      String((request.mock.calls[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(requestBody).toMatchObject({
      agentVersion: HOST_AGENT_VERSION,
      architecture: "arm64",
      pairingCode,
    });
    expect(result).toEqual({ ...CONFIG, agentVersion: HOST_AGENT_VERSION });
    expect(JSON.stringify(result)).not.toContain(pairingCode);
  });

  it("still loads a pairing file saved by the 0.1.0 agent", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gx-host-agent-"));
    const configPath = path.join(directory, "runner.json");
    await saveRunnerConfig(configPath, CONFIG);

    await expect(loadRunnerConfig(configPath)).resolves.toEqual(CONFIG);
  });

  it("rejects a saved credential that points to plain HTTP", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gx-host-agent-"));
    const configPath = path.join(directory, "runner.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ ...CONFIG, baseUrl: "http://example.com" }),
      { mode: 0o600 },
    );

    await expect(loadRunnerConfig(configPath)).rejects.toThrow(/HTTPS/i);
  });

  it("checks only the exact localhost health URL with a timeout and strict identity", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          service: CONNECTED_WORKLOAD_ID,
          status: "healthy",
          instanceId: "service-instance-1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(checkFixedServiceHealth({ request })).resolves.toEqual({
      ...HEALTHY_REPORT,
      instanceId: "service-instance-1",
    });
    expect(request).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/health",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );

    request.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          service: "lookalike-service",
          status: "healthy",
          instanceId: "service-instance-1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(checkFixedServiceHealth({ request })).resolves.toMatchObject({
      healthStatus: "unhealthy",
      detailCode: "unexpected_response",
    });

    request.mockRejectedValueOnce(new TypeError("connection refused"));
    await expect(checkFixedServiceHealth({ request })).resolves.toMatchObject({
      healthStatus: "unhealthy",
      detailCode: "connection_failed",
    });
  });

  it("aborts a health request after the fixed timeout", async () => {
    vi.useFakeTimers();
    const request = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      }),
    );

    const health = checkFixedServiceHealth({ request, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_001);

    await expect(health).resolves.toMatchObject({
      healthStatus: "unhealthy",
      detailCode: "request_timeout",
    });
  });

  it("starts healthy, seeds the one stopped-service failure locally, and restarts with a fresh identity", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gx-host-agent-"));
    const controller = createFixedServiceController({
      journalPath: path.join(directory, "executions.json"),
    });

    try {
      const before = await waitUntilHealthy(controller);
      expect(before.instanceId).toMatch(/^[A-Za-z0-9_-]+$/);

      await seedStoppedServiceFailure();
      await expect(controller.checkHealth()).resolves.toMatchObject({
        healthStatus: "unhealthy",
        detailCode: "connection_failed",
      });

      const result = await controller.execute(COMMAND);
      expect(result).toMatchObject({
        commandId: COMMAND.commandId,
        executionResultCode: "restart_succeeded",
        verificationStatus: "healthy",
        verificationDetailCode: "exact_http_200",
      });
      expect(result?.postActionInstanceId).not.toBe(before.instanceId);
    } finally {
      await controller.stop();
    }
  });

  it("rejects unknown actions and extra command fields", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gx-host-agent-"));
    const controller = createFixedServiceController({
      journalPath: path.join(directory, "executions.json"),
    });

    try {
      await expect(
        controller.execute({ ...COMMAND, actionId: "run-anything" }),
      ).rejects.toThrow();
      await expect(
        controller.execute({ ...COMMAND, command: "whoami" }),
      ).rejects.toThrow();
    } finally {
      await controller.stop();
    }
  });

  it("stores the claim and result, blocks replay, and uses mode 0600", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gx-host-agent-"));
    const journalPath = path.join(directory, "executions.json");
    const controller = createFixedServiceController({ journalPath });

    try {
      const before = await waitUntilHealthy(controller);
      await seedStoppedServiceFailure();
      const first = await controller.execute(COMMAND);
      const afterFirst = await controller.checkHealth();
      const second = await controller.execute(COMMAND);
      const afterSecond = await controller.checkHealth();
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
        entries: Array<Record<string, unknown>>;
      };

      expect(first).toEqual(second);
      expect(afterFirst.instanceId).not.toBe(before.instanceId);
      expect(afterSecond.instanceId).toBe(afterFirst.instanceId);
      expect(journal.entries).toHaveLength(1);
      expect(journal.entries[0]).toMatchObject({
        commandId: COMMAND.commandId,
        executionNonce: COMMAND.executionNonce,
        result: first,
      });
      expect((await stat(journalPath)).mode & 0o777).toBe(0o600);
    } finally {
      await controller.stop();
    }
  });

  it("durably stores the claim before restart verification can finish", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gx-host-agent-"));
    const journalPath = path.join(directory, "executions.json");
    let finishVerification: ((response: Response) => void) | undefined;
    const verification = new Promise<Response>((resolve) => {
      finishVerification = resolve;
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            service: CONNECTED_WORKLOAD_ID,
            status: "healthy",
            instanceId: "instance-before-durable-claim",
          }),
          { status: 200 },
        ),
      )
      .mockReturnValue(verification);
    const controller = createFixedServiceController({ journalPath, request });

    try {
      await controller.checkHealth();
      const execution = controller.execute({
        ...COMMAND,
        commandId: "durable-command",
        executionNonce: "durable-nonce",
      });
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

      const claimed = JSON.parse(await readFile(journalPath, "utf8")) as {
        entries: Array<Record<string, unknown>>;
      };
      expect(claimed.entries).toHaveLength(1);
      expect(claimed.entries[0]).toMatchObject({
        commandId: "durable-command",
        executionNonce: "durable-nonce",
      });
      expect(claimed.entries[0]).not.toHaveProperty("result");

      finishVerification?.(
        new Response(
          JSON.stringify({
            service: CONNECTED_WORKLOAD_ID,
            status: "healthy",
            instanceId: "instance-after-durable-claim",
          }),
          { status: 200 },
        ),
      );
      const result = await execution;
      const completed = JSON.parse(await readFile(journalPath, "utf8")) as {
        entries: Array<Record<string, unknown>>;
      };
      expect(completed.entries[0]).toMatchObject({ result });
    } finally {
      await controller.stop();
    }
  });

  it("reports failed verification separately from a successful process spawn", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gx-host-agent-"));
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            service: CONNECTED_WORKLOAD_ID,
            status: "healthy",
            instanceId: "instance-before-failed-verification",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValue(new Response(null, { status: 503 }));
    const controller = createFixedServiceController({
      journalPath: path.join(directory, "executions.json"),
      readinessRetryMs: 1,
      readinessTimeoutMs: 20,
      request,
    });

    try {
      await controller.checkHealth();
      await expect(
        controller.execute({
          ...COMMAND,
          commandId: "failed-verification-command",
          executionNonce: "failed-verification-nonce",
        }),
      ).resolves.toMatchObject({
        executionResultCode: "restart_succeeded",
        verificationStatus: "unhealthy",
        verificationDetailCode: "unexpected_response",
      });
    } finally {
      await controller.stop();
    }
  });

  it("resends a stored result after restart and caps the journal at 50 claims", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gx-host-agent-"));
    const journalPath = path.join(directory, "executions.json");
    const entries = Array.from({ length: 50 }, (_, index) => ({
      commandId: `old-command-${index}`,
      executionNonce: `old-nonce-${index}`,
      actionId: CONNECTED_RECOVERY_ACTION_ID,
      claimedAt: index + 1,
      result: {
        ...RESULT,
        commandId: `old-command-${index}`,
        executionNonce: `old-nonce-${index}`,
      },
    }));
    await writeFile(journalPath, JSON.stringify({ version: 1, entries }), {
      mode: 0o600,
    });
    const controller = createFixedServiceController({ journalPath });

    try {
      await expect(controller.pendingResult()).resolves.toEqual(
        entries[entries.length - 1]?.result,
      );
      await controller.markResultDelivered("old-command-49", "old-nonce-49");
      await expect(controller.pendingResult()).resolves.toEqual(
        entries[entries.length - 2]?.result,
      );

      await controller.execute({
        ...COMMAND,
        commandId: "command-51",
        executionNonce: "nonce-51",
      });
      const stored = JSON.parse(await readFile(journalPath, "utf8")) as {
        entries: Array<Record<string, unknown>>;
      };
      expect(stored.entries).toHaveLength(50);
      expect(stored.entries.at(-1)).toMatchObject({ commandId: "command-51" });
      expect(stored.entries).toContainEqual(
        expect.objectContaining({ commandId: "old-command-0" }),
      );
      expect(stored.entries).not.toContainEqual(
        expect.objectContaining({ commandId: "old-command-49" }),
      );
    } finally {
      await controller.stop();
    }
  });

  it("never replays a claim whose result was lost", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gx-host-agent-"));
    const journalPath = path.join(directory, "executions.json");
    await writeFile(
      journalPath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            commandId: COMMAND.commandId,
            executionNonce: COMMAND.executionNonce,
            actionId: COMMAND.actionId,
            claimedAt: 1,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const controller = createFixedServiceController({ journalPath });

    try {
      await expect(controller.execute(COMMAND)).resolves.toBeNull();
    } finally {
      await controller.stop();
    }
  });

  it("advertises 0.2.0 and the fixed capability even from a 0.1.0 config", async () => {
    const request = vi.fn().mockResolvedValue(heartbeatResponse());
    const controller = new AbortController();
    const serviceController = fakeController();
    const loop = runHeartbeatLoop(CONFIG, {
      request,
      serviceController,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    controller.abort();
    await loop;

    const body = JSON.parse(
      String((request.mock.calls[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(body).toEqual({
      runnerId: CONFIG.runnerId,
      agentVersion: HOST_AGENT_VERSION,
      capabilityId: CONNECTED_RUNNER_CAPABILITY_ID,
      healthReport: HEALTHY_REPORT,
    });
    expect(serviceController.execute).not.toHaveBeenCalled();
  });

  it("does not send a heartbeat when shutdown happens during the health check", async () => {
    const abort = new AbortController();
    const request = vi.fn().mockResolvedValue(heartbeatResponse());
    const serviceController = fakeController({
      checkHealth: vi.fn().mockImplementation(async () => {
        abort.abort();
        return HEALTHY_REPORT;
      }),
    });

    await runHeartbeatLoop(CONFIG, {
      request,
      serviceController,
      signal: abort.signal,
    });

    expect(request).not.toHaveBeenCalled();
    expect(serviceController.stop).toHaveBeenCalledOnce();
  });

  it("executes only an approved fixed command and immediately delivers its stored result", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(heartbeatResponse(COMMAND))
      .mockResolvedValueOnce(heartbeatResponse());
    const abort = new AbortController();
    const pendingResult = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(RESULT);
    const serviceController = fakeController({ pendingResult });
    const loop = runHeartbeatLoop(CONFIG, {
      request,
      serviceController,
      signal: abort.signal,
    });

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    abort.abort();
    await loop;

    expect(serviceController.execute).toHaveBeenCalledOnce();
    expect(serviceController.execute).toHaveBeenCalledWith(COMMAND);
    const resultBody = JSON.parse(
      String((request.mock.calls[1]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(resultBody.previousCommandResult).toEqual(RESULT);
    expect(serviceController.markResultDelivered).toHaveBeenCalledWith(
      RESULT.commandId,
      RESULT.executionNonce,
    );
  });

  it("rejects a malformed successful heartbeat response", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ command: { command: "whoami" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const serviceController = fakeController();

    await expect(
      runHeartbeatLoop(CONFIG, {
        request,
        serviceController,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/response/i);
    expect(serviceController.execute).not.toHaveBeenCalled();
  });

  it("retries network, 5xx, and 429 failures with bounded delays but exits on 401", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { "Retry-After": "3" } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const serviceController = fakeController();
    const loop = runHeartbeatLoop(CONFIG, {
      request,
      serviceController,
      signal: new AbortController().signal,
    });
    const rejected = expect(loop).rejects.toThrow(/revoked|credential/i);

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));

    await rejected;
    expect(serviceController.stop).toHaveBeenCalledOnce();
  });

  it("uses one fixed shell-free child and has no inbound listener or arbitrary operational input", async () => {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../host-agent",
    );
    const sources = await Promise.all(
      [
        "config.ts",
        "pair.ts",
        "connect.ts",
        "fixed-service.ts",
        "seed-failure.ts",
      ].map((file) => readFile(path.join(root, file), "utf8")),
    );
    const source = sources.join("\n");
    const connectSource = sources[2] ?? "";
    const fixedServiceSource = sources[3] ?? "";

    expect(source).not.toMatch(/\bexecFile\s*\(|\bexec\s*\(|shell:\s*true/);
    expect(connectSource).not.toMatch(/createServer|\.listen\s*\(/);
    expect(source).not.toMatch(/hostname\(|networkInterfaces|readdir|read configured log/i);
    expect(fixedServiceSource).toContain(
      "spawn(process.execPath, [FIXED_SERVICE_MODULE_PATH]",
    );
    expect(fixedServiceSource).toMatch(/shell:\s*false/);
    expect(fixedServiceSource).not.toMatch(/env:\s*process\.env|\.\.\.process\.env/);
    expect(connectSource).not.toMatch(/commandLine|shellCommand|filePath|healthUrl/);
  });
});
