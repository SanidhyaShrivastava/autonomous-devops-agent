import { describe, expect, it } from "vitest";

import {
  createDockerCommandExecutor,
  DockerCommandError,
  type ExecFileLike,
} from "../runner/command-executor";

describe("Docker command executor child environment", () => {
  it("passes overrides only through the child environment", async () => {
    const derivedToken = "derived-sandbox-token";
    let capturedOptions: Parameters<ExecFileLike>[2] | undefined;
    const execFile: ExecFileLike = (executable, args, options, callback) => {
      expect(executable).toBe("docker");
      expect(args).toEqual(["container", "run", "--env", "SANDBOX_AGENT_TOKEN"]);
      capturedOptions = options;
      callback(null, "container-id\n", "");
    };
    const executor = createDockerCommandExecutor({ execFile });

    const result = await executor.run(
      ["container", "run", "--env", "SANDBOX_AGENT_TOKEN"],
      { SANDBOX_AGENT_TOKEN: derivedToken },
    );

    expect(capturedOptions).toMatchObject({
      shell: false,
      env: expect.objectContaining({
        SANDBOX_AGENT_TOKEN: derivedToken,
      }),
    });
    expect(capturedOptions?.env.PATH).toBe(process.env.PATH);
    expect(result.args.join(" ")).not.toContain(derivedToken);
    expect(result).not.toHaveProperty("env");
    expect(result).not.toHaveProperty("environment");
  });

  it("redacts child environment values from command failures", async () => {
    const derivedToken = "derived-token-that-must-not-leak";
    const execFile: ExecFileLike = (_executable, _args, _options, callback) => {
      const error = Object.assign(new Error(`failed with ${derivedToken}`), {
        code: 1,
      });
      callback(error, derivedToken, `stderr ${derivedToken}`);
    };
    const executor = createDockerCommandExecutor({ execFile });

    const failure = await executor
      .run(["container", "run"], { SANDBOX_AGENT_TOKEN: derivedToken })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DockerCommandError);
    expect(failure).toMatchObject({ stdout: "[REDACTED]", stderr: "stderr [REDACTED]" });
    expect(JSON.stringify(failure)).not.toContain(derivedToken);
    expect(String((failure as Error & { cause?: unknown }).cause)).not.toContain(
      derivedToken,
    );
  });
});
