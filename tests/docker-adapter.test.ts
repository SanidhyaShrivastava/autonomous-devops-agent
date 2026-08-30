import { describe, expect, it } from "vitest";

import {
  DockerAdapter,
  SAFE_INSPECT_FORMAT,
  type HealthFetch,
} from "../runner/docker-adapter";
import {
  createDockerCommandExecutor,
  type DockerCommandExecutor,
  type DockerCommandResult,
  type ExecFileLike,
} from "../runner/command-executor";
import {
  DEMO_ACTION_ID,
  DEMO_CONTAINER_NAME,
  DEMO_HEALTH_URL,
  DEMO_LABEL_VALUE,
  DEMO_WORKLOAD_ID,
} from "../runner/config";

const CONTAINER_ID = "a".repeat(64);

function inspection(
  overrides: Partial<{
    containerId: string;
    demoLabel: string;
    status: string;
    exitCode: number;
    oomKilled: boolean;
    finishedAt: string;
  }> = {},
): string {
  return JSON.stringify({
    containerId: CONTAINER_ID,
    demoLabel: DEMO_LABEL_VALUE,
    status: "exited",
    exitCode: 0,
    oomKilled: false,
    finishedAt: "2026-08-30T10:15:00.000Z",
    ...overrides,
  });
}

class FakeDockerProcess implements DockerCommandExecutor {
  readonly calls: readonly string[][] = [];
  private readonly queue: Array<
    | Partial<DockerCommandResult>
    | ((args: readonly string[]) => Partial<DockerCommandResult>)
  >;
  private clock = 100;

  constructor(
    responses: Array<
      | Partial<DockerCommandResult>
      | ((args: readonly string[]) => Partial<DockerCommandResult>)
    >,
  ) {
    this.queue = [...responses];
  }

  async run(args: readonly string[]): Promise<DockerCommandResult> {
    (this.calls as string[][]).push([...args]);
    const queued = this.queue.shift();
    if (!queued) {
      throw new Error(`Unexpected Docker call: ${args.join(" ")}`);
    }

    const response = typeof queued === "function" ? queued(args) : queued;
    const startedAt = this.clock;
    this.clock += 10;

    return {
      executable: "docker",
      args: [...args],
      stdout: "",
      stderr: "",
      exitCode: 0,
      startedAt,
      finishedAt: this.clock,
      durationMs: 10,
      ...response,
    };
  }
}

function recoveryRequest(executionId = "execution-1") {
  return {
    actionId: DEMO_ACTION_ID,
    workloadId: DEMO_WORKLOAD_ID,
    executionId,
  };
}

