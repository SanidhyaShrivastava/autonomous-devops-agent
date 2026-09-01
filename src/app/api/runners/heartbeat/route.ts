import { createHash } from "node:crypto";

import {
  connectedRunnerHeartbeatRequestSchema,
  connectedRunnerHeartbeatResponseSchema,
} from "@/lib/connected-runner-protocol";
import { recordRunnerHeartbeat } from "@/lib/server/runner-enrollment";
import { isJsonContentType, readLimitedBody } from "@/lib/server/http-body";
import { runnerClientAddressDigest } from "@/lib/server/runner-client-address";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 2_048;

function noStoreHeaders() {
  return { "Cache-Control": "no-store, max-age=0" };
}

function json(
  body: Record<string, unknown>,
  status: number,
  headers: Record<string, string> = {},
) {
  return Response.json(body, {
    status,
    headers: { ...noStoreHeaders(), ...headers },
  });
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function bearerCredential(request: Request) {
  const match = request.headers
    .get("authorization")
    ?.match(/^Bearer (gxrun_[A-Za-z0-9_-]{43})$/);
  return match?.[1] ?? null;
}

export async function POST(request: Request) {
  try {
    const credential = bearerCredential(request);
    if (!credential) {
      return json({ error: "Runner authentication failed" }, 401);
    }

    if (!isJsonContentType(request.headers.get("content-type"))) {
      return json({ error: "Content type is not accepted" }, 415);
    }
    const body = await readLimitedBody(request, MAX_BODY_BYTES);
    if (body.status === "too_large") {
      return json({ error: "Request body is too large" }, 413);
    }

    let value: unknown;
    try {
      value = JSON.parse(body.text);
    } catch {
      return json({ error: "Request body is invalid" }, 400);
    }
    const parsed = connectedRunnerHeartbeatRequestSchema.safeParse(value);
    if (!parsed.success) {
      return json({ error: "Request body is invalid" }, 400);
    }

    const result = await recordRunnerHeartbeat({
      ...parsed.data,
      clientAddressDigest: runnerClientAddressDigest(request),
      credentialDigest: sha256(credential),
    });
    if (result.status === "unavailable") {
      return json({ error: "Runner authentication failed" }, 401);
    }
    if (result.status === "rate_limited") {
      return json(
        { error: "Too many heartbeat requests" },
        429,
        { "Retry-After": String(result.retryAfterSeconds) },
      );
    }

    const responseBody = connectedRunnerHeartbeatResponseSchema.parse({
      heartbeatIntervalMs: result.heartbeatIntervalMs,
      workloadRegistered: result.workloadRegistered,
      command: result.command,
    });
    return json(responseBody, 200);
  } catch {
    return json({ error: "Heartbeat is temporarily unavailable" }, 500);
  }
}
