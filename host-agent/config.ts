import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

function isSecureControlPlane(value: string) {
  const url = new URL(value);
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return url.protocol === "https:" || (isLocal && url.protocol === "http:");
}

const runnerConfigSchema = z
  .object({
    agentVersion: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/),
    baseUrl: z
      .string()
      .url()
      .refine(isSecureControlPlane, "The control-plane address must use HTTPS."),
    credential: z.string().regex(/^gxrun_[A-Za-z0-9_-]{43}$/),
    runnerId: z.string().regex(/^gxr_[A-Za-z0-9_-]{24}$/),
  })
  .strict();

export type RunnerConfig = z.infer<typeof runnerConfigSchema>;

export function normalizeRunnerBaseUrl(value: string) {
  const url = new URL(value.trim());
  url.pathname = "";
  url.search = "";
  url.hash = "";
  const normalized = url.toString().replace(/\/$/, "");
  if (!isSecureControlPlane(normalized)) {
    throw new Error("The control-plane address must use HTTPS.");
  }
  return normalized;
}

export function defaultRunnerConfigPath() {
  return path.join(os.homedir(), ".autonomous-devops-agent", "runner.json");
}

export async function saveRunnerConfig(
  configPath: string,
  config: RunnerConfig,
) {
  const validated = runnerConfigSchema.parse(config);
  const directory = path.dirname(configPath);
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, configPath);
    await chmod(configPath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function loadRunnerConfig(configPath: string) {
  const raw = await readFile(configPath, "utf8");
  return runnerConfigSchema.parse(JSON.parse(raw) as unknown);
}
