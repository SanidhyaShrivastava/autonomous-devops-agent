import { createServer, type Server } from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  DuplicateExecutionError,
  createAgentRequestHandler,
  createBoundedLogBuffer,
  createManagedWorkload,
  type RecoveryActionRequest,
  type SpawnWorkload,
  type WorkloadManager,
} from "../linux-sandbox/agent";

const AGENT_TOKEN = "sandbox-test-token";
const DEMO_LABEL = "autonomous-devops-agent" as const;

function safeState() {
  return {
    status: "exited",
    exitCode: 143,
    oomKilled: false as const,
    finishedAt: "2026-08-31T12:00:00.000Z",
    demoLabel: DEMO_LABEL,
  };
}

function healthEvidence() {
  return {
    healthy: true,
    httpStatus: 200,
    service: "gx-autodevops-demo-service",
    status: "healthy",
    requestStartedAt: 100,
    checkedAt: 110,
    attempts: 1,
  };
}

class FakeWorkloadManager implements WorkloadManager {
  readonly calls: string[] = [];
  readonly executionIds = new Set<string>();
  logLines: string[] = ["[startup] ready", "[health] healthy"];

  async inspectSafeState() {
    this.calls.push("inspectSafeState");
    return safeState();
  }

  async readSafeLogTail() {
    this.calls.push("readSafeLogTail");
    return {
      lines: this.logLines,
      lineCount: this.logLines.length,
      characterCount: Array.from(this.logLines.join("\n")).length,
      truncated: false,
    };
  }

  async checkHealthOnce() {
    this.calls.push("checkHealthOnce");
    return healthEvidence();
  }

  async stopDemoService() {
    this.calls.push("stopDemoService");
  }

  async ensureDemoService() {
    this.calls.push("ensureDemoService");
    return { ...safeState(), status: "running", exitCode: 0, finishedAt: "" };
  }

  async executeRecoveryAction(input: RecoveryActionRequest) {
    this.calls.push(`executeRecoveryAction:${input.executionId}`);
    if (this.executionIds.has(input.executionId)) {
      throw new DuplicateExecutionError();
    }
    this.executionIds.add(input.executionId);

    return {
      actionId: "restart_demo_service" as const,
      commandLabel: "linux agent restart fixed demo service" as const,
      exitCode: 0 as const,
      startedAt: 100,
      finishedAt: 110,
      durationMs: 10,
    };
  }

  async shutdown() {
    this.calls.push("shutdown");
  }
}

interface TestAgent {
  readonly origin: string;
  readonly manager: FakeWorkloadManager;
  close(): Promise<void>;
}

const servers = new Set<Server>();

