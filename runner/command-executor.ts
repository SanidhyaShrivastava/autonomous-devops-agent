import { execFile as nodeExecFile } from "node:child_process";

import {
  PROCESS_MAX_BUFFER_BYTES,
  PROCESS_TIMEOUT_MS,
} from "./config";

const DOCKER_EXECUTABLE = "docker" as const;

export interface ExecFileOptions {
  readonly encoding: "utf8";
  readonly env: NodeJS.ProcessEnv;
  readonly maxBuffer: number;
  readonly shell: false;
  readonly timeout: number;
}

export type DockerEnvironmentOverrides = Readonly<Record<string, string>>;

export type ExecFileError = Error & {
  readonly code?: number | string | null;
  readonly killed?: boolean;
  readonly signal?: NodeJS.Signals | null;
};

export type ExecFileCallback = (
  error: ExecFileError | null,
  stdout: string,
  stderr: string,
) => void;

export type ExecFileLike = (
  executable: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: ExecFileCallback,
) => unknown;

export interface DockerCommandResult {
  readonly executable: typeof DOCKER_EXECUTABLE;
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: 0;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
}

interface DockerCommandErrorDetails {
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly killed: boolean;
  readonly signal: NodeJS.Signals | null;
  readonly cause: unknown;
}

export class DockerCommandError extends Error {
  readonly executable = DOCKER_EXECUTABLE;
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly killed: boolean;
  readonly signal: NodeJS.Signals | null;
  override readonly cause: unknown;

  constructor(details: DockerCommandErrorDetails) {
    const exitDescription =
      details.exitCode === null ? "before returning an exit code" : `with exit code ${details.exitCode}`;

    super(`Docker command failed ${exitDescription}`);
    this.name = "DockerCommandError";
    this.args = details.args;
    this.stdout = details.stdout;
    this.stderr = details.stderr;
    this.exitCode = details.exitCode;
    this.startedAt = details.startedAt;
    this.finishedAt = details.finishedAt;
    this.durationMs = Math.max(0, details.finishedAt - details.startedAt);
    this.killed = details.killed;
    this.signal = details.signal;
    this.cause = details.cause;
  }
}

export interface DockerCommandExecutor {
  run(
    args: readonly string[],
    environment?: DockerEnvironmentOverrides,
  ): Promise<DockerCommandResult>;
}

export interface DockerCommandExecutorDependencies {
  readonly execFile?: ExecFileLike;
  readonly now?: () => number;
}

const systemExecFile: ExecFileLike = (executable, args, options, callback) =>
  nodeExecFile(executable, [...args], options, callback);

export function createDockerCommandExecutor(
  dependencies: DockerCommandExecutorDependencies = {},
): DockerCommandExecutor {
  const execFile = dependencies.execFile ?? systemExecFile;
  const now = dependencies.now ?? Date.now;

  return {
    run(
      args: readonly string[],
      environment: DockerEnvironmentOverrides = {},
    ): Promise<DockerCommandResult> {
      const executionArgs = Object.freeze([...args]);
      const secretValues = Object.values(environment).filter(
        (value) => value.length > 0,
      );
      const redact = (value: string): string =>
        secretValues.reduce(
          (safeValue, secret) => safeValue.split(secret).join("[REDACTED]"),
          value,
        );
      const safeArgs = Object.freeze(executionArgs.map(redact));
      const childEnvironment = Object.freeze({
        ...process.env,
        ...environment,
      });
      const startedAt = now();

      return new Promise((resolve, reject) => {
        const finishWithError = (
          cause: unknown,
          stdout = "",
          stderr = "",
          exitCode: number | null = null,
          killed = false,
          signal: NodeJS.Signals | null = null,
        ) => {
          reject(
            new DockerCommandError({
              args: safeArgs,
              stdout: redact(stdout),
              stderr: redact(stderr),
              exitCode,
              startedAt,
              finishedAt: now(),
              killed,
              signal,
              cause:
                secretValues.length === 0
                  ? cause
                  : Object.assign(
                      new Error(
                        cause instanceof Error
                          ? redact(cause.message)
                          : "Docker command invocation failed",
                      ),
                      { name: cause instanceof Error ? cause.name : "Error" },
                    ),
            }),
          );
        };

        try {
          execFile(
            DOCKER_EXECUTABLE,
            executionArgs,
            {
              encoding: "utf8",
              env: childEnvironment,
              maxBuffer: PROCESS_MAX_BUFFER_BYTES,
              shell: false,
              timeout: PROCESS_TIMEOUT_MS,
            },
            (error, stdout, stderr) => {
              const finishedAt = now();

              if (error) {
                finishWithError(
                  error,
                  stdout,
                  stderr,
                  typeof error.code === "number" ? error.code : null,
                  error.killed ?? false,
                  error.signal ?? null,
                );
                return;
              }

              resolve({
                executable: DOCKER_EXECUTABLE,
                args: safeArgs,
                stdout: redact(stdout),
                stderr: redact(stderr),
                exitCode: 0,
                startedAt,
                finishedAt,
                durationMs: Math.max(0, finishedAt - startedAt),
              });
            },
          );
        } catch (error) {
          finishWithError(error);
        }
      });
    },
  };
}
