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
import { pairWithCode } from "../host-agent/pair";
import { runHeartbeatLoop } from "../host-agent/connect";

const CONFIG: RunnerConfig = {
  agentVersion: "0.1.0",
  baseUrl: "https://autonomous-devops-agent.vercel.app",
  credential: `gxrun_${"b".repeat(43)}`,
  runnerId: "gxr_abcdefghijklmnopqrstuvwx",
};

describe("minimal Linux host agent", () => {
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

  it("pairs through outbound HTTPS and never puts the code in the saved config", async () => {
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
      agentVersion: "0.1.0",
      architecture: "arm64",
      pairingCode,
    });
    expect(result).toEqual(CONFIG);
    expect(JSON.stringify(result)).not.toContain(pairingCode);
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

  it("sends an immediate heartbeat and repeats every two seconds", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const controller = new AbortController();
    const loop = runHeartbeatLoop(CONFIG, {
      request,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    controller.abort();
    await vi.runAllTimersAsync();
    await loop;

    expect(request).toHaveBeenLastCalledWith(
      `${CONFIG.baseUrl}/api/runners/heartbeat`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: `Bearer ${CONFIG.credential}`,
        }),
      }),
    );
  });

  it("contains no shell execution, host discovery, file reading, or inbound server", async () => {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../host-agent",
    );
    const sources = await Promise.all(
      ["config.ts", "pair.ts", "connect.ts"].map((file) =>
        readFile(path.join(root, file), "utf8"),
      ),
    );
    const source = sources.join("\n");

    expect(source).not.toMatch(/node:child_process|execFile|spawn\(|exec\(/);
    expect(source).not.toMatch(/createServer|listen\(/);
    expect(source).not.toMatch(/hostname\(|networkInterfaces|readdir|read configured log/i);
  });
});
