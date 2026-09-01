import { pathToFileURL } from "node:url";

const FIXED_SEED_FAILURE_URL =
  "http://127.0.0.1:3001/__seed-stopped-service" as const;
const SEED_REQUEST_TIMEOUT_MS = 1_000;

export async function seedStoppedServiceFailure(options: {
  request?: typeof fetch;
} = {}) {
  const request = options.request ?? fetch;
  const response = await request(FIXED_SEED_FAILURE_URL, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(SEED_REQUEST_TIMEOUT_MS),
  });
  if (response.status !== 204) {
    throw new Error("The fixed disposable service could not be stopped.");
  }
}

async function main() {
  if (process.platform !== "linux") {
    throw new Error("This failure seed must run on the Linux server.");
  }
  await seedStoppedServiceFailure();
  process.stdout.write("The fixed disposable service is stopped.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "The failure seed failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