describe("Docker-only command executor", () => {
  it("always invokes the Docker executable with shell disabled and fixed limits", async () => {
    const calls: Array<{
      executable: string;
      args: readonly string[];
      options: { shell: false; timeout: number; maxBuffer: number };
    }> = [];
    const execFile: ExecFileLike = (executable, args, options, callback) => {
      calls.push({ executable, args, options });
      callback(null, "ok", "");
    };
    let now = 10;
    const executor = createDockerCommandExecutor({
      execFile,
      now: () => {
        now += 5;
        return now;
      },
    });

    const result = await executor.run(["version"]);

    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.executable).toBe("docker");
    expect(calls[0]?.args).toEqual(["version"]);
    expect(calls[0]?.options).toMatchObject({
      shell: false,
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
  });
});

describe("DockerAdapter action boundary", () => {
  it("rejects an unknown action before making any Docker call", async () => {
    const process = new FakeDockerProcess([]);
    const adapter = new DockerAdapter({ process });

    await expect(
      adapter.executeRecoveryAction({
        actionId: "restart_everything",
        workloadId: DEMO_WORKLOAD_ID,
        executionId: "unknown-action",
      }),
    ).rejects.toThrow();
    expect(process.calls).toHaveLength(0);
  });

  it("rejects extra operational parameters before making any Docker call", async () => {
    const process = new FakeDockerProcess([]);
    const adapter = new DockerAdapter({ process });

    await expect(
      adapter.executeRecoveryAction({
        ...recoveryRequest("extra-field"),
        command: "docker start another-container",
      }),
    ).rejects.toThrow();
    expect(process.calls).toHaveLength(0);
  });

  it("validates the fixed label and starts the inspected immutable container ID", async () => {
    const process = new FakeDockerProcess([
      { stdout: inspection() },
      { stdout: `${CONTAINER_ID}\n` },
    ]);
    const adapter = new DockerAdapter({ process });

    const result = await adapter.executeRecoveryAction(recoveryRequest());

    expect(result).toMatchObject({
      actionId: DEMO_ACTION_ID,
      commandLabel: "docker start fixed demo service",
      exitCode: 0,
    });
    expect(process.calls).toEqual([
      [
        "container",
        "inspect",
        "--format",
        SAFE_INSPECT_FORMAT,
        DEMO_CONTAINER_NAME,
      ],
      ["container", "start", CONTAINER_ID],
    ]);
  });

  it("blocks a correct container name with a wrong label", async () => {
    const process = new FakeDockerProcess([
      { stdout: inspection({ demoLabel: "not-the-demo" }) },
    ]);
    const adapter = new DockerAdapter({ process });

    await expect(
      adapter.executeRecoveryAction(recoveryRequest()),
    ).rejects.toThrow("identity or safe state did not validate");
    expect(process.calls).toHaveLength(1);
  });

  it("blocks duplicate execution IDs without a second restart", async () => {
    const process = new FakeDockerProcess([
      { stdout: inspection() },
      { stdout: `${CONTAINER_ID}\n` },
    ]);
    const adapter = new DockerAdapter({ process });

    await adapter.executeRecoveryAction(recoveryRequest("same-execution"));
    await expect(
      adapter.executeRecoveryAction(recoveryRequest("same-execution")),
    ).rejects.toThrow("Duplicate recovery execution rejected");
    expect(process.calls).toHaveLength(2);
  });
});

describe("DockerAdapter safe evidence", () => {
  it("returns only the five approved state fields", async () => {
    const process = new FakeDockerProcess([{ stdout: inspection() }]);
    const adapter = new DockerAdapter({ process });

    const state = await adapter.inspectSafeState();

    expect(state).toEqual({
      status: "exited",
      exitCode: 0,
      oomKilled: false,
      finishedAt: "2026-08-30T10:15:00.000Z",
      demoLabel: DEMO_LABEL_VALUE,
    });
    expect(Object.keys(state).sort()).toEqual(
      ["demoLabel", "exitCode", "finishedAt", "oomKilled", "status"].sort(),
    );
  });

  it("reads at most 30 sanitized lines and 4000 characters", async () => {
    const logLines = Array.from({ length: 40 }, (_, index) =>
      index === 39
        ? `RUNNER_TOKEN=secret-value-${index}`
        : `safe log line ${index} ${"x".repeat(180)}`,
    ).join("\n");
    const process = new FakeDockerProcess([
      { stdout: inspection({ status: "running" }) },
      { stdout: logLines },
    ]);
    const adapter = new DockerAdapter({ process });

    const logs = await adapter.readSafeLogTail();

    expect(process.calls[1]).toEqual([
      "container",
      "logs",
      "--tail",
      "30",
      "--timestamps",
      CONTAINER_ID,
    ]);
    expect(logs.lineCount).toBeLessThanOrEqual(30);
    expect(logs.characterCount).toBeLessThanOrEqual(4_000);
    expect(logs.lines.join("\n")).not.toContain("secret-value-39");
    expect(logs.truncated).toBe(true);
  });
});

describe("DockerAdapter independent health verification", () => {
  it("uses only the fixed loopback URL and rejects the wrong service identity", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const healthFetch: HealthFetch = async (url, init) => {
      calls.push({ url, init });
      return {
        status: 200,
        json: async () => ({ status: "healthy", service: "wrong-service" }),
      };
    };
    const adapter = new DockerAdapter({ fetch: healthFetch });

    const evidence = await adapter.checkHealthOnce();

    expect(evidence.healthy).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(DEMO_HEALTH_URL);
    expect(calls[0]?.init).toMatchObject({
      method: "GET",
      cache: "no-store",
      redirect: "error",
    });
  });

  it("does not treat a successful start as recovery when health fails", async () => {
    const process = new FakeDockerProcess([
      { stdout: inspection() },
      { stdout: `${CONTAINER_ID}\n` },
    ]);
    const healthFetch: HealthFetch = async () => {
      throw new Error("connection refused");
    };
    let now = 1_000;
    const adapter = new DockerAdapter({
      process,
      fetch: healthFetch,
      now: () => now,
      sleep: async () => {
        now += 500;
      },
    });

    const action = await adapter.executeRecoveryAction(recoveryRequest());
    const evidence = await adapter.verifyFreshHealth(action.finishedAt);

    expect(action.exitCode).toBe(0);
    expect(evidence.healthy).toBe(false);
  });

  it("accepts exact healthy evidence only when the request is fresh", async () => {
    let now = 90;
    const healthFetch: HealthFetch = async () => ({
      status: 200,
      json: async () => ({
        status: "healthy",
        service: DEMO_CONTAINER_NAME,
      }),
    });
    const adapter = new DockerAdapter({
      fetch: healthFetch,
      now: () => now,
      sleep: async () => {
        now += 20;
      },
    });

    const evidence = await adapter.verifyFreshHealth(100);

    expect(evidence.healthy).toBe(true);
    expect(evidence.requestStartedAt).toBeGreaterThanOrEqual(100);
    expect(evidence.attempts).toBe(2);
  });
});
