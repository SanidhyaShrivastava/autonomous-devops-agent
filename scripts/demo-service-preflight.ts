import {
  DEMO_CONTAINER_NAME,
  DEMO_EXPECTED_SERVICE,
  DEMO_EXPECTED_STATUS,
  DEMO_LABEL_VALUE,
} from "../runner/config";
import { DockerAdapter } from "../runner/docker-adapter";

async function main(): Promise<void> {
  const adapter = new DockerAdapter();
  const state = await adapter.inspectSafeState();
  const health = await adapter.checkHealthOnce();

  if (
    state.demoLabel !== DEMO_LABEL_VALUE ||
    state.status !== "running" ||
    !health.healthy ||
    health.httpStatus !== 200 ||
    health.service !== DEMO_EXPECTED_SERVICE ||
    health.status !== DEMO_EXPECTED_STATUS
  ) {
    throw new Error("The fixed disposable demo service is not ready");
  }

  console.log(
    JSON.stringify({
      container: DEMO_CONTAINER_NAME,
      docker: "available",
      health: "healthy",
      label: "verified",
      status: state.status,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "The fixed disposable demo service preflight failed",
  );
  process.exitCode = 1;
});
