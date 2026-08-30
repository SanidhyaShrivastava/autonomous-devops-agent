import { execFile as nodeExecFile } from "node:child_process";

import {
  PROCESS_MAX_BUFFER_BYTES,
  PROCESS_TIMEOUT_MS,
} from "./config";

const DOCKER_EXECUTABLE = "docker" as const;

export interface ExecFileOptions {
  readonly encoding: "utf8";
  readonly maxBuffer: number;
  readonly shell: false;
  readonly timeout: number;
}

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
  run(args: readonly string[]): Promise<DockerCommandResult>;
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
    run(args: readonly string[]): Promise<DockerCommandResult> {
      const fixedArgs = Object.freeze([...args]);
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
              args: fixedArgs,
              stdout,
              stderr,
              exitCode,
              startedAt,
              finishedAt: now(),
              killed,
              signal,
              cause,
            }),
          );
        };

        try {
          execFile(
            DOCKER_EXECUTABLE,
            fixedArgs,
            {
              encoding: "utf8",
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
                args: fixedArgs,
                stdout,
                stderr,
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
