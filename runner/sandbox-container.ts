import { z } from "zod";

import {
  createDockerCommandExecutor,
  DockerCommandError,
  type DockerCommandExecutor,
} from "./command-executor";

export const SANDBOX_CONTAINER_NAME = "gx-autodevops-linux-sandbox" as const;
export const SANDBOX_IMAGE = "gx-autodevops-linux-sandbox:m2" as const;
export const SANDBOX_LABEL_KEY = "com.growthx.sandbox" as const;
export const SANDBOX_LABEL_VALUE = "autonomous-devops-agent" as const;
export const SANDBOX_PORT_BINDING = "127.0.0.1:3410:3000/tcp" as const;

const SANDBOX_TMPFS = "/tmp:rw,noexec,nosuid,nodev,size=16m" as const;
const SANDBOX_TMPFS_OPTIONS = "rw,noexec,nosuid,nodev,size=16m" as const;
const SANDBOX_MEMORY_BYTES = 256 * 1024 * 1024;
const SANDBOX_NANO_CPUS = 1_000_000_000;

export const SANDBOX_INSPECT_FORMAT =
  `{"containerId":{{json .Id}},` +
  `"sandboxLabel":{{json (index .Config.Labels "${SANDBOX_LABEL_KEY}")}},` +
  `"image":{{json .Config.Image}},` +
  `"running":{{json .State.Running}},` +
  `"privileged":{{json .HostConfig.Privileged}},` +
  `"user":{{json .Config.User}},` +
  `"readOnly":{{json .HostConfig.ReadonlyRootfs}},` +
  `"hostBinds":{{json .HostConfig.Binds}},` +
  `"mounts":{{json .Mounts}},` +
  `"portBindings":{{json .HostConfig.PortBindings}},` +
  `"securityOptions":{{json .HostConfig.SecurityOpt}},` +
  `"capAdd":{{json .HostConfig.CapAdd}},` +
  `"capDrop":{{json .HostConfig.CapDrop}},` +
  `"pidMode":{{json .HostConfig.PidMode}},` +
  `"networkMode":{{json .HostConfig.NetworkMode}},` +
  `"autoRemove":{{json .HostConfig.AutoRemove}},` +
  `"tmpfs":{{json .HostConfig.Tmpfs}},` +
  `"pidsLimit":{{json .HostConfig.PidsLimit}},` +
  `"memory":{{json .HostConfig.Memory}},` +
  `"nanoCpus":{{json .HostConfig.NanoCpus}},` +
  `"restartPolicy":{{json .HostConfig.RestartPolicy.Name}}}`;

const EmptyStringListSchema = z.union([z.null(), z.tuple([])]);

const SandboxInspectionSchema = z
  .object({
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    sandboxLabel: z.literal(SANDBOX_LABEL_VALUE),
    image: z.literal(SANDBOX_IMAGE),
    running: z.boolean(),
    privileged: z.literal(false),
    user: z.literal("node"),
    readOnly: z.literal(true),
    hostBinds: EmptyStringListSchema,
    mounts: z.tuple([]),
    portBindings: z
      .object({
        "3000/tcp": z.tuple([
          z
            .object({
              HostIp: z.literal("127.0.0.1"),
              HostPort: z.literal("3410"),
            })
            .strict(),
        ]),
      })
      .strict(),
    securityOptions: z.tuple([z.literal("no-new-privileges:true")]),
    capAdd: EmptyStringListSchema,
    capDrop: z.tuple([z.literal("ALL")]),
    pidMode: z.literal(""),
    networkMode: z.literal("bridge"),
    autoRemove: z.literal(false),
    tmpfs: z
      .object({
        "/tmp": z.literal(SANDBOX_TMPFS_OPTIONS),
      })
      .strict(),
    pidsLimit: z.literal(64),
    memory: z.literal(SANDBOX_MEMORY_BYTES),
    nanoCpus: z.literal(SANDBOX_NANO_CPUS),
    restartPolicy: z.literal("no"),
  })
  .strict();

export interface SandboxContainerState {
  readonly containerId: string;
  readonly running: true;
}

export interface SandboxContainerDependencies {
  readonly process?: DockerCommandExecutor;
}

function isMissingContainer(error: unknown): boolean {
  if (!(error instanceof DockerCommandError)) {
    return false;
  }

  const message = `${error.stdout}\n${error.stderr}`.toLowerCase();
  return (
    message.includes("no such object") ||
    message.includes("no such container")
  );
}

function parseInspection(stdout: string): z.infer<typeof SandboxInspectionSchema> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Docker returned malformed sandbox inspection data");
  }

  const inspection = SandboxInspectionSchema.safeParse(decoded);
  if (!inspection.success) {
    throw new Error("Sandbox container identity or hardening did not validate");
  }

  return inspection.data;
}

export class SandboxContainerManager {
  private readonly process: DockerCommandExecutor;

  constructor(dependencies: SandboxContainerDependencies = {}) {
    this.process = dependencies.process ?? createDockerCommandExecutor();
  }

  private async inspectExistingContainer() {
    const result = await this.process.run([
      "container",
      "inspect",
      "--format",
      SANDBOX_INSPECT_FORMAT,
      SANDBOX_CONTAINER_NAME,
    ]);
    return parseInspection(result.stdout);
  }

  async ensure(sandboxAgentToken: string): Promise<SandboxContainerState> {
    if (sandboxAgentToken.length === 0 || sandboxAgentToken.trim().length === 0) {
      throw new Error("Sandbox agent token is required");
    }

    let inspection: z.infer<typeof SandboxInspectionSchema>;
    try {
      inspection = await this.inspectExistingContainer();
    } catch (error) {
      if (!isMissingContainer(error)) {
        throw error;
      }

      const created = await this.process.run(
        [
          "container",
          "run",
          "--detach",
          "--name",
          SANDBOX_CONTAINER_NAME,
          "--publish",
          SANDBOX_PORT_BINDING,
          "--label",
          `${SANDBOX_LABEL_KEY}=${SANDBOX_LABEL_VALUE}`,
          "--user",
          "node",
          "--read-only",
          "--tmpfs",
          SANDBOX_TMPFS,
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
          SANDBOX_IMAGE,
        ],
        { SANDBOX_AGENT_TOKEN: sandboxAgentToken },
      );
      const containerId = created.stdout.trim();
      if (!/^[a-f0-9]{64}$/.test(containerId)) {
        throw new Error("Docker returned an invalid sandbox container ID");
      }
      const createdInspection = await this.inspectExistingContainer();
      if (
        createdInspection.containerId !== containerId ||
        !createdInspection.running
      ) {
        throw new Error("The created sandbox container did not verify running");
      }
      return Object.freeze({ containerId, running: true });
    }

    if (!inspection.running) {
      await this.process.run(["container", "start", inspection.containerId]);
      const startedInspection = await this.inspectExistingContainer();
      if (
        startedInspection.containerId !== inspection.containerId ||
        !startedInspection.running
      ) {
        throw new Error("The sandbox container did not verify running");
      }
    }

    return Object.freeze({
      containerId: inspection.containerId,
      running: true,
    });
  }
}

export function ensureSandboxContainer(
  sandboxAgentToken: string,
  dependencies: SandboxContainerDependencies = {},
): Promise<SandboxContainerState> {
  return new SandboxContainerManager(dependencies).ensure(sandboxAgentToken);
}
