import { createHash } from "node:crypto";

import { recordRunnerHeartbeat } from "@/lib/server/runner-enrollment";
import { isJsonContentType, readLimitedBody } from "@/lib/server/http-body";
import { runnerClientAddressDigest } from "@/lib/server/runner-client-address";
import { z } from "zod";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 1_024;
const heartbeatSchema = z
  .object({
    runnerId: z.string().regex(/^gxr_[A-Za-z0-9_-]{24}$/),
    agentVersion: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/),
  })
  .strict();

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
    const parsed = heartbeatSchema.safeParse(value);
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

    return new Response(null, { status: 204, headers: noStoreHeaders() });
  } catch {
    return json({ error: "Heartbeat is temporarily unavailable" }, 500);
  }
}
