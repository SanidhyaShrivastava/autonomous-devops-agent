import { createHash, randomBytes } from "node:crypto";

import { pairRunner } from "@/lib/server/runner-enrollment";
import { isJsonContentType, readLimitedBody } from "@/lib/server/http-body";
import { runnerClientAddressDigest } from "@/lib/server/runner-client-address";
import { z } from "zod";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 4_096;
const pairRequestSchema = z
  .object({
    pairingCode: z.string().regex(/^gxpair_[A-Za-z0-9_-]{43}$/),
    agentVersion: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/),
    architecture: z.enum(["x64", "arm64"]),
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

async function readStrictJson(request: Request) {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return { error: "content-type" as const };
  }
  const body = await readLimitedBody(request, MAX_BODY_BYTES);
  if (body.status === "too_large") {
    return { error: "too-large" as const };
  }

  try {
    return { value: JSON.parse(body.text) as unknown };
  } catch {
    return { error: "invalid-json" as const };
  }
}

export async function POST(request: Request) {
  try {
    const decoded = await readStrictJson(request);
    if (decoded.error === "content-type") {
      return json({ error: "Content type is not accepted" }, 415);
    }
    if (decoded.error === "too-large") {
      return json({ error: "Request body is too large" }, 413);
    }
    if (decoded.error === "invalid-json") {
      return json({ error: "Request body is invalid" }, 400);
    }

    const parsed = pairRequestSchema.safeParse(decoded.value);
    if (!parsed.success) {
      return json({ error: "Request body is invalid" }, 400);
    }

    const credential = `gxrun_${randomBytes(32).toString("base64url")}`;
    const runnerId = `gxr_${randomBytes(18).toString("base64url")}`;
    const result = await pairRunner({
      clientAddressDigest: runnerClientAddressDigest(request),
      codeDigest: sha256(parsed.data.pairingCode),
      credentialDigest: sha256(credential),
      runnerId,
      agentVersion: parsed.data.agentVersion,
      architecture: parsed.data.architecture,
    });

    if (result.status === "unavailable") {
      return json({ error: "Pairing failed" }, 401);
    }
    if (result.status === "rate_limited") {
      return json(
        { error: "Too many pairing attempts" },
        429,
        { "Retry-After": String(result.retryAfterSeconds) },
      );
    }

    return json(
      {
        runnerId: result.runnerId,
        credential,
        heartbeatIntervalMs: 2_000,
      },
      201,
    );
  } catch {
    return json({ error: "Pairing is temporarily unavailable" }, 500);
  }
}
