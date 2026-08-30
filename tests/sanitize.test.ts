import { describe, expect, it } from "vitest";

import { sanitizePublicOutput } from "../src/lib/sanitize";

describe("sanitizePublicOutput", () => {
  it("strips ANSI colors, cursor controls, and terminal hyperlinks", () => {
    const input =
      "\u001b[31mfailed\u001b[0m\u001b[2K " +
      "\u001b]8;;https://example.com\u0007service\u001b]8;;\u0007";

    expect(sanitizePublicOutput(input)).toEqual({
      text: "failed service",
      truncated: false,
    });
  });

  it("redacts bearer tokens and common secret assignments", () => {
    const input = [
      "Authorization: Bearer eyJhbGciOiJIUzI1Ni.fake.signature",
      "RUNNER_TOKEN=runner-secret-value",
      'password: "correct horse battery staple"',
      "client-secret='client-secret-value'",
      "apiKey=api-key-value",
    ].join("\n");

    const result = sanitizePublicOutput(input);

    expect(result.text).not.toContain("eyJhbGciOiJIUzI1Ni");
    expect(result.text).not.toContain("runner-secret-value");
    expect(result.text).not.toContain("correct horse battery staple");
    expect(result.text).not.toContain("client-secret-value");
    expect(result.text).not.toContain("api-key-value");
    expect(result.text.match(/\[REDACTED\]/g)).toHaveLength(5);
    expect(result.truncated).toBe(false);
  });

  it("redacts OpenAI-like, GitHub-like, and private-key material", () => {
    const openAiToken = `sk-proj-${"a".repeat(32)}`;
    const githubToken = `ghp_${"b".repeat(36)}`;
    const privateKey = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "cHJpdmF0ZS1rZXktbWF0ZXJpYWw=",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");

    const result = sanitizePublicOutput(
      `${openAiToken}\n${githubToken}\n${privateKey}`,
    );

    expect(result.text).toBe(
      "[REDACTED]\n[REDACTED]\n[REDACTED]",
    );
    expect(result.truncated).toBe(false);
  });

  it("redacts adjacent chunk-like values without needing separators", () => {
    const input =
      `first token=alpha-token,` +
      `password=beta-password;` +
      `Bearer ${"c".repeat(24)}\n` +
      `github_pat_${"d".repeat(24)}`;

    const result = sanitizePublicOutput(input);

    expect(result.text).not.toContain("alpha-token");
    expect(result.text).not.toContain("beta-password");
    expect(result.text).not.toContain("c".repeat(24));
    expect(result.text).not.toContain("d".repeat(24));
    expect(result.text.match(/\[REDACTED\]/g)).toHaveLength(4);
  });

  it("truncates only after redaction", () => {
    const secret = `sk-${"z".repeat(32)}`;
    const result = sanitizePublicOutput(`token=${secret}\n${"x".repeat(50)}`, 20);

    expect(result).toEqual({
      text: "token=[REDACTED]\nxxx",
      truncated: true,
    });
    expect(result.text).not.toContain(secret);
    expect(Array.from(result.text)).toHaveLength(20);
  });

  it("preserves safe demo state and log lines", () => {
    const input = [
      "status=exited exitCode=0 oomKilled=false",
      "finishedAt=2026-08-30T10:15:00.000Z",
      "label=com.growthx.demo=autonomous-devops-agent",
      "service startup complete",
      "health request returned 200",
    ].join("\n");

    expect(sanitizePublicOutput(input)).toEqual({
      text: input,
      truncated: false,
    });
  });
});
