import { describe, expect, it } from "vitest";

import {
  DockerCommandError,
  type DockerCommandExecutor,
  type DockerCommandResult,
  type DockerEnvironmentOverrides,
} from "../runner/command-executor";
import {
  SANDBOX_CONTAINER_NAME,
  SANDBOX_IMAGE,
  SANDBOX_INSPECT_FORMAT,
  ensureSandboxContainer,
} from "../runner/sandbox-container";

const CONTAINER_ID = "b".repeat(64);
const DERIVED_TOKEN = "derived-sandbox-token";
const RAW_RUNNER_TOKEN = "raw-runner-token";

interface ProcessCall {
  readonly args: readonly string[];
  readonly environment: DockerEnvironmentOverrides | undefined;
}

function inspection(
  overrides: Partial<{
    containerId: string;
    sandboxLabel: string;
    image: string;
    running: boolean;
    privileged: boolean;
    user: string;
    readOnly: boolean;
    hostBinds: readonly string[] | null;
    mounts: readonly unknown[];
    portBindings: unknown;
    securityOptions: readonly string[] | null;
    capAdd: readonly string[] | null;
    capDrop: readonly string[] | null;
    pidMode: string;
    networkMode: string;
    autoRemove: boolean;
    tmpfs: Record<string, string> | null;
    pidsLimit: number;
    memory: number;
    nanoCpus: number;
    restartPolicy: string;
  }> = {},
): string {
  return JSON.stringify({
    containerId: CONTAINER_ID,
    sandboxLabel: "autonomous-devops-agent",
    image: SANDBOX_IMAGE,
    running: true,
    privileged: false,
    user: "node",
    readOnly: true,
    hostBinds: null,
    mounts: [],
    portBindings: {
      "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "3410" }],
    },
    securityOptions: ["no-new-privileges:true"],
    capAdd: null,
    capDrop: ["ALL"],
    pidMode: "",
    networkMode: "bridge",
    autoRemove: false,
    tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16m" },
    pidsLimit: 64,
    memory: 256 * 1024 * 1024,
    nanoCpus: 1_000_000_000,
    restartPolicy: "no",
    ...overrides,
  });
}

function result(args: readonly string[], stdout = ""): DockerCommandResult {
  return {
    executable: "docker",
    args,
    stdout,
    stderr: "",
    exitCode: 0,
    startedAt: 10,
    finishedAt: 20,
    durationMs: 10,
  };
}

function missingContainerError(): DockerCommandError {
  return new DockerCommandError({
    args: ["container", "inspect", SANDBOX_CONTAINER_NAME],
    stdout: "",
    stderr: `Error: No such container: ${SANDBOX_CONTAINER_NAME}`,
    exitCode: 1,
    startedAt: 10,
    finishedAt: 20,
    killed: false,
    signal: null,
    cause: new Error("inspect failed"),
  });
}

class FakeDockerProcess implements DockerCommandExecutor {
  readonly calls: ProcessCall[] = [];

  constructor(
    private readonly responses: Array<DockerCommandResult | Error>,
  ) {}

