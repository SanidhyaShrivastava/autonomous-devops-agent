export interface SanitizedPublicOutput {
  text: string;
  truncated: boolean;
}

const DEFAULT_MAX_CHARS = 4_000;

// OSC sequences include terminal titles and hyperlinks.
const ANSI_OSC_PATTERN = /\x1B\][\s\S]*?(?:\x07|\x1B\\)/g;

// CSI sequences include terminal colors and cursor controls.
const ANSI_CSI_PATTERN = /(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~]/g;

// Remaining two-byte escape sequences.
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

function stripAnsi(input: string): string {
  return input
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(ANSI_ESCAPE_PATTERN, "");
}

function normalizeMaxChars(maxChars: number): number {
  if (!Number.isFinite(maxChars)) {
    return DEFAULT_MAX_CHARS;
  }

  return Math.max(0, Math.floor(maxChars));
}

/**
 * Makes command output safe to persist or show in the public incident trace.
 * It deliberately does not read process environment values.
 */
export function sanitizePublicOutput(
  input: string,
  maxChars = DEFAULT_MAX_CHARS,
): SanitizedPublicOutput {
  let sanitized = stripAnsi(input);

  sanitized = sanitized
    .replace(PRIVATE_KEY_PATTERN, "[REDACTED]")
    .replace(BEARER_TOKEN_PATTERN, "$1[REDACTED]")
    .replace(
      SECRET_ASSIGNMENT_PATTERN,
      (_match, prefix: string, assignment: string) =>
        `${prefix}${assignment}[REDACTED]`,
    )
    .replace(OPENAI_TOKEN_PATTERN, "[REDACTED]")
    .replace(GITHUB_TOKEN_PATTERN, "[REDACTED]");

  const limit = normalizeMaxChars(maxChars);
  const characters = Array.from(sanitized);
  const truncated = characters.length > limit;

  return {
    text: truncated ? characters.slice(0, limit).join("") : sanitized,
    truncated,
  };
}
