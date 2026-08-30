import { requestDemoRun } from "@/lib/server/convex";

export const runtime = "nodejs";

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status });
}

function requiredOrigin() {
  const configuredUrl = process.env.PUBLIC_APP_URL;
  if (!configuredUrl) {
    throw new Error("Server configuration unavailable");
  }
  return new URL(configuredUrl).origin;
}

function requiredRequestSecret() {
  const requestSecret = process.env.DEMO_REQUEST_SECRET;
  if (!requestSecret) {
    throw new Error("Server configuration unavailable");
  }
  return requestSecret;
}

export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") !== requiredOrigin()) {
      return json({ error: "Forbidden" }, 403);
    }

    if (request.headers.has("content-type")) {
      return json({ error: "Content type is not accepted" }, 415);
    }

    const body = await request.arrayBuffer();
    if (body.byteLength !== 0) {
      return json({ error: "Request body must be empty" }, 400);
    }

    const result = await requestDemoRun({
      requestSecret: requiredRequestSecret(),
    });

    switch (result.status) {
      case "accepted":
        return json({ demoCommandId: result.demoCommandId }, 202);
      case "active":
        return json({ error: "A demo run is already active" }, 409);
      case "cooldown":
      case "daily_cap":
        return json({ error: "Demo request limit reached" }, 429);
      case "runner_offline":
      case "disabled":
        return json({ error: "Demo runner is unavailable" }, 503);
    }
  } catch {
    return json({ error: "Unable to start the demo" }, 500);
  }
}