  async run(
    args: readonly string[],
    environment?: DockerEnvironmentOverrides,
  ): Promise<DockerCommandResult> {
    this.calls.push({ args: [...args], environment });
    const response = this.responses.shift();
    if (!response) {
      throw new Error(`Unexpected Docker call: ${args.join(" ")}`);
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }
}

describe("sandbox container lifecycle", () => {
  it("creates only the fixed hardened container and sends the token only via child env", async () => {
    const process = new FakeDockerProcess([
      missingContainerError(),
      result(["container", "run"], `${CONTAINER_ID}\n`),
      result(["container", "inspect"], inspection()),
    ]);

    await ensureSandboxContainer(DERIVED_TOKEN, { process });

    expect(process.calls[0]).toEqual({
      args: [
        "container",
        "inspect",
        "--format",
        SANDBOX_INSPECT_FORMAT,
        SANDBOX_CONTAINER_NAME,
      ],
      environment: undefined,
    });
    const creation = process.calls[1];
    expect(creation?.args).toEqual([
      "container",
      "run",
      "--detach",
      "--name",
      "gx-autodevops-linux-sandbox",
      "--publish",
      "127.0.0.1:3410:3000/tcp",
      "--label",
      "com.growthx.sandbox=autonomous-devops-agent",
      "--user",
      "node",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=16m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--pids-limit",
      "64",
      "--memory",
      "256m",
      "--cpus",
      "1",
      "--restart=no",
      "--env",
      "SANDBOX_AGENT_TOKEN",
      "gx-autodevops-linux-sandbox:m2",
    ]);
    expect(creation?.environment).toEqual({
      SANDBOX_AGENT_TOKEN: DERIVED_TOKEN,
    });
    expect(process.calls[2]).toEqual({
      args: [
        "container",
        "inspect",
        "--format",
        SANDBOX_INSPECT_FORMAT,
        SANDBOX_CONTAINER_NAME,
      ],
      environment: undefined,
    });

    const serializedArgs = JSON.stringify(process.calls.map((call) => call.args));
    expect(serializedArgs).not.toContain(DERIVED_TOKEN);
    expect(serializedArgs).not.toContain(RAW_RUNNER_TOKEN);
    for (const forbidden of [
      "/var/run/docker.sock",
      "--privileged",
      "--network=host",
      "--pid=host",
      "--volume",
      "--mount",
    ]) {
      expect(serializedArgs).not.toContain(forbidden);
    }
  });

  it("reuses a running container only after its complete identity and hardening validate", async () => {
    const process = new FakeDockerProcess([
      result(["container", "inspect"], inspection()),
    ]);

    const state = await ensureSandboxContainer(DERIVED_TOKEN, { process });

    expect(state).toEqual({ containerId: CONTAINER_ID, running: true });
    expect(process.calls).toHaveLength(1);
    expect(process.calls[0]?.environment).toBeUndefined();
  });

  it("starts a stopped validated container by immutable ID", async () => {
    const process = new FakeDockerProcess([
      result(["container", "inspect"], inspection({ running: false })),
      result(["container", "start", CONTAINER_ID], `${CONTAINER_ID}\n`),
      result(["container", "inspect"], inspection()),
    ]);

    await ensureSandboxContainer(DERIVED_TOKEN, { process });

    expect(process.calls.map((call) => call.args)).toEqual([
      [
        "container",
        "inspect",
        "--format",
        SANDBOX_INSPECT_FORMAT,
        SANDBOX_CONTAINER_NAME,
      ],
      ["container", "start", CONTAINER_ID],
      [
        "container",
        "inspect",
        "--format",
        SANDBOX_INSPECT_FORMAT,
        SANDBOX_CONTAINER_NAME,
      ],
    ]);
    expect(process.calls[1]?.environment).toBeUndefined();
  });

  it.each([
    ["label", { sandboxLabel: "someone-elses-container" }],
    ["image", { image: "untrusted:latest" }],
    ["privileged mode", { privileged: true }],
    ["root user", { user: "root" }],
    ["writable root", { readOnly: false }],
    ["host bind", { hostBinds: ["/host:/container"] }],
    ["resolved mount", { mounts: [{ Type: "bind", Source: "/host" }] }],
    ["host network", { networkMode: "host" }],
    ["auto-remove", { autoRemove: true }],
    ["added capability", { capAdd: ["SYS_ADMIN"] }],
    ["missing capability drop", { capDrop: null }],
    ["wrong port", { portBindings: null }],
    ["wrong tmpfs", { tmpfs: { "/tmp": "rw" } }],
    ["wrong process limit", { pidsLimit: 128 }],
    ["wrong memory limit", { memory: 512 * 1024 * 1024 }],
    ["wrong CPU limit", { nanoCpus: 2_000_000_000 }],
    ["wrong restart policy", { restartPolicy: "always" }],
  ])("refuses a container with mismatched %s without changing it", async (_name, overrides) => {
    const process = new FakeDockerProcess([
      result(["container", "inspect"], inspection(overrides)),
    ]);

    await expect(
      ensureSandboxContainer(DERIVED_TOKEN, { process }),
    ).rejects.toThrow("identity or hardening did not validate");
    expect(process.calls).toHaveLength(1);
  });

  it("does not create a container for an unrelated inspect failure", async () => {
    const inspectFailure = new DockerCommandError({
      args: ["container", "inspect"],
      stdout: "",
      stderr: "permission denied",
      exitCode: 1,
      startedAt: 10,
      finishedAt: 20,
      killed: false,
      signal: null,
      cause: new Error("permission denied"),
    });
    const process = new FakeDockerProcess([inspectFailure]);

    await expect(
      ensureSandboxContainer(DERIVED_TOKEN, { process }),
    ).rejects.toBe(inspectFailure);
    expect(process.calls).toHaveLength(1);
  });
});
