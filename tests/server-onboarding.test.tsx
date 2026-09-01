/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const convexMock = vi.hoisted(() => ({
  mutate: vi.fn(),
  useConvexAuth: vi.fn(),
  useMutation: vi.fn(),
  useQuery: vi.fn(),
}));
const authMock = vi.hoisted(() => ({ signOut: vi.fn() }));
const routerMock = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("convex/react", () => ({
  useConvexAuth: convexMock.useConvexAuth,
  useMutation: convexMock.useMutation,
  useQuery: convexMock.useQuery,
}));
vi.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => authMock,
}));
vi.mock("next/navigation", () => ({ useRouter: () => routerMock }));

import { ServerOnboarding } from "@/components/server-onboarding";

function privateState(overrides: Record<string, unknown> = {}) {
  return {
    enrollment: null,
    runner: null,
    workload: null,
    latestRecovery: null,
    ...overrides,
  };
}

function connectedRunner(overrides: Record<string, unknown> = {}) {
  return {
    runnerId: "gxr_abcdefghijklmnopqrstuvwx",
    label: "test-docker-server",
    osFamily: "linux",
    architecture: "arm64",
    agentVersion: "0.2.0",
    pairedAt: Date.now() - 4_000,
    lastHeartbeatAt: Date.now(),
    capabilityId: "fixed_disposable_service_v1",
    capabilityReportedAt: Date.now(),
    revokedAt: null,
    ...overrides,
  };
}

function fixedWorkload(overrides: Record<string, unknown> = {}) {
  return {
    workloadId: "connected-demo-service",
    healthCheckId: "check-connected-demo-service-health",
    recoveryActionId: "restart-connected-demo-service",
    recoveryMode: "approval_required",
    healthStatus: "healthy",
    healthDetailCode: "exact_http_200",
    healthReportedAt: Date.now(),
    currentInstanceId: "instance-before-recovery",
    lastHealthyInstanceId: "instance-before-recovery",
    registeredAt: Date.now() - 2_000,
    ...overrides,
  };
}

function fixedRecovery(
  status: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    commandId: "recovery_abcdefghijklmnop",
    actionId: "restart-connected-demo-service",
    status,
    createdAt: Date.now() - 1_000,
    deadlineAt: Date.now() + 60_000,
    approvedAt: null,
    claimedAt: null,
    executionResultCode: null,
    verificationStatus: null,
    verificationDetailCode: null,
    preActionInstanceId: "instance-before-recovery",
    postActionInstanceId: null,
    terminalReason: null,
    finishedAt: null,
    stateVersion: 0,
    ...overrides,
  };
}

