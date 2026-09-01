import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const serverMock = vi.hoisted(() => ({
  decideDemoApproval: vi.fn(),
  getDemoApprovalSession: vi.fn(),
  requestDemoRun: vi.fn(),
}));

vi.mock("@/lib/server/convex", () => ({
  decideDemoApproval: serverMock.decideDemoApproval,
  getDemoApprovalSession: serverMock.getDemoApprovalSession,
  requestDemoRun: serverMock.requestDemoRun,
}));

import { POST as approve } from "@/app/api/demo/approval/approve/route";
import { POST as reject } from "@/app/api/demo/approval/reject/route";
import { GET as session } from "@/app/api/demo/approval/session/route";
import { POST as startApprovalRun } from "@/app/api/demo/reset/approval-required/route";
import {
  DEMO_APPROVAL_COOKIE_NAME,
  createDemoApprovalCapability,
  deriveDemoApprovalDigest,
  encodeDemoApprovalCookie,
  parseDemoApprovalCookie,
} from "@/lib/server/demo-approval";

const APP_ORIGIN = "https://autonomous-devops-agent.vercel.app";
const DEMO_REQUEST_SECRET = "test-only-demo-request-secret";
const DEMO_COMMAND_ID = "j97demo_command_123";
const COMMAND_QUEUE_WINDOW_MS = 90_000;
const ACTIVE_PRE_GATE_WINDOW_MS = 45_000;
const APPROVAL_WINDOW_MS = 300_000;

type RequestOptions = {
  body?: BodyInit;
  contentLength?: string;
  contentType?: string;
  cookie?: string;
  origin?: string | null;
};

function routeRequest(path: string, options: RequestOptions = {}) {
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
  if (options.cookie !== undefined) {
    headers.set("Cookie", options.cookie);
  }
  return new Request(`${APP_ORIGIN}${path}`, {
    body: options.body,
    headers,
    method: "POST",
  });
}

function sessionRequest(cookie?: string) {
  const headers = new Headers();
  if (cookie !== undefined) {
    headers.set("Cookie", cookie);
  }
  return new Request(`${APP_ORIGIN}/api/demo/approval/session`, { headers });
}

function cookiePair(setCookie: string) {
  return setCookie.split(";", 1)[0] ?? "";
}

function cookieValue(setCookie: string) {
  return cookiePair(setCookie).slice(`${DEMO_APPROVAL_COOKIE_NAME}=`.length);
}

afterEach(() => vi.useRealTimers());

describe("demo approval capability", () => {
  it("uses 256 random bits and a deterministic 64-character HMAC digest", () => {
    const first = createDemoApprovalCapability(DEMO_REQUEST_SECRET);
    const second = createDemoApprovalCapability(DEMO_REQUEST_SECRET);

    expect(Buffer.from(first.token, "base64url")).toHaveLength(32);
    expect(first.token).not.toBe(second.token);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.digest).toBe(
      deriveDemoApprovalDigest(first.token, DEMO_REQUEST_SECRET),
    );
    expect(first.digest).not.toContain(first.token);
    expect(first.digest).not.toContain(DEMO_REQUEST_SECRET);
  });

  it("round-trips only a bounded command ID and exact 256-bit token", () => {
    const { token } = createDemoApprovalCapability(DEMO_REQUEST_SECRET);
    const encoded = encodeDemoApprovalCookie(DEMO_COMMAND_ID, token);

    expect(parseDemoApprovalCookie(encoded)).toEqual({
      demoCommandId: DEMO_COMMAND_ID,
      token,
    });
    for (const malformed of [
      "",
      token,
      `v2.${DEMO_COMMAND_ID}.${token}`,
      `v1.${DEMO_COMMAND_ID}.short`,
      `v1.command.with.dot.${token}`,
      `v1.${"x".repeat(129)}.${token}`,
    ]) {
      expect(parseDemoApprovalCookie(malformed)).toBeNull();
    }
  });
});

