import { requestDemoRun } from "@/lib/server/convex";
import {
  createDemoApprovalCapability,
  encodeDemoApprovalCookie,
  requiredDemoRequestSecret,
  serializeDemoApprovalCookie,
  validateBodylessSameOriginPost,
} from "@/lib/server/demo-approval";

export const runtime = "nodejs";

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  try {
    const invalidRequest = await validateBodylessSameOriginPost(request);
    if (invalidRequest) {
      return invalidRequest;
    }

    const requestSecret = requiredDemoRequestSecret();
    const capability = createDemoApprovalCapability(requestSecret);
    const result = await requestDemoRun({
      requestSecret,
      executionMode: "approval_required",
      approvalCapabilityDigest: capability.digest,
    });

    switch (result.status) {
      case "accepted": {
        const response = json({ demoCommandId: result.demoCommandId }, 202);
        response.headers.set(
          "set-cookie",
          serializeDemoApprovalCookie(
            encodeDemoApprovalCookie(result.demoCommandId, capability.token),
          ),
        );
        return response;
      }
      case "active":
        return json({ error: "A demo run is already active" }, 409);
      case "cooldown":
      case "daily_cap":
        return json({ error: "Demo request limit reached" }, 429);
      case "runner_offline":
      case "environment_recovery_pending":
      case "disabled":
        return json({ error: "Demo runner is unavailable" }, 503);
    }
  } catch {
    return json({ error: "Unable to start the demo" }, 500);
  }
}