describe("server onboarding", () => {
  beforeEach(() => {
    convexMock.mutate.mockReset();
    convexMock.mutate.mockResolvedValue({
      enrollmentId: "invite-1",
      expiresAt: Date.now() + 10 * 60_000,
    });
    convexMock.useMutation.mockReset();
    convexMock.useMutation.mockReturnValue(convexMock.mutate);
    convexMock.useQuery.mockReset();
    convexMock.useQuery.mockReturnValue(privateState());
    convexMock.useConvexAuth.mockReset();
    convexMock.useConvexAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });
    authMock.signOut.mockReset();
    routerMock.push.mockReset();
    routerMock.refresh.mockReset();
    vi.stubGlobal("crypto", {
      getRandomValues: (value: Uint8Array) => value.fill(1),
      subtle: {
        digest: async () => new Uint8Array(32).fill(2).buffer,
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("starts with one owner-bound runner and no enabled actions", () => {
    render(<ServerOnboarding />);

    expect(
      screen.getByRole("heading", { name: "Connect one Linux runner" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Private runner label")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", {
        name: /I own this server or have permission/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("No recovery actions enabled")).toBeInTheDocument();
    expect(screen.getByText(/heartbeat only/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/hostname|IP address|secret/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create pairing code" })).toBeDisabled();
  });

  it("creates a 256-bit code but sends only its digest to Convex", async () => {
    render(<ServerOnboarding />);

    fireEvent.change(screen.getByLabelText("Private runner label"), {
      target: { value: "staging-web-1" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I own this server or have permission/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create pairing code" }));

    await waitFor(() => expect(convexMock.mutate).toHaveBeenCalledOnce());
    expect(convexMock.mutate).toHaveBeenCalledWith({
      codeDigest: "02".repeat(32),
      label: "staging-web-1",
    });
    expect(await screen.findByText(/^gxpair_/)).toHaveTextContent(
      /^gxpair_[A-Za-z0-9_-]{43}$/,
    );
    expect(screen.getByText("Run this on your Linux server")).toBeInTheDocument();
    expect(screen.getByText(/expires in 10 minutes/i)).toBeInTheDocument();
  });

  it("never re-shows a code after reload and offers a fresh one", () => {
    convexMock.useQuery.mockReturnValue(
      privateState({
        enrollment: {
          enrollmentId: "invite-1",
          label: "staging-web-1",
          state: "waiting",
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      }),
    );

    render(<ServerOnboarding />);

    expect(screen.queryByText(/^gxpair_/)).not.toBeInTheDocument();
    expect(screen.getByText(/code cannot be shown again/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a new code" })).toBeInTheDocument();
  });

  it("does not offer service registration to an old heartbeat-only runner", () => {
    convexMock.useQuery.mockReturnValue(
      privateState({
        runner: connectedRunner({
          agentVersion: "0.1.0",
          capabilityId: null,
          capabilityReportedAt: null,
        }),
      }),
    );

    render(<ServerOnboarding />);

    expect(screen.getByText("Runner connected")).toBeInTheDocument();
    expect(screen.getAllByText("Online").length).toBeGreaterThan(0);
    expect(screen.getByText(/waiting for the fixed service capability/i)).toBeInTheDocument();
    expect(screen.getAllByText("No recovery actions enabled").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: "Register disposable service" }),
    ).not.toBeInTheDocument();
  });

  it("registers only after the exact fixed capability is fresh and exposes no command fields", async () => {
    convexMock.useQuery.mockReturnValue(
      privateState({ runner: connectedRunner() }),
    );

    render(<ServerOnboarding />);

    expect(
      screen.getByRole("button", { name: "Register disposable service" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Register disposable service" }),
    );
    await waitFor(() => expect(convexMock.mutate).toHaveBeenCalledOnce());
    expect(convexMock.mutate).toHaveBeenCalledWith({});
  });

  it("does not register when the exact capability report is stale", () => {
    convexMock.useQuery.mockReturnValue(
      privateState({
        runner: connectedRunner({
          capabilityReportedAt: Date.now() - 7_000,
        }),
      }),
    );

    render(<ServerOnboarding />);

    expect(
      screen.queryByRole("button", { name: "Register disposable service" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/waiting for the fixed service capability/i)).toBeInTheDocument();
  });

  it("shows one fixed check, one fixed action, approval-first policy, and the authority rail", () => {
    convexMock.useQuery.mockReturnValue(
      privateState({
        runner: connectedRunner(),
        workload: fixedWorkload(),
      }),
    );

    render(<ServerOnboarding />);

    expect(screen.getByText("Connected demo service")).toBeInTheDocument();
    expect(screen.getByText("Fixed HTTP 200 health check")).toBeInTheDocument();
    expect(screen.getByText("Fixed service restart")).toBeInTheDocument();
    expect(screen.getByText("Human approval required")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    const authorityPath = screen.getByRole("list", {
      name: "Recovery authority path",
    });
    for (const node of [
      "Runner",
      "Health check",
      "Approval",
      "Restart",
      "Verified",
    ]) {
      expect(within(authorityPath).getByText(node)).toBeInTheDocument();
    }
  });

  it.each([
    {
      name: "healthy",
      runner: connectedRunner(),
      workload: fixedWorkload(),
      status: "Healthy — no recovery needed",
    },
    {
      name: "offline",
      runner: connectedRunner({ lastHeartbeatAt: Date.now() - 7_000 }),
      workload: fixedWorkload({
        healthStatus: "unhealthy",
        healthDetailCode: "connection_failed",
        currentInstanceId: null,
      }),
      status: "Runner offline",
    },
    {
      name: "stale health",
      runner: connectedRunner(),
      workload: fixedWorkload({
        healthStatus: "unhealthy",
        healthDetailCode: "connection_failed",
        healthReportedAt: Date.now() - 9_000,
        currentInstanceId: null,
      }),
      status: "Waiting for fresh health",
    },
  ])("blocks recovery preparation while $name", ({ runner, workload, status }) => {
    convexMock.useQuery.mockReturnValue(
      privateState({ runner, workload }),
    );

    render(<ServerOnboarding />);

    expect(screen.getByRole("heading", { name: status })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Prepare approval-first recovery" }),
    ).not.toBeInTheDocument();
  });

  it("prepares one approval-first request for a fresh unhealthy service", async () => {
    let finishMutation: (() => void) | undefined;
    convexMock.mutate.mockImplementation(
      () => new Promise((resolve) => {
        finishMutation = () => resolve({});
      }),
    );
    convexMock.useQuery.mockReturnValue(
      privateState({
        runner: connectedRunner(),
        workload: fixedWorkload({
          healthStatus: "unhealthy",
          healthDetailCode: "connection_failed",
          currentInstanceId: null,
        }),
      }),
    );

    render(<ServerOnboarding />);

    expect(
      screen.getByRole("heading", { name: "Service unhealthy" }),
    ).toBeInTheDocument();
    const prepare = screen.getByRole("button", {
      name: "Prepare approval-first recovery",
    });
    fireEvent.click(prepare);
    fireEvent.click(prepare);

    expect(convexMock.mutate).toHaveBeenCalledOnce();
    expect(convexMock.mutate).toHaveBeenCalledWith({});
    expect(
      screen.getByRole("button", { name: "Preparing recovery…" }),
    ).toBeDisabled();

    await act(async () => finishMutation?.());
  });

  it("names the fixed restart and accepts only one pending approval decision", async () => {
    let finishMutation: (() => void) | undefined;
    convexMock.mutate.mockImplementation(
      () => new Promise((resolve) => {
        finishMutation = () => resolve({});
      }),
    );
    convexMock.useQuery.mockReturnValue(
      privateState({
        runner: connectedRunner(),
        workload: fixedWorkload({
          healthStatus: "unhealthy",
          healthDetailCode: "connection_failed",
          currentInstanceId: null,
        }),
        latestRecovery: fixedRecovery("pending_approval"),
      }),
    );

    render(<ServerOnboarding />);

    expect(
      screen.getByRole("heading", { name: "Approval required" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Fixed service restart")).toBeInTheDocument();
    const approve = screen.getByRole("button", { name: "Approve fixed restart" });
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    fireEvent.click(approve);
    fireEvent.click(approve);

    expect(convexMock.mutate).toHaveBeenCalledOnce();
    expect(convexMock.mutate).toHaveBeenCalledWith({
      commandId: "recovery_abcdefghijklmnop",
      decision: "approved",
    });
    expect(screen.getByRole("button", { name: "Approving…" })).toBeDisabled();

    await act(async () => finishMutation?.());
  });

  it("blocks approval when the runner is stale but still allows rejection", () => {
    convexMock.useQuery.mockReturnValue(
      privateState({
        runner: connectedRunner({ lastHeartbeatAt: Date.now() - 7_000 }),
        workload: fixedWorkload({
          healthStatus: "unhealthy",
          healthDetailCode: "connection_failed",
          currentInstanceId: null,
        }),
        latestRecovery: fixedRecovery("pending_approval"),
      }),
    );

    render(<ServerOnboarding />);

    expect(
      screen.getByRole("button", { name: "Approve fixed restart" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    expect(screen.getByText(/approval is blocked until the runner/i)).toBeInTheDocument();
  });

  it.each([
    ["approved", "Restart approved"],
    ["claimed", "Restart in progress"],
    ["failed", "Recovery failed"],
    ["rejected", "Recovery rejected"],
    ["expired", "Approval expired"],
    ["not_needed", "Recovery not needed"],
    ["execution_unknown", "Recovery result unknown"],
  ])("renders %s as the distinct state %s", (recoveryStatus, heading) => {
    const recoveryIsActive =
      recoveryStatus === "approved" || recoveryStatus === "claimed";

    convexMock.useQuery.mockReturnValue(
      privateState({
        runner: connectedRunner(),
        workload: recoveryIsActive
          ? fixedWorkload({
              healthStatus: "unhealthy",
              healthDetailCode: "connection_failed",
              currentInstanceId: null,
            })
          : fixedWorkload(),
        latestRecovery: fixedRecovery(recoveryStatus),
      }),
    );

    render(<ServerOnboarding />);

    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve fixed restart" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("requires a fresh HTTP 200 and a changed service instance before showing verified", () => {
    convexMock.useQuery.mockReturnValue(
      privateState({
        runner: connectedRunner(),
        workload: fixedWorkload({ currentInstanceId: "instance-after-recovery" }),
        latestRecovery: fixedRecovery("succeeded", {
          approvedAt: Date.now() - 900,
          claimedAt: Date.now() - 700,
          executionResultCode: "restart_succeeded",
          verificationStatus: "healthy",
          verificationDetailCode: "exact_http_200",
          postActionInstanceId: "instance-after-recovery",
          terminalReason: "verified_fresh_instance",
          finishedAt: Date.now(),
        }),
      }),
    );

    render(<ServerOnboarding />);

    expect(screen.getByRole("heading", { name: "Recovery verified" })).toBeInTheDocument();
    const verifiedCopy = screen.getByText(/A fresh HTTP 200 health check passed/i);
    expect(verifiedCopy).toHaveTextContent(/service instance changed/i);
    expect(screen.getByText("instance-after-recovery")).toBeInTheDocument();
  });

  it("lets a newly unhealthy service outrank a previous successful recovery", () => {
    convexMock.useQuery.mockReturnValue(
      privateState({
        runner: connectedRunner(),
        workload: fixedWorkload({
          healthStatus: "unhealthy",
          healthDetailCode: "connection_failed",
          currentInstanceId: null,
          lastHealthyInstanceId: "instance-after-recovery",
        }),
        latestRecovery: fixedRecovery("succeeded", {
          preActionInstanceId: "instance-before-recovery",
          executionResultCode: "restart_succeeded",
          verificationStatus: "healthy",
          verificationDetailCode: "exact_http_200",
          postActionInstanceId: "instance-after-recovery",
          terminalReason: "verified_fresh_instance",
          finishedAt: Date.now() - 1_000,
        }),
      }),
    );

    render(<ServerOnboarding />);

    expect(screen.getByRole("heading", { name: "Service unhealthy" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Prepare approval-first recovery" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("heading", { name: "Recovery verified" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/before any service access is added/i),
    ).not.toBeInTheDocument();
    expect(
      within(
        screen.getByRole("region", { name: "Connect one Linux runner" }),
      ).getByText(/fixed policy recovery/i),
    ).toBeInTheDocument();
  });

  it("does not show verified when the post-restart instance did not change", () => {
    convexMock.useQuery.mockReturnValue(
      privateState({
        runner: connectedRunner(),
        workload: fixedWorkload(),
        latestRecovery: fixedRecovery("succeeded", {
          executionResultCode: "restart_succeeded",
          verificationStatus: "healthy",
          verificationDetailCode: "exact_http_200",
          postActionInstanceId: "instance-before-recovery",
          finishedAt: Date.now(),
        }),
      }),
    );

    render(<ServerOnboarding />);

    expect(
      screen.getByRole("heading", { name: "Verification evidence incomplete" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Recovery verified" }),
    ).not.toBeInTheDocument();
  });

  it("keeps technical identifiers collapsed and revocation separate from recovery", () => {
    convexMock.useQuery.mockReturnValue(
      privateState({
        runner: connectedRunner(),
        workload: fixedWorkload(),
      }),
    );

    render(<ServerOnboarding />);

    const identifiers = screen.getByText("Technical identifiers").closest("details");
    expect(identifiers).not.toHaveAttribute("open");
    const revoke = screen.getByRole("button", { name: "Revoke runner access" });
    expect(revoke.closest(".recovery-control")).toBeNull();
  });

  it("denies framing through both legacy and modern response headers", () => {
    const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");

    expect(config).toContain('key: "X-Frame-Options"');
    expect(config).toContain('value: "DENY"');
    expect(config).toContain('key: "Content-Security-Policy"');
    expect(config).toContain("frame-ancestors 'none'");
  });

  it("stops the private query before removing authentication on sign out", async () => {
    render(<ServerOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(authMock.signOut).toHaveBeenCalledOnce());
    const skippedQueryIndex = convexMock.useQuery.mock.calls.findIndex(
      ([, args]) => args === "skip",
    );
    expect(skippedQueryIndex).toBeGreaterThanOrEqual(0);
    expect(
      convexMock.useQuery.mock.invocationCallOrder[skippedQueryIndex],
    ).toBeLessThan(authMock.signOut.mock.invocationCallOrder[0]);
    expect(routerMock.push).toHaveBeenCalledWith("/");
    expect(routerMock.refresh).toHaveBeenCalledOnce();
  });
});
