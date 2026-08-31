import { createHmac } from "node:crypto";

const SANDBOX_AGENT_TOKEN_CONTEXT = "gx-linux-sandbox-agent-v1";

export function deriveSandboxAgentToken(runnerToken: string): string {
  if (!runnerToken || runnerToken.trim().length === 0) {
    throw new Error("Runner token is required");
  }

  return createHmac("sha256", runnerToken)
    .update(SANDBOX_AGENT_TOKEN_CONTEXT)
    .digest("base64url");
}