describe("POST /api/demo/reset/approval-required", () => {
  beforeEach(() => {
    vi.stubEnv("PUBLIC_APP_URL", APP_ORIGIN);
    vi.stubEnv("DEMO_REQUEST_SECRET", DEMO_REQUEST_SECRET);
    serverMock.requestDemoRun.mockReset();
    serverMock.requestDemoRun.mockResolvedValue({
      demoCommandId: DEMO_COMMAND_ID,
      status: "accepted",
    });
  });

  afterAll(() => vi.unstubAllEnvs());

  it("starts only the fixed approval mode and stores the raw token only in a hardened cookie", async () => {
    const response = await startApprovalRun(
      routeRequest("/api/demo/reset/approval-required"),
    );
    const responseText = await response.text();
    const setCookie = response.headers.get("set-cookie") ?? "";
    const parsedCookie = parseDemoApprovalCookie(cookieValue(setCookie));

    expect(response.status).toBe(202);
    expect(JSON.parse(responseText)).toEqual({ demoCommandId: DEMO_COMMAND_ID });
    expect(setCookie).toContain(`${DEMO_APPROVAL_COOKIE_NAME}=`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/api\/demo\/approval/i);
    expect(setCookie).toMatch(/Max-Age=480/i);
    expect(parsedCookie?.demoCommandId).toBe(DEMO_COMMAND_ID);
    expect(Buffer.from(parsedCookie?.token ?? "", "base64url")).toHaveLength(32);
    expect(serverMock.requestDemoRun).toHaveBeenCalledWith({
      requestSecret: DEMO_REQUEST_SECRET,
      executionMode: "approval_required",
      approvalCapabilityDigest: deriveDemoApprovalDigest(
        parsedCookie?.token ?? "",
        DEMO_REQUEST_SECRET,
      ),
    });
    expect(responseText).not.toContain(parsedCookie?.token ?? "impossible");
    expect(responseText).not.toContain(DEMO_REQUEST_SECRET);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps a late-created gate decidable through the full Convex approval window", async () => {
    vi.useFakeTimers();
    const requestedAt = Date.UTC(2026, 8, 1, 12, 0, 0);
    vi.setSystemTime(requestedAt);
    const startResponse = await startApprovalRun(
      routeRequest("/api/demo/reset/approval-required"),
    );
    const setCookie = startResponse.headers.get("set-cookie") ?? "";
    const maxAgeSeconds = Number(/Max-Age=(\d+)/i.exec(setCookie)?.[1]);
    const latestGateCreatedAt =
      requestedAt + COMMAND_QUEUE_WINDOW_MS + ACTIVE_PRE_GATE_WINDOW_MS;
    const convexApprovalExpiresAt = latestGateCreatedAt + APPROVAL_WINDOW_MS;

    expect(requestedAt + maxAgeSeconds * 1_000).toBeGreaterThanOrEqual(
      convexApprovalExpiresAt,
    );

    vi.setSystemTime(convexApprovalExpiresAt - 1);
    serverMock.getDemoApprovalSession.mockResolvedValue({
      demoCommandId: DEMO_COMMAND_ID,
      incidentId: "incident_1",
      status: "pending",
      expiresAt: convexApprovalExpiresAt,
      decidedAt: null,
    });
    serverMock.decideDemoApproval.mockResolvedValue({
      demoCommandId: DEMO_COMMAND_ID,
      incidentId: "incident_1",
      recoveryCommandId: "recovery_1",
      status: "approved",
      decidedAt: convexApprovalExpiresAt - 1,
    });

    const decisionResponse = await approve(
      routeRequest("/api/demo/approval/approve", {
        cookie: cookiePair(setCookie),
      }),
    );
    expect(decisionResponse.status).toBe(200);
  });

  it.each([
    ["missing", null],
    ["opaque null", "null"],
    ["prefix lookalike", `${APP_ORIGIN}.attacker.example`],
    ["wrong scheme", "http://autonomous-devops-agent.vercel.app"],
  ])("rejects a %s Origin before creating a capability-backed run", async (_name, origin) => {
    const response = await startApprovalRun(
      routeRequest("/api/demo/reset/approval-required", { origin }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(serverMock.requestDemoRun).not.toHaveBeenCalled();
  });

  it.each(["application/json", "text/plain"])(
    "rejects the Content-Type header %s even with no body",
    async (contentType) => {
      const response = await startApprovalRun(
        routeRequest("/api/demo/reset/approval-required", { contentType }),
      );
      expect(response.status).toBe(415);
      expect(serverMock.requestDemoRun).not.toHaveBeenCalled();
    },
  );

  it("rejects a real body even when Content-Length claims zero", async () => {
    const response = await startApprovalRun(
      routeRequest("/api/demo/reset/approval-required", {
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
    ["environment_recovery_pending", 503],
    ["disabled", 503],
  ] as const)("maps %s safely and sets no cookie", async (status, expectedStatus) => {
    serverMock.requestDemoRun.mockResolvedValue({ status });
    const response = await startApprovalRun(
      routeRequest("/api/demo/reset/approval-required"),
    );
    expect(response.status).toBe(expectedStatus);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).not.toContain(DEMO_REQUEST_SECRET);
  });
});

describe("bodyless approval decisions", () => {
  let approvalCookie: string;

  beforeEach(() => {
    vi.stubEnv("PUBLIC_APP_URL", APP_ORIGIN);
    vi.stubEnv("DEMO_REQUEST_SECRET", DEMO_REQUEST_SECRET);
    serverMock.decideDemoApproval.mockReset();
    serverMock.getDemoApprovalSession.mockReset();
    const capability = createDemoApprovalCapability(DEMO_REQUEST_SECRET);
    approvalCookie = `${DEMO_APPROVAL_COOKIE_NAME}=${encodeDemoApprovalCookie(
      DEMO_COMMAND_ID,
      capability.token,
    )}`;
    serverMock.getDemoApprovalSession.mockResolvedValue({
      demoCommandId: DEMO_COMMAND_ID,
      incidentId: "incident_1",
      status: "pending",
      expiresAt: 1_788_198_300_000,
      decidedAt: null,
    });
  });

  it.each([
    ["approve", approve, "approved"],
    ["reject", reject, "rejected"],
  ] as const)("sends only the capability digest for %s", async (name, handler, decision) => {
    serverMock.decideDemoApproval.mockResolvedValue({
      demoCommandId: DEMO_COMMAND_ID,
      incidentId: "incident_1",
      recoveryCommandId: "recovery_1",
      status: decision,
      decidedAt: 1_788_198_000_000,
    });
    const parsed = parseDemoApprovalCookie(approvalCookie.split("=")[1] ?? "");

    const response = await handler(
      routeRequest(`/api/demo/approval/${name}`, { cookie: approvalCookie }),
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      demoCommandId: DEMO_COMMAND_ID,
      status: decision,
      decidedAt: 1_788_198_000_000,
    });
    expect(serverMock.decideDemoApproval).toHaveBeenCalledWith({
      requestSecret: DEMO_REQUEST_SECRET,
      approvalCapabilityDigest: deriveDemoApprovalDigest(
        parsed?.token ?? "",
        DEMO_REQUEST_SECRET,
      ),
      decision,
    });
    expect(text).not.toContain(parsed?.token ?? "impossible");
    expect(text).not.toContain(DEMO_REQUEST_SECRET);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["missing", undefined],
    ["malformed", `${DEMO_APPROVAL_COOKIE_NAME}=not-a-capability`],
  ])("rejects a %s capability generically", async (_name, cookie) => {
    const response = await approve(
      routeRequest("/api/demo/approval/approve", { cookie }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Approval decision unavailable",
    });
    expect(serverMock.decideDemoApproval).not.toHaveBeenCalled();
  });

  it("rejects cross-site, typed, and nonempty decision requests before mutation", async () => {
    for (const options of [
      { cookie: approvalCookie, origin: "https://attacker.example" },
      { cookie: approvalCookie, contentType: "application/json" },
      { cookie: approvalCookie, body: new TextEncoder().encode("{}") },
    ]) {
      const response = await approve(
        routeRequest("/api/demo/approval/approve", options),
      );
      expect([400, 403, 415]).toContain(response.status);
    }
    expect(serverMock.decideDemoApproval).not.toHaveBeenCalled();
  });

  it.each([
    ["unavailable", 409],
    ["runner_offline", 503],
  ] as const)("maps backend %s without exposing capability details", async (status, httpStatus) => {
    serverMock.decideDemoApproval.mockResolvedValue({ status });
    const response = await approve(
      routeRequest("/api/demo/approval/approve", { cookie: approvalCookie }),
    );
    const text = await response.text();
    expect(response.status).toBe(httpStatus);
    expect(text).not.toContain(DEMO_REQUEST_SECRET);
    expect(text).not.toContain(approvalCookie);
  });

  it("rejects a cookie whose command ID does not match its bound capability before mutation", async () => {
    serverMock.getDemoApprovalSession.mockResolvedValue({
      demoCommandId: "another_command",
      incidentId: "incident_2",
      status: "pending",
      expiresAt: 1_788_198_300_000,
      decidedAt: null,
    });

    const response = await approve(
      routeRequest("/api/demo/approval/approve", { cookie: approvalCookie }),
    );

    expect(response.status).toBe(409);
    expect(serverMock.decideDemoApproval).not.toHaveBeenCalled();
  });
});

describe("GET /api/demo/approval/session", () => {
  let rawToken: string;
  let approvalCookie: string;

  beforeEach(() => {
    vi.stubEnv("DEMO_REQUEST_SECRET", DEMO_REQUEST_SECRET);
    serverMock.getDemoApprovalSession.mockReset();
    rawToken = createDemoApprovalCapability(DEMO_REQUEST_SECRET).token;
    approvalCookie = `${DEMO_APPROVAL_COOKIE_NAME}=${encodeDemoApprovalCookie(
      DEMO_COMMAND_ID,
      rawToken,
    )}`;
  });

  it("returns a safe owner session without returning its capability", async () => {
    serverMock.getDemoApprovalSession.mockResolvedValue({
      demoCommandId: DEMO_COMMAND_ID,
      incidentId: "incident_1",
      status: "pending",
      expiresAt: 1_788_198_300_000,
      decidedAt: null,
    });

    const response = await session(sessionRequest(approvalCookie));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      canDecide: true,
      demoCommandId: DEMO_COMMAND_ID,
      status: "pending",
      expiresAt: 1_788_198_300_000,
      decidedAt: null,
    });
    expect(serverMock.getDemoApprovalSession).toHaveBeenCalledWith({
      requestSecret: DEMO_REQUEST_SECRET,
      approvalCapabilityDigest: deriveDemoApprovalDigest(
        rawToken,
        DEMO_REQUEST_SECRET,
      ),
    });
    expect(text).not.toContain(rawToken);
    expect(text).not.toContain(DEMO_REQUEST_SECRET);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["missing", undefined],
    ["malformed", `${DEMO_APPROVAL_COOKIE_NAME}=malformed`],
  ])("returns the same spectator response for a %s capability", async (_name, cookie) => {
    const response = await session(sessionRequest(cookie));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ canDecide: false });
    expect(serverMock.getDemoApprovalSession).not.toHaveBeenCalled();
  });

  it("fails closed if the digest resolves to a different command", async () => {
    serverMock.getDemoApprovalSession.mockResolvedValue({
      demoCommandId: "another_command",
      incidentId: "incident_2",
      status: "pending",
      expiresAt: 1_788_198_300_000,
      decidedAt: null,
    });
    const response = await session(sessionRequest(approvalCookie));
    expect(await response.json()).toEqual({ canDecide: false });
  });
});