async function startTestAgent(
  manager = new FakeWorkloadManager(),
): Promise<TestAgent> {
  const server = createServer(
    createAgentRequestHandler({ manager, token: AGENT_TOKEN }),
  );
  servers.add(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test agent did not bind to a TCP port");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    manager,
    async close() {
      servers.delete(server);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function agentFetch(
  agent: TestAgent,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${AGENT_TOKEN}`);
  return fetch(`${agent.origin}${path}`, { ...init, headers });
}

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  servers.clear();
});

describe("Linux sandbox agent authentication and routing", () => {
  it("returns the same generic 401 for missing and wrong bearer tokens", async () => {
    const agent = await startTestAgent();

    const missing = await fetch(`${agent.origin}/v1/workload/state`);
    const wrong = await fetch(`${agent.origin}/v1/workload/state`, {
      headers: { authorization: "Bearer definitely-wrong" },
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await missing.text()).toBe(await wrong.text());
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(agent.manager.calls).toEqual([]);
    await agent.close();
  });

  it("returns 404 for an authenticated unknown route", async () => {
    const agent = await startTestAgent();

    const response = await agentFetch(agent, "/v1/not-a-real-operation");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(agent.manager.calls).toEqual([]);
    await agent.close();
  });
});

describe("Linux sandbox agent request boundary", () => {
  it("returns 413 without invoking the manager when a body exceeds 2,048 bytes", async () => {
    const agent = await startTestAgent();

    const response = await agentFetch(agent, "/v1/actions/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(2_048) }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request_too_large" });
    expect(agent.manager.calls).toEqual([]);
    await agent.close();
  });

  it.each([
    {
      name: "stop body with an unknown field",
      path: "/v1/demo/stop",
      body: { kind: "STOP_DEMO_SERVICE_V1", command: "touch /tmp/no" },
    },
    {
      name: "ensure body with an unknown field",
      path: "/v1/demo/ensure",
      body: { kind: "ENSURE_DEMO_SERVICE_V1", target: "another-service" },
    },
    {
      name: "action body with an unknown field",
      path: "/v1/actions/execute",
      body: {
        actionId: "restart_demo_service",
        workloadId: "demo-service",
        executionId: "execution_extra",
        command: "restart anything",
      },
    },
  ])("rejects $name", async ({ path, body }) => {
    const agent = await startTestAgent();

    const response = await agentFetch(agent, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(agent.manager.calls).toEqual([]);
    await agent.close();
  });

  it.each([
    {
      actionId: "restart_everything",
      workloadId: "demo-service",
      executionId: "execution_unknown_action",
    },
    {
      actionId: "restart_demo_service",
      workloadId: "production-service",
      executionId: "execution_unknown_workload",
    },
  ])("rejects an unknown action or workload", async (body) => {
    const agent = await startTestAgent();

    const response = await agentFetch(agent, "/v1/actions/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(agent.manager.calls).toEqual([]);
    await agent.close();
  });

  it("returns 409 for a duplicate execution ID without a second restart", async () => {
    const agent = await startTestAgent();
    const body = JSON.stringify({
      actionId: "restart_demo_service",
      workloadId: "demo-service",
      executionId: "execution_test_1",
    });

    const first = await agentFetch(agent, "/v1/actions/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const duplicate = await agentFetch(agent, "/v1/actions/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "duplicate_execution" });
    expect(agent.manager.calls).toEqual([
      "executeRecoveryAction:execution_test_1",
      "executeRecoveryAction:execution_test_1",
    ]);
    await agent.close();
  });

  it("caps logs at the newest 30 lines and 4,000 characters", async () => {
    const manager = new FakeWorkloadManager();
    manager.logLines = Array.from(
      { length: 35 },
      (_, index) => `line-${index}-${"x".repeat(180)}`,
    );
    const agent = await startTestAgent(manager);

    const response = await agentFetch(agent, "/v1/workload/logs");
    const payload = (await response.json()) as {
      lines: string[];
      lineCount: number;
      characterCount: number;
      truncated: boolean;
    };

    expect(response.status).toBe(200);
    expect(payload.lines.length).toBeLessThanOrEqual(30);
    expect(payload.lineCount).toBe(payload.lines.length);
    expect(payload.characterCount).toBeLessThanOrEqual(4_000);
    expect(payload.lines.at(-1)).toContain("line-34-");
    expect(payload.truncated).toBe(true);
    expect(manager.calls).toEqual(["readSafeLogTail"]);
    await agent.close();
  });

  it("preserves an earlier safe truncation marker from the workload manager", async () => {
    const manager = new FakeWorkloadManager();
    manager.readSafeLogTail = async () => ({
      lines: ["latest safe line"],
      lineCount: 1,
      characterCount: 16,
      truncated: true,
    });
    const agent = await startTestAgent(manager);

    const response = await agentFetch(agent, "/v1/workload/logs");

    await expect(response.json()).resolves.toMatchObject({
      lines: ["latest safe line"],
      truncated: true,
    });
    await agent.close();
  });
});

describe("Linux sandbox agent fixed operations", () => {
  it("maps each valid route to only its corresponding fixed manager method", async () => {
    const cases: Array<{
      path: string;
      init?: RequestInit;
      expectedCall: string;
    }> = [
      { path: "/v1/workload/state", expectedCall: "inspectSafeState" },
      { path: "/v1/workload/logs", expectedCall: "readSafeLogTail" },
      { path: "/v1/workload/health", expectedCall: "checkHealthOnce" },
      {
        path: "/v1/demo/stop",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "STOP_DEMO_SERVICE_V1" }),
        },
        expectedCall: "stopDemoService",
      },
      {
        path: "/v1/demo/ensure",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "ENSURE_DEMO_SERVICE_V1" }),
        },
        expectedCall: "ensureDemoService",
      },
      {
        path: "/v1/actions/execute",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            actionId: "restart_demo_service",
            workloadId: "demo-service",
            executionId: "execution_test_1",
          }),
        },
        expectedCall: "executeRecoveryAction:execution_test_1",
      },
    ];

    for (const testCase of cases) {
      const manager = new FakeWorkloadManager();
      const agent = await startTestAgent(manager);

      const response = await agentFetch(agent, testCase.path, testCase.init);

      expect(response.status, testCase.path).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(manager.calls).toEqual([testCase.expectedCall]);
      await agent.close();
    }
  });
});

describe("Linux sandbox fixed child process", () => {
  it("spawns only the bundled workload without a shell and rejects a duplicate restart", async () => {
    const calls: Array<{
      executable: string;
      args: readonly string[];
      options: Parameters<SpawnWorkload>[2];
    }> = [];

    class FakeChild extends EventEmitter {
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;

      kill(signal: NodeJS.Signals = "SIGTERM") {
        this.signalCode = signal;
        this.exitCode = signal === "SIGTERM" ? 143 : 137;
        queueMicrotask(() => this.emit("exit", null, signal));
        return true;
      }
    }

    const spawnWorkload: SpawnWorkload = (executable, args, options) => {
      calls.push({ executable, args, options });
      const child = new FakeChild();
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ReturnType<SpawnWorkload>;
    };
    let now = 100;
    const manager = createManagedWorkload({
      spawnWorkload,
      now: () => (now += 10),
    });

    await manager.ensureDemoService();
    expect(calls).toEqual([
      {
        executable: "/usr/local/bin/node",
        args: ["/app/workload.mjs"],
        options: {
          cwd: "/app",
          env: {
            NODE_ENV: "production",
            PATH: "/usr/local/bin:/usr/bin:/bin",
          },
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      },
    ]);

    await manager.stopDemoService();
    const request = {
      actionId: "restart_demo_service",
      workloadId: "demo-service",
      executionId: "execution_fixed_child",
    } as const;
    await expect(manager.executeRecoveryAction(request)).resolves.toMatchObject({
      commandLabel: "linux agent restart fixed demo service",
      exitCode: 0,
    });
    await expect(manager.executeRecoveryAction(request)).rejects.toThrow(
      "Duplicate recovery execution rejected",
    );
    expect(calls).toHaveLength(2);
    await manager.shutdown();
  });

  it("checks only the fixed child health URL", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const manager = createManagedWorkload({
      fetchHealth: async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response(
          JSON.stringify({
            status: "healthy",
            service: "gx-autodevops-demo-service",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      now: () => 100,
    });

    await expect(manager.checkHealthOnce()).resolves.toMatchObject({
      healthy: true,
      httpStatus: 200,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:3001/health");
    expect(calls[0]?.init).toMatchObject({
      method: "GET",
      cache: "no-store",
      redirect: "error",
    });
  });

  it("does not consume an execution ID when the service has not stopped", async () => {
    class FakeChild extends EventEmitter {
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;

      kill(signal: NodeJS.Signals = "SIGTERM") {
        this.signalCode = signal;
        this.exitCode = signal === "SIGTERM" ? 143 : 137;
        queueMicrotask(() => this.emit("exit", null, signal));
        return true;
      }
    }

    const children: FakeChild[] = [];
    const spawnWorkload: SpawnWorkload = () => {
      const child = new FakeChild();
      children.push(child);
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ReturnType<SpawnWorkload>;
    };
    const manager = createManagedWorkload({ spawnWorkload });
    const request = {
      actionId: "restart_demo_service",
      workloadId: "demo-service",
      executionId: "retry_after_precondition",
    } as const;

    await manager.ensureDemoService();
    await expect(manager.executeRecoveryAction(request)).rejects.toThrow(
      "requires the demo service to be exited",
    );
    await manager.stopDemoService();
    await expect(manager.executeRecoveryAction(request)).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(children).toHaveLength(2);
    await manager.shutdown();
  });

  it("serializes ensure behind a stop that is still finishing", async () => {
    let releaseFirstExit!: () => void;
    const firstExitGate = new Promise<void>((resolveGate) => {
      releaseFirstExit = resolveGate;
    });
    class FakeChild extends EventEmitter {
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      readonly number: number;

      constructor(number: number) {
        super();
        this.number = number;
      }

      kill(signal: NodeJS.Signals = "SIGTERM") {
        if (this.number === 1 && signal === "SIGTERM") {
          void firstExitGate.then(() => {
            this.signalCode = signal;
            this.exitCode = 143;
            this.emit("exit", null, signal);
          });
          return true;
        }
        this.signalCode = signal;
        this.exitCode = signal === "SIGTERM" ? 143 : 137;
        queueMicrotask(() => this.emit("exit", null, signal));
        return true;
      }
    }

    const children: FakeChild[] = [];
    const spawnWorkload: SpawnWorkload = () => {
      const child = new FakeChild(children.length + 1);
      children.push(child);
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ReturnType<SpawnWorkload>;
    };
    const manager = createManagedWorkload({ spawnWorkload });
    await manager.ensureDemoService();

    const stopping = manager.stopDemoService();
    const ensuring = manager.ensureDemoService();
    await Promise.resolve();
    await Promise.resolve();
    expect(children).toHaveLength(1);

    releaseFirstExit();
    await stopping;
    await expect(ensuring).resolves.toMatchObject({ status: "running" });
    expect(children).toHaveLength(2);
    await manager.shutdown();
  });

  it("uses the fixed SIGKILL fallback when the child ignores SIGTERM", async () => {
    const signals: NodeJS.Signals[] = [];
    const scheduled: Array<() => void> = [];

    class FakeChild extends EventEmitter {
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;

      kill(signal: NodeJS.Signals = "SIGTERM") {
        signals.push(signal);
        if (signal === "SIGKILL") {
          this.signalCode = signal;
          this.exitCode = 137;
          queueMicrotask(() => this.emit("exit", null, signal));
        }
        return true;
      }
    }

    const child = new FakeChild();
    const manager = createManagedWorkload({
      spawnWorkload: (() => {
        queueMicrotask(() => child.emit("spawn"));
        return child as unknown as ReturnType<SpawnWorkload>;
      }) as SpawnWorkload,
      setTimeout: ((handler: TimerHandler) => {
        scheduled.push(handler as () => void);
        return 1 as unknown as NodeJS.Timeout;
      }) as unknown as typeof globalThis.setTimeout,
      clearTimeout: (() => undefined) as unknown as typeof globalThis.clearTimeout,
    });

    await manager.ensureDemoService();
    const stopping = manager.stopDemoService();
    await Promise.resolve();
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();

    await stopping;
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("keeps a permanent non-secret handler for a late child error", async () => {
    class FakeChild extends EventEmitter {
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;

      kill(signal: NodeJS.Signals = "SIGTERM") {
        this.signalCode = signal;
        this.exitCode = 143;
        queueMicrotask(() => this.emit("exit", null, signal));
        return true;
      }
    }

    const child = new FakeChild();
    const manager = createManagedWorkload({
      spawnWorkload: (() => {
        queueMicrotask(() => child.emit("spawn"));
        return child as unknown as ReturnType<SpawnWorkload>;
      }) as SpawnWorkload,
    });
    await manager.ensureDemoService();

    expect(() => child.emit("error", new Error("secret-token-value"))).not.toThrow();
    await expect(manager.inspectSafeState()).resolves.toMatchObject({
      status: "error",
    });
    expect((await manager.readSafeLogTail()).lines.join("\n")).not.toContain(
      "secret-token-value",
    );
    await manager.shutdown();
  });
});

describe("Linux sandbox in-memory log boundary", () => {
  it("redacts and truncates before storing at most 30 bounded lines", () => {
    let now = 0;
    const buffer = createBoundedLogBuffer(() => (now += 1));
    for (let index = 0; index < 35; index += 1) {
      buffer.add(
        "stdout",
        `line-${index} token=secret-${index} ${"x".repeat(1_000)}\n`,
      );
    }

    const snapshot = buffer.snapshot();
    expect(buffer.storedLineCount()).toBe(30);
    expect(snapshot.lines.length).toBeLessThanOrEqual(30);
    expect(snapshot.characterCount).toBeLessThanOrEqual(4_000);
    expect(snapshot.lines.join("\n")).not.toContain("secret-34");
    expect(snapshot.lines.every((line) => line.length <= 500)).toBe(true);
    expect(snapshot.truncated).toBe(true);
  });
});
