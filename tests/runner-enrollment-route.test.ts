import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serverMock = vi.hoisted(() => ({
  pairRunner: vi.fn(),
  recordRunnerHeartbeat: vi.fn(),
}));

vi.mock("@/lib/server/runner-enrollment", () => ({
  pairRunner: serverMock.pairRunner,
  recordRunnerHeartbeat: serverMock.recordRunnerHeartbeat,
}));

import { POST as pair } from "@/app/api/runners/pair/route";
import { POST as heartbeat } from "@/app/api/runners/heartbeat/route";

const APP_ORIGIN = "https://autonomous-devops-agent.vercel.app";
const PAIRING_CODE = `gxpair_${"a".repeat(43)}`;
const RUNNER_CREDENTIAL = `gxrun_${"b".repeat(43)}`;

function jsonRequest(path: string, body: unknown, headers?: HeadersInit) {
  return new Request(`${APP_ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("runner enrollment routes", () => {
  beforeEach(() => {
    serverMock.pairRunner.mockReset();
    serverMock.recordRunnerHeartbeat.mockReset();
    serverMock.pairRunner.mockImplementation(
      async (args: { runnerId: string }) => ({
        label: "staging-web-1",
        runnerId: args.runnerId,
        status: "paired",
      }),
    );
    serverMock.recordRunnerHeartbeat.mockResolvedValue({ status: "accepted" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pairs from strict JSON and returns a new credential exactly once", async () => {
    const response = await pair(
      jsonRequest("/api/runners/pair", {
        agentVersion: "0.1.0",
        architecture: "arm64",
        pairingCode: PAIRING_CODE,
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.runnerId).toMatch(/^gxr_[A-Za-z0-9_-]{24}$/);
    expect(body.credential).toMatch(/^gxrun_[A-Za-z0-9_-]{43}$/);
    expect(body.heartbeatIntervalMs).toBe(2_000);

    const call = serverMock.pairRunner.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(call.codeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(call.credentialDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(call).not.toHaveProperty("pairingCode");
    expect(JSON.stringify(call)).not.toContain(PAIRING_CODE);
    expect(JSON.stringify(body)).not.toContain(PAIRING_CODE);
  });

  it.each([
    ["missing content type", new Request(`${APP_ORIGIN}/api/runners/pair`, { method: "POST", body: "{}" }), 415],
    [
      "JSON lookalike content type",
      new Request(`${APP_ORIGIN}/api/runners/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/jsonp" },
        body: JSON.stringify({
          agentVersion: "0.1.0",
          architecture: "arm64",
          pairingCode: PAIRING_CODE,
        }),
      }),
      415,
    ],
    [
      "unknown field",
      jsonRequest("/api/runners/pair", {
        agentVersion: "0.1.0",
        architecture: "arm64",
        pairingCode: PAIRING_CODE,
        command: "whoami",
      }),
      400,
    ],
    [
      "malformed code",
      jsonRequest("/api/runners/pair", {
        agentVersion: "0.1.0",
        architecture: "arm64",
        pairingCode: "short",
      }),
      400,
    ],
    [
      "oversized body",
      jsonRequest("/api/runners/pair", {
        agentVersion: "0.1.0",
        architecture: "arm64",
        pairingCode: PAIRING_CODE,
        padding: "x".repeat(4_096),
      }),
      413,
    ],
  ])("rejects %s before contacting Convex", async (_label, request, status) => {
    const response = await pair(request);

    expect(response.status).toBe(status);
    expect(serverMock.pairRunner).not.toHaveBeenCalled();
  });

  it("cancels a streamed request as soon as its real bytes exceed the cap", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(3_000)));
        controller.enqueue(new TextEncoder().encode("x".repeat(3_000)));
      },
      cancel,
    });
    const request = new Request(`${APP_ORIGIN}/api/runners/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await pair(request);

    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(serverMock.pairRunner).not.toHaveBeenCalled();
  });

  it("throttles repeated pairing guesses before they reach Convex", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await pair(
        jsonRequest(
          "/api/runners/pair",
          {
            agentVersion: "0.1.0",
            architecture: "arm64",
            pairingCode: PAIRING_CODE,
          },
          { "x-forwarded-for": "203.0.113.55" },
        ),
      );
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(statuses[10]).toBe(429);
    expect(serverMock.pairRunner).toHaveBeenCalledTimes(10);
  });

  it("uses one generic response for an unknown, expired, or reused code", async () => {
    serverMock.pairRunner.mockResolvedValue({ status: "unavailable" });

    const response = await pair(
      jsonRequest("/api/runners/pair", {
        agentVersion: "0.1.0",
        architecture: "x64",
        pairingCode: PAIRING_CODE,
      }),
    );
    const text = await response.text();

    expect(response.status).toBe(401);
    expect(text).toContain("Pairing failed");
    expect(text).not.toContain(PAIRING_CODE);
    expect(text).not.toMatch(/expired|reused|unknown/i);
  });

  it("records a heartbeat using only a credential digest", async () => {
    const response = await heartbeat(
      jsonRequest(
        "/api/runners/heartbeat",
        { agentVersion: "0.1.0", runnerId: "gxr_abcdefghijklmnopqrstuvwx" },
        { Authorization: `Bearer ${RUNNER_CREDENTIAL}` },
      ),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const call = serverMock.recordRunnerHeartbeat.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(call.credentialDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(call).not.toHaveProperty("credential");
    expect(JSON.stringify(call)).not.toContain(RUNNER_CREDENTIAL);
  });

  it.each([
    ["missing bearer", {}, 401],
    ["wrong bearer shape", { Authorization: "Basic value" }, 401],
  ])("rejects a %s without contacting Convex", async (_label, headers, status) => {
    const response = await heartbeat(
      jsonRequest(
        "/api/runners/heartbeat",
        { agentVersion: "0.1.0", runnerId: "gxr_abcdefghijklmnopqrstuvwx" },
        headers,
      ),
    );

    expect(response.status).toBe(status);
    expect(serverMock.recordRunnerHeartbeat).not.toHaveBeenCalled();
  });

  it("does not reveal whether a heartbeat runner or credential was wrong", async () => {
    serverMock.recordRunnerHeartbeat.mockResolvedValue({
      status: "unavailable",
    });

    const response = await heartbeat(
      jsonRequest(
        "/api/runners/heartbeat",
        { agentVersion: "0.1.0", runnerId: "gxr_abcdefghijklmnopqrstuvwx" },
        { Authorization: `Bearer ${RUNNER_CREDENTIAL}` },
      ),
    );
    const text = await response.text();

    expect(response.status).toBe(401);
    expect(text).toContain("Runner authentication failed");
    expect(text).not.toContain(RUNNER_CREDENTIAL);
    expect(text).not.toMatch(/credential|runner not found/i);
  });
});
