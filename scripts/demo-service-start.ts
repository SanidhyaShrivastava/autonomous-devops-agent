import {
  DEMO_CONTAINER_NAME,
  DEMO_EXPECTED_SERVICE,
  DEMO_EXPECTED_STATUS,
} from "../runner/config";
import { DockerAdapter } from "../runner/docker-adapter";

async function main(): Promise<void> {
  const adapter = new DockerAdapter();
  const state = await adapter.ensureDemoService();
  const health = await adapter.verifyFreshHealth(0);

  if (
    state.status !== "running" ||
    !health.healthy ||
    health.httpStatus !== 200 ||
    health.service !== DEMO_EXPECTED_SERVICE ||
    health.status !== DEMO_EXPECTED_STATUS
  ) {
    throw new Error("The fixed disposable demo service did not become healthy");
  }

  console.log(
    JSON.stringify({
      container: DEMO_CONTAINER_NAME,
      docker: "available",
      health: "healthy",
      status: state.status,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "The fixed disposable demo service could not start",
  );
  process.exitCode = 1;
});
