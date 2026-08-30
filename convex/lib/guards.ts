import { ConvexError } from "convex/values";

export const DEMO_RUNNER_ID = "gx-local-runner" as const;
export const DEMO_WORKLOAD_ID = "demo-service" as const;
export const DEMO_ACTION_ID = "restart_demo_service" as const;
export const DEMO_COMMAND_KIND = "RESET_DEMO_V1" as const;
export const DEMO_SERVICE_IDENTITY = "gx-autodevops-demo-service" as const;
export const DEMO_HEALTHY_STATUS = "healthy" as const;
export const MINIMUM_AUTONOMOUS_CONFIDENCE = 0.8;
export const MAX_CLOCK_SKEW_MS = 5_000;

export const RUNNER_FRESHNESS_MS = 4_000;
export const REQUEST_COOLDOWN_MS = 60_000;
export const COMMAND_EXPIRY_MS = 90_000;
export const CLAIM_LEASE_MS = 30_000;
export const RUNNER_HEARTBEAT_LOSS_MS = RUNNER_FRESHNESS_MS;
export const ACTIVE_STEP_DEADLINE_MS = 20_000;
export const ACTIVE_RUN_DEADLINE_MS = 45_000;
export const DAILY_REQUEST_CAP = 30;
export const PUBLIC_OUTPUT_LIMIT = 4_000;
export const PUBLIC_STEP_LIMIT = 100;

type SecretName = "DEMO_REQUEST_SECRET" | "RUNNER_TOKEN";

function configuredSecret(name: SecretName) {
  const value = process.env[name];
  if (!value) {
    throw new Error("Unauthorized");
  }
  return value;
}

function requireExactSecret(name: SecretName, supplied: string) {
  if (supplied !== configuredSecret(name)) {
    throw new Error("Unauthorized");
  }
}

export function requireDemoRequestSecret(supplied: string) {
  requireExactSecret("DEMO_REQUEST_SECRET", supplied);
}

export function requireRunnerToken(supplied: string) {
  requireExactSecret("RUNNER_TOKEN", supplied);
}

export function rejectWithCode(code: string): never {
  throw new ConvexError({ code });
}

export function requireDemoRunner(runnerId: string) {
  if (runnerId !== DEMO_RUNNER_ID) {
    rejectWithCode("RUNNER_MISMATCH");
  }
}

export function utcDayKey(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function requireBoundedIdentifier(value: string, label: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    rejectWithCode(`INVALID_${label.toUpperCase()}`);
  }
  return value;
}

export function requireBoundedText(
  value: string,
  label: string,
  maxLength: number,
) {
  const trimmed = value.trim();
  if (!trimmed || Array.from(trimmed).length > maxLength) {
    rejectWithCode(`INVALID_${label.toUpperCase()}`);
  }
  return trimmed;
}

export function requireNonNegativeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    rejectWithCode(`INVALID_${label.toUpperCase()}`);
  }
  return value;
}

const ANSI_OSC_PATTERN = /\x1B\][\s\S]*?(?:\x07|\x1B\\)/g;
const ANSI_CSI_PATTERN = /(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~]/g;
const ANSI_ESCAPE_PATTERN = /\x1B[@-_]/g;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY(?: BLOCK)?-----/gi;
const BEARER_TOKEN_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const OPENAI_TOKEN_PATTERN =
  /\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{16,}\b/g;
const GITHUB_TOKEN_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g;
const SECRET_ASSIGNMENT_PATTERN =
  /(^|[^A-Za-z0-9])((?:["']?)(?:(?:[a-z0-9]+[_-])*(?:api[_-]?key|token|password|passwd|secret)|apiKey|accessToken|authToken|refreshToken|clientSecret|runnerToken|demoRequestSecret)(?:["']?)\s*(?:=|:)\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;&}\]\r\n]+)/gim;

export function sanitizeForPersistence(
  value: string,
  maxLength = PUBLIC_OUTPUT_LIMIT,
) {
  const sanitized = value
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(PRIVATE_KEY_PATTERN, "[REDACTED]")
    .replace(BEARER_TOKEN_PATTERN, "$1[REDACTED]")
    .replace(
      SECRET_ASSIGNMENT_PATTERN,
      (_match, prefix: string, assignment: string) =>
        `${prefix}${assignment}[REDACTED]`,
    )
    .replace(OPENAI_TOKEN_PATTERN, "[REDACTED]")
    .replace(GITHUB_TOKEN_PATTERN, "[REDACTED]");

  return Array.from(sanitized).slice(0, Math.max(0, maxLength)).join("");
}
