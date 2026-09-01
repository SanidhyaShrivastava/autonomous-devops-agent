import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  defaultRunnerConfigPath,
  normalizeRunnerBaseUrl,
  saveRunnerConfig,
  type RunnerConfig,
} from "./config";
import { HOST_AGENT_VERSION } from "./version";

export { HOST_AGENT_VERSION } from "./version";

const pairResponseSchema = z
  .object({
    credential: z.string().regex(/^gxrun_[A-Za-z0-9_-]{43}$/),
    heartbeatIntervalMs: z.literal(2_000),
    runnerId: z.string().regex(/^gxr_[A-Za-z0-9_-]{24}$/),
  })
  .strict();

export async function pairWithCode(args: {
  baseUrl: string;
  pairingCode: string;
  architecture: "x64" | "arm64";
  request?: typeof fetch;
}): Promise<RunnerConfig> {
  const request = args.request ?? fetch;
  const baseUrl = normalizeRunnerBaseUrl(args.baseUrl);
  const response = await request(`${baseUrl}/api/runners/pair`, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentVersion: HOST_AGENT_VERSION,
      architecture: args.architecture,
      pairingCode: args.pairingCode,
    }),
  });
  if (!response.ok) {
    throw new Error("Pairing failed. Create a fresh code and try again.");
  }

  const body = pairResponseSchema.parse(await response.json());
  return {
    agentVersion: HOST_AGENT_VERSION,
    baseUrl,
    credential: body.credential,
    runnerId: body.runnerId,
  };
}

function currentArchitecture(): "x64" | "arm64" {
  if (process.arch === "x64" || process.arch === "arm64") return process.arch;
  throw new Error(`Unsupported Linux architecture: ${process.arch}`);
}

async function main() {
  if (process.platform !== "linux") {
    throw new Error("This pairing command must run on the Linux server.");
  }

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const defaultUrl = "https://autonomous-devops-agent.vercel.app";
    const baseUrl =
      (await prompt.question(`Control-plane URL [${defaultUrl}]: `)).trim() ||
      defaultUrl;
    const pairingCode = (await prompt.question("One-time pairing code: ")).trim();
    const config = await pairWithCode({
      architecture: currentArchitecture(),
      baseUrl,
      pairingCode,
    });
    const configPath = defaultRunnerConfigPath();
    await saveRunnerConfig(configPath, config);
    process.stdout.write(
      `Runner paired as ${config.runnerId}. Credential saved privately at ${configPath}.\n`,
    );
  } finally {
    prompt.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Pairing failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
