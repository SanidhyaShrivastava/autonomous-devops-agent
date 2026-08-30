import { describe, expect, it, vi } from "vitest";

import { createEnvironmentRestorer } from "../runner/environment-restorer";

const request = {
  incidentId: "incident_1",
  stateVersion: 4,
} as const;

const runningState = {
  status: "running",
  exitCode: 0,
  oomKilled: false,
  finishedAt: "0001-01-01T00:00:00Z",
  demoLabel: "autonomous-devops-agent" as const,
};

const healthy = {
  healthy: true,
  httpStatus: 200,
  service: "gx-autodevops-demo-service",
  status: "healthy",
  requestStartedAt: 110,
  checkedAt: 120,
  attempts: 1,
};

describe("automatic demo environment restoration", () => {
  it("ensures the fixed service, verifies fresh health, and completes cleanup", async () => {
    const order: string[] = [];
    const client = {
      claimEnvironmentRecovery: vi.fn(async () => {
        order.push("claim");
        return { status: "claimed" as const, stateVersion: 5 };
      }),
      completeEnvironmentRecovery: vi.fn(async () => {
        order.push("complete");
        return { status: "restored" as const, stateVersion: 6 };
      }),
      failEnvironmentRecovery: vi.fn(),
    };
    const workload = {
      ensureDemoService: vi.fn(async () => {
        order.push("ensure");
        return runningState;
      }),
      verifyFreshHealth: vi.fn(async () => {
        order.push("verify");
        return healthy;
      }),
    };
    const restorer = createEnvironmentRestorer({
      client,
      workload,
      now: () => 100,
    });

    await restorer.restoreDemoEnvironment(request);

    expect(order).toEqual(["claim", "ensure", "verify", "complete"]);
    expect(workload.ensureDemoService).toHaveBeenCalledOnce();
    expect(workload.verifyFreshHealth).toHaveBeenCalledWith(100);
    expect(client.completeEnvironmentRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        incidentId: "incident_1",
        expectedStateVersion: 5,
        verification: expect.objectContaining({
          service: "gx-autodevops-demo-service",
          status: "healthy",
          httpStatus: 200,
        }),
      }),
    );
    expect(client.failEnvironmentRecovery).not.toHaveBeenCalled();
  });

  it("records failed cleanup without ever marking the environment restored", async () => {
    const client = {
      claimEnvironmentRecovery: vi.fn(async () => ({
        status: "claimed" as const,
        stateVersion: 5,
      })),
      completeEnvironmentRecovery: vi.fn(),
      failEnvironmentRecovery: vi.fn(async () => ({
        status: "pending" as const,
        stateVersion: 6,
      })),
    };
    const workload = {
      ensureDemoService: vi.fn(async () => runningState),
      verifyFreshHealth: vi.fn(async () => ({
        ...healthy,
        healthy: false,
        httpStatus: null,
        service: null,
        status: null,
      })),
    };
    const restorer = createEnvironmentRestorer({
      client,
      workload,
      now: () => 100,
    });

    await expect(
      restorer.restoreDemoEnvironment(request),
    ).resolves.toMatchObject({ status: "failed" });

    expect(client.completeEnvironmentRecovery).not.toHaveBeenCalled();
    expect(client.failEnvironmentRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        incidentId: "incident_1",
        expectedStateVersion: 5,
      }),
    );
  });
});
