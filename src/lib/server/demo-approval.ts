import "server-only";

import { createHmac, randomBytes } from "node:crypto";

import {
  decideDemoApproval,
  getDemoApprovalSession,
} from "@/lib/server/convex";

export const DEMO_APPROVAL_COOKIE_NAME = "gx_demo_approval";
export const DEMO_APPROVAL_COOKIE_PATH = "/api/demo/approval";
// Covers the 90-second queue window, 45-second pre-gate run deadline, and the
// full five-minute approval window, with 45 seconds of scheduling margin.
export const DEMO_APPROVAL_COOKIE_MAX_AGE_SECONDS = 8 * 60;

const APPROVAL_DIGEST_DOMAIN = "gx-demo-approval-v1";
const CAPABILITY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEMO_COMMAND_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface DemoApprovalCookie {
  readonly demoCommandId: string;
  readonly token: string;
}

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function requiredPublicAppOrigin() {
  const configuredUrl = process.env.PUBLIC_APP_URL;
  if (!configuredUrl) {
    throw new Error("Server configuration unavailable");
  }
  return new URL(configuredUrl).origin;
}

export function requiredDemoRequestSecret() {
  const secret = process.env.DEMO_REQUEST_SECRET;
  if (!secret) {
    throw new Error("Server configuration unavailable");
  }
  return secret;
}

function isExactCapabilityToken(token: string) {
  if (!CAPABILITY_TOKEN_PATTERN.test(token)) {
    return false;
  }
  try {
    return Buffer.from(token, "base64url").byteLength === 32;
  } catch {
    return false;
  }
}

export function deriveDemoApprovalDigest(token: string, secret: string) {
  if (!isExactCapabilityToken(token) || !secret) {
    throw new Error("Approval capability is unavailable");
  }
  return createHmac("sha256", secret)
    .update(APPROVAL_DIGEST_DOMAIN)
    .update("\0")
    .update(token)
    .digest("hex");
}

export function createDemoApprovalCapability(secret: string) {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    digest: deriveDemoApprovalDigest(token, secret),
  };
}

export function encodeDemoApprovalCookie(
  demoCommandId: string,
  token: string,
) {
  if (!DEMO_COMMAND_ID_PATTERN.test(demoCommandId) || !isExactCapabilityToken(token)) {
    throw new Error("Approval capability is unavailable");
  }
  return `v1.${demoCommandId}.${token}`;
}

export function parseDemoApprovalCookie(
  value: string | null | undefined,
): DemoApprovalCookie | null {
  if (!value) {
    return null;
  }
  const pieces = value.split(".");
  if (pieces.length !== 3 || pieces[0] !== "v1") {
    return null;
  }
  const demoCommandId = pieces[1] ?? "";
  const token = pieces[2] ?? "";
  if (!DEMO_COMMAND_ID_PATTERN.test(demoCommandId) || !isExactCapabilityToken(token)) {
    return null;
  }
  return { demoCommandId, token };
}

export function readDemoApprovalCookie(request: Request) {
  const header = request.headers.get("cookie");
  if (!header) {
    return null;
  }
  const matchingValues = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${DEMO_APPROVAL_COOKIE_NAME}=`))
    .map((part) => part.slice(`${DEMO_APPROVAL_COOKIE_NAME}=`.length));
  if (matchingValues.length !== 1) {
    return null;
  }
  return parseDemoApprovalCookie(matchingValues[0]);
}

export function serializeDemoApprovalCookie(value: string) {
  if (!parseDemoApprovalCookie(value)) {
    throw new Error("Approval capability is unavailable");
  }
  return [
    `${DEMO_APPROVAL_COOKIE_NAME}=${value}`,
    `Max-Age=${DEMO_APPROVAL_COOKIE_MAX_AGE_SECONDS}`,
    `Path=${DEMO_APPROVAL_COOKIE_PATH}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

export async function validateBodylessSameOriginPost(request: Request) {
  if (request.headers.get("origin") !== requiredPublicAppOrigin()) {
    return json({ error: "Forbidden" }, 403);
  }
  if (request.headers.has("content-type")) {
    return json({ error: "Content type is not accepted" }, 415);
  }
  if (!request.body) {
    return null;
  }

  const reader = request.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return null;
      }
      if (chunk.value.byteLength > 0) {
        return json({ error: "Request body must be empty" }, 400);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function handleDemoApprovalDecision(
  request: Request,
  decision: "approved" | "rejected",
) {
  try {
    const invalidRequest = await validateBodylessSameOriginPost(request);
    if (invalidRequest) {
      return invalidRequest;
    }
    const capability = readDemoApprovalCookie(request);
    if (!capability) {
      return json({ error: "Approval decision unavailable" }, 409);
    }
    const requestSecret = requiredDemoRequestSecret();
    const approvalCapabilityDigest = deriveDemoApprovalDigest(
      capability.token,
      requestSecret,
    );
    const session = await getDemoApprovalSession({
      requestSecret,
      approvalCapabilityDigest,
    });
    if (
      !session ||
      session.demoCommandId !== capability.demoCommandId ||
      session.status !== "pending"
    ) {
      return json({ error: "Approval decision unavailable" }, 409);
    }
    const result = await decideDemoApproval({
      requestSecret,
      approvalCapabilityDigest,
      decision,
    });
    if (result.status === "unavailable") {
      return json({ error: "Approval decision unavailable" }, 409);
    }
    if (result.status === "runner_offline") {
      return json({ error: "Demo runner is unavailable" }, 503);
    }
    if (!("demoCommandId" in result)) {
      return json({ error: "Approval decision unavailable" }, 409);
    }
    if (result.demoCommandId !== capability.demoCommandId) {
      return json({ error: "Unable to record approval decision" }, 500);
    }
    return json(
      {
        demoCommandId: result.demoCommandId,
        status: result.status,
        decidedAt: result.decidedAt,
      },
      200,
    );
  } catch {
    return json({ error: "Unable to record approval decision" }, 500);
  }
}

export async function handleDemoApprovalSession(request: Request) {
  try {
    const capability = readDemoApprovalCookie(request);
    if (!capability) {
      return json({ canDecide: false }, 200);
    }
    const requestSecret = requiredDemoRequestSecret();
    const result = await getDemoApprovalSession({
      requestSecret,
      approvalCapabilityDigest: deriveDemoApprovalDigest(
        capability.token,
        requestSecret,
      ),
    });
    if (!result || result.demoCommandId !== capability.demoCommandId) {
      return json({ canDecide: false }, 200);
    }
    return json(
      {
        canDecide: result.status === "pending",
        demoCommandId: result.demoCommandId,
        status: result.status,
        expiresAt: result.expiresAt,
        decidedAt: result.decidedAt,
      },
      200,
    );
  } catch {
    return json({ canDecide: false }, 500);
  }
}
