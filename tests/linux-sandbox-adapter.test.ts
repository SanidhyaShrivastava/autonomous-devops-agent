import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  LinuxSandboxAdapter,
  type SandboxAgentFetch,
} from "../runner/linux-sandbox-adapter";
import { deriveSandboxAgentToken } from "../runner/sandbox-token";
import {
  DEMO_ACTION_ID,
  DEMO_LABEL_VALUE,
  DEMO_WORKLOAD_ID,
} from "../runner/config";

const ORIGIN = "http://127.0.0.1:3410";
const TOKEN = "derived-sandbox-token";

function safeState(overrides: Record<string, unknown> = {}) {
  return {
    status: "exited",
    exitCode: 0,
    oomKilled: false,
    finishedAt: "2026-08-31T10:15:00.000Z",
    demoLabel: DEMO_LABEL_VALUE,
    ...overrides,
  };
}

function safeLogs(overrides: Record<string, unknown> = {}) {
  return {
    lines: ["demo service stopped"],
    lineCount: 1,
    characterCount: 20,
    truncated: false,
    ...overrides,
  };
}

function healthy(overrides: Record<string, unknown> = {}) {
  return {
    healthy: true,
    httpStatus: 200,
    service: "gx-autodevops-demo-service",
    status: "healthy",
    requestStartedAt: 100,
    checkedAt: 110,
    attempts: 1,
    ...overrides,
  };
}

