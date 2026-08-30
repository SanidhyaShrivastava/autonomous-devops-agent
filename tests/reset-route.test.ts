import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const serverMock = vi.hoisted(() => ({
  requestDemoRun: vi.fn(),
}));

vi.mock("@/lib/server/convex", () => ({
  requestDemoRun: serverMock.requestDemoRun,
}));

import { POST } from "@/app/api/demo/reset/route";

const APP_ORIGIN = "https://autonomous-devops-agent.vercel.app";
const DEMO_REQUEST_SECRET = "test-only-demo-request-secret";

type RequestOptions = {
  body?: BodyInit;
  contentLength?: string;
  contentType?: string;
  origin?: string | null;
};

function resetRequest(options: RequestOptions = {}) {
  const headers = new Headers();
  const origin = options.origin === undefined ? APP_ORIGIN : options.origin;

  if (origin !== null) {
    headers.set("Origin", origin);
  }

  if (options.contentType !== undefined) {
    headers.set("Content-Type", options.contentType);
  }

  if (options.contentLength !== undefined) {
    headers.set("Content-Length", options.contentLength);
  }

  return new Request(`${APP_ORIGIN}/api/demo/reset`, {
    body: options.body,
    headers,
    method: "POST",
  });
}

async function readJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe("POST /api/demo/reset", () => {
  beforeEach(() => {
    vi.stubEnv("PUBLIC_APP_URL", APP_ORIGIN);
    vi.stubEnv("DEMO_REQUEST_SECRET", DEMO_REQUEST_SECRET);
    serverMock.requestDemoRun.mockReset();
    serverMock.requestDemoRun.mockResolvedValue({
      demoCommandId: "demo-command-123",
      status: "accepted",
    });
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("accepts only the exact configured Origin with no body and no Content-Type", async () => {
    const response = await POST(resetRequest());
    const responseText = await response.text();

    expect(response.status).toBe(202);
    expect(JSON.parse(responseText)).toMatchObject({
      demoCommandId: "demo-command-123",
    });
    expect(serverMock.requestDemoRun).toHaveBeenCalledOnce();
    expect(serverMock.requestDemoRun).toHaveBeenCalledWith({
      requestSecret: DEMO_REQUEST_SECRET,
    });
    expect(responseText).not.toContain(DEMO_REQUEST_SECRET);
  });

  it.each([
    ["missing", null],
    ["opaque null", "null"],
    ["prefix lookalike", `${APP_ORIGIN}.attacker.example`],
    ["subdomain", "https://child.autonomous-devops-agent.vercel.app"],
    ["hyphen lookalike", "https://autonomous-devops-agent-vercel.app"],
    ["wrong scheme", "http://autonomous-devops-agent.vercel.app"],
    ["trailing slash", `${APP_ORIGIN}/`],
  ])("rejects a %s Origin", async (_label, origin) => {
    const response = await POST(resetRequest({ origin }));

    expect(response.status).toBe(403);
    expect(serverMock.requestDemoRun).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(DEMO_REQUEST_SECRET);
  });

  it.each([
    "application/json",
    "application/json; charset=utf-8",
    "text/plain",
    "application/x-www-form-urlencoded",
  ])("rejects the Content-Type header %s, even with a zero-byte body", async (contentType) => {
    const response = await POST(resetRequest({ contentType }));

    expect(response.status).toBe(415);
    expect(serverMock.requestDemoRun).not.toHaveBeenCalled();
  });

  it.each([
    ["JSON", new TextEncoder().encode("{}")],
    ["whitespace", new TextEncoder().encode("   ")],
    ["one null byte", new Uint8Array([0])],
  ])("rejects a non-empty %s body when Content-Type is absent", async (_label, body) => {
    const response = await POST(resetRequest({ body }));

    expect(response.status).toBe(400);
    expect(serverMock.requestDemoRun).not.toHaveBeenCalled();
  });

  it("checks the real body instead of trusting a forged zero Content-Length", async () => {
    const response = await POST(
      resetRequest({
        body: new TextEncoder().encode("{}"),
        contentLength: "0",
      }),
    );

    expect(response.status).toBe(400);
    expect(serverMock.requestDemoRun).not.toHaveBeenCalled();
  });

  it.each([
    ["active", 409],
    ["cooldown", 429],
    ["daily_cap", 429],
    ["runner_offline", 503],
  ] as const)("maps the backend %s result to HTTP %i", async (status, expectedHttpStatus) => {
    serverMock.requestDemoRun.mockResolvedValue({ status });

    const response = await POST(resetRequest());
    const responseText = await response.text();

    expect(response.status).toBe(expectedHttpStatus);
    expect(responseText).not.toContain(DEMO_REQUEST_SECRET);
  });

  it("returns a generic error instead of a raw Convex error", async () => {
    const rawError =
      "Convex failed: RUNNER_TOKEN=runner-secret and stack /internal/path";
    serverMock.requestDemoRun.mockRejectedValue(new Error(rawError));

    const response = await POST(resetRequest());
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(responseText).not.toContain(rawError);
    expect(responseText).not.toContain("runner-secret");
    expect(responseText).not.toContain(DEMO_REQUEST_SECRET);
  });

  it("does not leak the secret in any expected backend response", async () => {
    for (const backendResult of [
      { demoCommandId: "demo-command-123", status: "accepted" },
      { status: "active" },
      { status: "cooldown" },
      { status: "daily_cap" },
      { status: "runner_offline" },
    ]) {
      serverMock.requestDemoRun.mockResolvedValueOnce(backendResult);
      const response = await POST(resetRequest());

      expect(await response.text()).not.toContain(DEMO_REQUEST_SECRET);
    }
  });

  it("returns a generic error when server-only configuration is missing", async () => {
    vi.stubEnv("DEMO_REQUEST_SECRET", "");

    const response = await POST(resetRequest());
    const responseBody = await readJson(response);

    expect(response.status).toBe(500);
    expect(responseBody).not.toHaveProperty("requestSecret");
    expect(serverMock.requestDemoRun).not.toHaveBeenCalled();
  });
});