function recovery(overrides: Record<string, unknown> = {}) {
  return {
    actionId: DEMO_ACTION_ID,
    commandLabel: "linux agent restart fixed demo service",
    exitCode: 0,
    startedAt: 120,
    finishedAt: 130,
    durationMs: 10,
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return {
    status,
    json: async () => payload,
  };
}

function recoveryRequest(executionId = "execution-1") {
  return {
    actionId: DEMO_ACTION_ID,
    workloadId: DEMO_WORKLOAD_ID,
    executionId,
  };
}

describe("sandbox token derivation", () => {
  it("derives an isolated HMAC-SHA256 base64url token", () => {
    const runnerToken = "runner-secret";
    const expected = createHmac("sha256", runnerToken)
      .update("gx-linux-sandbox-agent-v1")
      .digest("base64url");

    expect(deriveSandboxAgentToken(runnerToken)).toBe(expected);
    expect(deriveSandboxAgentToken(runnerToken)).not.toBe(runnerToken);
  });

  it("rejects an empty runner token", () => {
    expect(() => deriveSandboxAgentToken("")).toThrow(
      "Runner token is required",
    );
    expect(() => deriveSandboxAgentToken("   ")).toThrow(
      "Runner token is required",
    );
  });
});

describe("LinuxSandboxAdapter request boundary", () => {
  it("uses only the six fixed authenticated loopback routes with hardened request options", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch: SandboxAgentFetch = async (url, init) => {
      calls.push({ url, init });
      const path = new URL(url).pathname;
      if (path === "/v1/workload/state") return jsonResponse(safeState());
      if (path === "/v1/workload/logs") return jsonResponse(safeLogs());
      if (path === "/v1/workload/health") return jsonResponse(healthy());
      if (path === "/v1/demo/stop") {
        return jsonResponse({ status: "stopped" });
      }
      if (path === "/v1/demo/ensure") return jsonResponse(safeState());
      if (path === "/v1/actions/execute") {
        return jsonResponse(recovery());
      }
      throw new Error(`Unexpected route ${path}`);
    };
    const adapter = new LinuxSandboxAdapter({ token: TOKEN, fetch: fakeFetch });

    await adapter.inspectSafeState();
    await adapter.readSafeLogTail();
    await adapter.checkHealthOnce();
    await adapter.stopDemoService();
    await adapter.ensureDemoService();
    await adapter.executeRecoveryAction(recoveryRequest());

    expect(calls.map((call) => call.url)).toEqual([
      `${ORIGIN}/v1/workload/state`,
      `${ORIGIN}/v1/workload/logs`,
      `${ORIGIN}/v1/workload/health`,
      `${ORIGIN}/v1/demo/stop`,
      `${ORIGIN}/v1/demo/ensure`,
      `${ORIGIN}/v1/actions/execute`,
    ]);
    for (const call of calls) {
      expect(call.init).toMatchObject({
        cache: "no-store",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
      });
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(calls.map((call) => call.init.method)).toEqual([
      "GET",
      "GET",
      "GET",
      "POST",
      "POST",
      "POST",
    ]);
    expect(calls[3]?.init.body).toBe(
      JSON.stringify({ kind: "STOP_DEMO_SERVICE_V1" }),
    );
    expect(calls[4]?.init.body).toBe(
      JSON.stringify({ kind: "ENSURE_DEMO_SERVICE_V1" }),
    );
    expect(calls[5]?.init.body).toBe(JSON.stringify(recoveryRequest()));
  });

  it("aborts a request after the fixed two-second timeout", async () => {
    const fakeFetch: SandboxAgentFetch = async (_url, init) =>
      await new Promise((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("timed out", "AbortError")),
          { once: true },
        );
      });
    const adapter = new LinuxSandboxAdapter({ token: TOKEN, fetch: fakeFetch });
    const startedAt = Date.now();

    await expect(adapter.inspectSafeState()).rejects.toThrow(
      "Sandbox agent request failed",
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_900);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  }, 4_000);

  it("rejects an unknown recovery request before fetch", async () => {
    const fakeFetch = vi.fn<SandboxAgentFetch>();
    const adapter = new LinuxSandboxAdapter({ token: TOKEN, fetch: fakeFetch });

    await expect(
      adapter.executeRecoveryAction({
        actionId: "restart_everything",
        workloadId: DEMO_WORKLOAD_ID,
        executionId: "unknown-action",
      }),
    ).rejects.toThrow();
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("rejects duplicate execution IDs locally before the second POST", async () => {
    const fakeFetch = vi.fn<SandboxAgentFetch>(async () =>
      jsonResponse(recovery()),
    );
    const adapter = new LinuxSandboxAdapter({ token: TOKEN, fetch: fakeFetch });

    await adapter.executeRecoveryAction(recoveryRequest("same-execution"));
    await expect(
      adapter.executeRecoveryAction(recoveryRequest("same-execution")),
    ).rejects.toThrow("Duplicate recovery execution rejected");
    expect(fakeFetch).toHaveBeenCalledOnce();
  });
});

describe("LinuxSandboxAdapter strict responses", () => {
  const invalidCases: Array<{
    name: string;
    payload: unknown;
    invoke(adapter: LinuxSandboxAdapter): Promise<unknown>;
  }> = [
    {
      name: "extra response keys",
      payload: safeState({ secret: "must-not-cross" }),
      invoke: (adapter) => adapter.inspectSafeState(),
    },
    {
      name: "wrong demo label",
      payload: safeState({ demoLabel: "another-workload" }),
      invoke: (adapter) => adapter.inspectSafeState(),
    },
    {
      name: "wrong service identity",
      payload: healthy({ service: "another-service" }),
      invoke: (adapter) => adapter.checkHealthOnce(),
    },
    {
      name: "negative times",
      payload: healthy({ requestStartedAt: -1 }),
      invoke: (adapter) => adapter.checkHealthOnce(),
    },
    {
      name: "excessive logs",
      payload: safeLogs({
        lines: Array.from({ length: 31 }, () => "log"),
        lineCount: 31,
        characterCount: 123,
      }),
      invoke: (adapter) => adapter.readSafeLogTail(),
    },
    {
      name: "embedded log newlines",
      payload: safeLogs({
        lines: [Array.from({ length: 31 }, () => "hidden").join("\n")],
        lineCount: 1,
        characterCount: 216,
      }),
      invoke: (adapter) => adapter.readSafeLogTail(),
    },
    {
      name: "unknown command label",
      payload: recovery({ commandLabel: "run an arbitrary command" }),
      invoke: (adapter) =>
        adapter.executeRecoveryAction(recoveryRequest("wrong-label")),
    },
    {
      name: "nonzero successful exit code",
      payload: recovery({ exitCode: 1 }),
      invoke: (adapter) =>
        adapter.executeRecoveryAction(recoveryRequest("wrong-exit")),
    },
  ];

  for (const invalidCase of invalidCases) {
    it(`rejects ${invalidCase.name}`, async () => {
      const adapter = new LinuxSandboxAdapter({
        token: TOKEN,
        fetch: async () => jsonResponse(invalidCase.payload),
      });

      await expect(invalidCase.invoke(adapter)).rejects.toThrow();
    });
  }

  it("sanitizes agent log output again on the runner", async () => {
    const raw = `RUNNER_TOKEN=runner-secret\n\u001b[31m${"x".repeat(380)}`;
    const adapter = new LinuxSandboxAdapter({
      token: TOKEN,
      fetch: async () =>
        jsonResponse({
          lines: raw.split("\n"),
          lineCount: 2,
          characterCount: Array.from(raw).length,
          truncated: false,
        }),
    });

    const logs = await adapter.readSafeLogTail();

    expect(logs.lines.join("\n")).not.toContain("runner-secret");
    expect(logs.lines.join("\n")).not.toContain("\u001b");
    expect(logs.characterCount).toBeLessThanOrEqual(4_000);
    expect(logs.lineCount).toBe(logs.lines.length);
    expect(logs.truncated).toBe(false);
  });
});

describe("LinuxSandboxAdapter fresh health verification", () => {
  it("retries stale success until evidence starts at or after notBefore", async () => {
    const responses = [healthy({ requestStartedAt: 90 }), healthy({ requestStartedAt: 100 })];
    const sleep = vi.fn(async () => undefined);
    const adapter = new LinuxSandboxAdapter({
      token: TOKEN,
      fetch: async () => jsonResponse(responses.shift()),
      now: () => 100,
      sleep,
    });

    const evidence = await adapter.verifyFreshHealth(100);

    expect(evidence.healthy).toBe(true);
    expect(evidence.requestStartedAt).toBe(100);
    expect(evidence.attempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("stops an in-flight verification when aborted", async () => {
    const fakeFetch: SandboxAgentFetch = async (_url, init) =>
      await new Promise((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      });
    const adapter = new LinuxSandboxAdapter({ token: TOKEN, fetch: fakeFetch });
    const controller = new AbortController();

    const verification = adapter.verifyFreshHealth(0, controller.signal);
    controller.abort();

    await expect(verification).rejects.toMatchObject({ name: "AbortError" });
  });

  it("ends an in-flight health request when the whole verification deadline fires", async () => {
    const deadline = new AbortController();
    const fakeFetch: SandboxAgentFetch = async (_url, init) =>
      await new Promise((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("deadline", "TimeoutError")),
          { once: true },
        );
      });
    const adapter = new LinuxSandboxAdapter({
      token: TOKEN,
      fetch: fakeFetch,
      createTimeoutSignal: (milliseconds) =>
        milliseconds === 10_000
          ? deadline.signal
          : new AbortController().signal,
    });

    const verification = adapter.verifyFreshHealth(0);
    deadline.abort(new DOMException("deadline", "TimeoutError"));

    await expect(verification).resolves.toMatchObject({
      healthy: false,
      attempts: 1,
    });
  });
});
