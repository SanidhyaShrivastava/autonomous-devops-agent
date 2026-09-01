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
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CONVEX_URL = "https://test.convex.cloud";
});

const convexMock = vi.hoisted(() => ({
  useQuery: vi.fn(),
}));
const convexHttpMock = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: convexMock.useQuery,
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    query = convexHttpMock.query;
  },
}));

import { DemoDashboard } from "@/components/demo-dashboard";

const BASE_TIME = Date.UTC(2026, 7, 30, 14, 0, 0);

function publicState(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    snapshotAt: BASE_TIME,
    demoCommandId: null,
    commandStatus: null,
    commandExpiresAt: null,
    executionMode: "autonomous",
    approval: null,
    runnerOnline: true,
    enabled: true,
    active: false,
    runnerHeartbeatAt: Date.now(),
    cooldownUntil: null,
    cooldownRemainingMs: 0,
    incident: null,
    steps: [],
    result: null,
    ...overrides,
  };
}

function incident(
  currentPhase: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    incidentId: "incident_1",
    staged: true,
    currentPhase,
    initialHealth: "failed",
    finalHealth: null,
    incidentCategory: "service_stopped",
    diagnosisEvidence: [
      "Health check healthy: false",
      "Container status: exited",
    ],
    diagnosisSummary: "The disposable demo service is stopped.",
    confidence: 0.96,
    requiresHuman: false,
    proposedActionId: "restart_demo_service",
    startedAt: BASE_TIME,
    finishedAt: null,
    terminalReason: null,
    ...overrides,
  };
}

function step(
  sequence: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    stepId: `step_${sequence}`,
    sequence,
    role: "investigator",
    kind: "safe_logs_collected",
    status: "succeeded",
    safeCommandLabel: "linux agent read fixed demo service logs",
    sanitizedOutput: "demo-service received SIGTERM",
    errorSummary: null,
    startedAt: BASE_TIME + sequence * 1_000,
    finishedAt: BASE_TIME + sequence * 1_000 + 120,
    latencyMs: 120,
    reportedInputTokens: null,
    reportedOutputTokens: null,
    costStatus: "not_reported",
    ...overrides,
  };
}

function resolvedState() {
  return publicState({
    incident: incident("resolved", {
      finalHealth: "healthy",
      finishedAt: BASE_TIME + 12_400,
      terminalReason: "verified_healthy_after_restart",
    }),
    steps: [
      step(1),
      step(2, {
        role: "investigator",
        kind: "diagnosis_completed",
        safeCommandLabel: "local codex schema-bound diagnosis",
        sanitizedOutput: '{"summary":"The service is stopped."}',
        latencyMs: 8_238,
        reportedInputTokens: 6_967,
        reportedOutputTokens: 93,
        costStatus: "unavailable_chatgpt_subscription",
      }),
      step(3, {
        role: "executor",
        kind: "recovery_executed",
        safeCommandLabel: "linux agent restart fixed demo service",
        sanitizedOutput: '{"actionId":"restart_demo_service","exitCode":0}',
        latencyMs: 342,
      }),
      step(4, {
        role: "verifier",
        kind: "verification_completed",
        safeCommandLabel: "linux agent check fixed demo service health",
        sanitizedOutput: '{"healthy":true,"httpStatus":200,"status":"healthy"}',
        latencyMs: 220,
      }),
    ],
    result: {
      finalHealth: "healthy",
      totalLatencyMs: 12_400,
      reportedInputTokens: 6_967,
      reportedOutputTokens: 93,
      costStatus: "unavailable_chatgpt_subscription",
    },
  });
}

function runnerLossSteps() {
  return [
    step(1, {
      role: "incident_manager",
      kind: "reset_applied",
      safeCommandLabel: "linux agent stop fixed demo service",
      sanitizedOutput: '{"resetApplied":true}',
    }),
    step(2, {
      role: "incident_manager",
      kind: "failure_confirmed",
      safeCommandLabel: "linux agent check fixed demo service health",
      sanitizedOutput: '{"healthy":false}',
    }),
    step(3, {
      role: "investigator",
      kind: "safe_state_collected",
      safeCommandLabel: "linux agent inspect fixed demo service",
      sanitizedOutput: '{"status":"exited"}',
    }),
    step(4, {
      role: "investigator",
      kind: "safe_logs_collected",
      safeCommandLabel: "linux agent read fixed demo service logs",
      sanitizedOutput: "demo-service received SIGTERM",
    }),
  ];
}

function runnerLossState(
  environmentRecoveryStatus: "pending" | "restored",
  overrides: Record<string, unknown> = {},
  incidentOverrides: Record<string, unknown> = {},
) {
  const environmentRestored = environmentRecoveryStatus === "restored";
  return publicState({
    snapshotAt: BASE_TIME + (environmentRestored ? 10_000 : 8_000),
    demoCommandId: "command_runner_loss",
    commandStatus: "failed",
    commandExpiresAt: BASE_TIME + 90_000,
    runnerOnline: environmentRestored,
    runnerHeartbeatAt: environmentRestored ? BASE_TIME + 10_000 : null,
    active: false,
    incident: incident("investigation_failed", {
      status: "failed",
      finalHealth: "failed",
      finishedAt: BASE_TIME + 8_000,
      terminalReason: "runner lost after step 4: read service logs",
      lastCompletedStepSequence: 4,
      lastCompletedStepLabel: "read service logs",
      environmentRecoveryStatus,
      environmentRecoveryStartedAt: environmentRestored
        ? BASE_TIME + 9_000
        : null,
      environmentRecoveredAt: environmentRestored
        ? BASE_TIME + 10_000
        : null,
      ...incidentOverrides,
    }),
    steps: runnerLossSteps(),
    result: {
      finalHealth: "failed",
      totalLatencyMs: 8_000,
      reportedInputTokens: null,
      reportedOutputTokens: null,
      costStatus: "not_reported",
    },
    ...overrides,
  });
}

function pendingApprovalState(
  overrides: Record<string, unknown> = {},
) {
  return publicState({
    snapshotAt: BASE_TIME + 7_000,
    demoCommandId: "command_approval",
    commandStatus: "claimed",
    commandExpiresAt: BASE_TIME + 90_000,
    executionMode: "approval_required",
    active: true,
    incident: incident("awaiting_approval"),
    approval: {
      status: "pending",
      actionId: "restart_demo_service",
      actionLabel: "linux agent restart fixed demo service",
      requestedAt: BASE_TIME + 6_000,
      expiresAt: BASE_TIME + 66_000,
      decidedAt: null,
    },
    steps: [
      step(1, {
        role: "policy_gate",
        kind: "policy_decision",
        sanitizedOutput: '{"allowed":true}',
      }),
      step(2, {
        role: "policy_gate",
        kind: "approval_requested",
        status: "pending",
        safeCommandLabel: "linux agent restart fixed demo service",
        sanitizedOutput: null,
        finishedAt: null,
        latencyMs: null,
      }),
    ],
    ...overrides,
  });
}

describe("public recovery dashboard", () => {
  beforeEach(() => {
    convexMock.useQuery.mockReset();
    convexHttpMock.query.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows a live loading state without inventing an incident", () => {
    convexMock.useQuery.mockReturnValue(undefined);

    render(<DemoDashboard />);

    expect(
      screen.getByRole("status", { name: "Demo status" }),
    ).toHaveTextContent("Loading live recovery state");
    expect(
      screen.queryByText("Recovered successfully"),
    ).not.toBeInTheDocument();
  });

  it("shows runner offline in text and explains why reset is disabled", () => {
    convexMock.useQuery.mockReturnValue(
      publicState({ runnerOnline: false, runnerHeartbeatAt: null }),
    );

    render(<DemoDashboard />);

    expect(screen.getByText("Runner offline")).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Demo status" }),
    ).toHaveTextContent("Waiting for runner");
    const button = screen.getByRole("button", { name: "Run autonomous demo" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(
      "The recovery demo is unavailable because the Linux runner is offline.",
    );
  });

  it("does not claim readiness while the public demo is disabled", () => {
    convexMock.useQuery.mockReturnValue(
      publicState({ enabled: false, runnerOnline: false }),
    );

    render(<DemoDashboard />);

    expect(
      screen.getByRole("status", { name: "Demo status" }),
    ).toHaveTextContent("Public demo disabled");
    expect(screen.queryByText("Ready to run")).not.toBeInTheDocument();
  });

  it("offers autonomous and approval-required runs with the truthful public boundary", () => {
    convexMock.useQuery.mockReturnValue(publicState());

    render(<DemoDashboard />);

    expect(screen.getByText("Runner online")).toBeInTheDocument();
    expect(screen.getByText("Service ready")).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Demo status" }),
    ).toHaveTextContent("Ready to run");
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Recover one failed Linux service automatically—or pause before the restart.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/pass an allowlist policy check/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/public demo has no user account/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/does not identify an approver/i),
    ).toBeInTheDocument();
    const autonomousButton = screen.getByRole("button", {
      name: "Run autonomous demo",
    });
    const approvalButton = screen.getByRole("button", {
      name: "Run approval demo",
    });
    autonomousButton.focus();
    expect(autonomousButton).toHaveFocus();
    expect(autonomousButton).toHaveAttribute("type", "button");
    expect(autonomousButton.tabIndex).toBe(0);
    expect(autonomousButton).toBeEnabled();
    expect(approvalButton).toHaveAttribute("type", "button");
    expect(approvalButton).toBeEnabled();
    expect(screen.getByText("Verification pending")).toBeInTheDocument();
    expect(screen.queryByText("AD")).not.toBeInTheDocument();
  });

  it("posts an empty reset request and announces acceptance", async () => {
    convexMock.useQuery.mockReturnValue(publicState());
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ demoCommandId: "command_1" }), {
        status: 202,
      }),
    );

    render(<DemoDashboard />);
    fireEvent.click(screen.getByRole("button", { name: "Run autonomous demo" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/demo/reset", {
        method: "POST",
      });
    });
    expect(
      await screen.findByText("Recovery demo started. Waiting for the runner."),
    ).toHaveAttribute("aria-live", "polite");
  });

  it("announces the live phase after the accepted request advances", async () => {
    let currentState = publicState();
    convexMock.useQuery.mockImplementation(() => currentState);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ demoCommandId: "command_1" }), {
        status: 202,
      }),
    );

    const view = render(<DemoDashboard />);
    fireEvent.click(screen.getByRole("button", { name: "Run autonomous demo" }));
    expect(
      await screen.findByText("Recovery demo started. Waiting for the runner."),
    ).toBeInTheDocument();

    currentState = publicState({
      active: true,
      incident: incident("investigating"),
      steps: [step(1)],
    });
    view.rerender(<DemoDashboard />);

    expect(
      screen.getByRole("status", { name: "Demo status" }),
    ).toHaveTextContent("Investigating evidence");
    expect(
      screen.getByRole("status", { name: "Demo status" }),
    ).not.toHaveTextContent("Recovery demo started");
  });

  it("refreshes the exact accepted run once per second and stops at its terminal state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    const previousResolvedState = resolvedState();
    convexMock.useQuery.mockImplementation((_query, args) =>
      args === "skip" || (typeof args === "object" && "demoCommandId" in args)
        ? undefined
        : previousResolvedState,
    );
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ demoCommandId: "command_1" }), {
        status: 202,
      }),
    );
    convexHttpMock.query
      .mockResolvedValueOnce(
        publicState({
          snapshotAt: BASE_TIME + 1_000,
          demoCommandId: "command_1",
          commandStatus: "claimed",
          commandExpiresAt: BASE_TIME + 90_000,
          active: true,
          incident: incident("investigating"),
          steps: [step(1)],
        }),
      )
      .mockResolvedValueOnce({
        ...resolvedState(),
        snapshotAt: BASE_TIME + 2_000,
        demoCommandId: "command_1",
        commandStatus: "complete",
        commandExpiresAt: BASE_TIME + 90_000,
      });

    render(<DemoDashboard />);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Run autonomous demo" }),
      );
      await Promise.resolve();
    });
    expect(
      screen.getByRole("status", { name: "Demo status" }),
    ).toHaveTextContent("Runner starting recovery");
    expect(screen.queryByText("12.4s")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(
      screen.getByRole("status", { name: "Demo status" }),
    ).toHaveTextContent("Investigating evidence");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(
      screen.getByRole("status", { name: "Demo status" }),
    ).toHaveTextContent("Recovered successfully");
    const callsAtTerminalState = convexHttpMock.query.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(convexHttpMock.query).toHaveBeenCalledTimes(callsAtTerminalState);
  });

  it("refreshes the exact accepted run once per second into persisted runner loss and then stops", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    const previousResolvedState = resolvedState();
    convexMock.useQuery.mockImplementation((_query, args) =>
      args === "skip" || (typeof args === "object" && "demoCommandId" in args)
        ? undefined
        : previousResolvedState,
    );
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ demoCommandId: "command_runner_loss" }), {
        status: 202,
      }),
    );
    convexHttpMock.query
      .mockResolvedValueOnce(
        publicState({
          snapshotAt: BASE_TIME + 1_000,
          demoCommandId: "command_runner_loss",
          commandStatus: "failure_confirmed",
          commandExpiresAt: BASE_TIME + 90_000,
          active: true,
          incident: incident("investigating"),
          steps: runnerLossSteps(),
        }),
      )
      .mockResolvedValueOnce(
        runnerLossState("pending", {
          snapshotAt: BASE_TIME + 2_000,
          runnerOnline: false,
          runnerHeartbeatAt: null,
        }),
      );

    render(<DemoDashboard />);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Run autonomous demo" }),
      );
      await Promise.resolve();
    });
    expect(screen.queryByText("12.4s")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(
      screen.getByRole("status", { name: "Demo status" }),
    ).toHaveTextContent("Investigating evidence");
    expect(convexHttpMock.query).toHaveBeenLastCalledWith(expect.anything(), {
      demoCommandId: "command_runner_loss",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const callsAtRunnerLoss = convexHttpMock.query.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(convexHttpMock.query).toHaveBeenCalledTimes(callsAtRunnerLoss);
    expect(screen.queryByText("Recovered successfully")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Runner lost after step 4: read service logs"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Restoration pending until the runner reconnects"),
    ).toBeInTheDocument();
  });

  it("reports an accepted reset honestly when its response body is unreadable", async () => {
    convexMock.useQuery.mockReturnValue(publicState());
    vi.mocked(fetch).mockResolvedValue(
      new Response("not-json", { status: 202 }),
    );

    render(<DemoDashboard />);
    fireEvent.click(screen.getByRole("button", { name: "Run autonomous demo" }));

    expect(
      await screen.findByText(
        "Recovery demo was accepted. Waiting for live state.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("The demo could not start. No action was taken."),
    ).not.toBeInTheDocument();
  });

  it("bounds fallback refreshes when the runner disappears", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    convexMock.useQuery.mockImplementation((_query, args) =>
      args === "skip" || (typeof args === "object" && "demoCommandId" in args)
        ? undefined
        : publicState(),
    );
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ demoCommandId: "command_1" }), {
        status: 202,
      }),
    );
    convexHttpMock.query.mockRejectedValue(new Error("runner unavailable"));

    render(<DemoDashboard />);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Run autonomous demo" }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_500);
    });
    const callsAtExpiry = convexHttpMock.query.mock.calls.length;
    expect(callsAtExpiry).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(convexHttpMock.query).toHaveBeenCalledTimes(callsAtExpiry);
  });

  it("shows the active phase in text and blocks a second run", () => {
    convexMock.useQuery.mockReturnValue(
      publicState({
        active: true,
        incident: incident("investigating"),
        steps: [step(1)],
      }),
    );

    render(<DemoDashboard />);

    expect(
      screen.getByRole("status", { name: "Demo status" }),
    ).toHaveTextContent("Investigating evidence");
    const button = screen.getByRole("button", { name: "Run autonomous demo" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(
      "The recovery demo is unavailable while an incident is active.",
    );
  });

  it("shows the measured cooldown and its disabled reason", () => {
    convexMock.useQuery.mockReturnValue(
      publicState({
        cooldownRemainingMs: 12_500,
        cooldownUntil: Date.now() + 12_500,
      }),
    );

    render(<DemoDashboard />);

    expect(screen.getByText("Demo available in 13s")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Run autonomous demo" }),
    ).toBeDisabled();
  });

  it("stops the cooldown clock after the deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    convexMock.useQuery.mockReturnValue(
      publicState({
        cooldownRemainingMs: 1_500,
        cooldownUntil: BASE_TIME + 1_500,
      }),
    );

    render(<DemoDashboard />);
    act(() => vi.advanceTimersByTime(2_000));
    const callsAtExpiry = convexMock.useQuery.mock.calls.length;
    act(() => vi.advanceTimersByTime(1_500));

    expect(convexMock.useQuery).toHaveBeenCalledTimes(callsAtExpiry);
    expect(
      screen.getByRole("button", { name: "Run autonomous demo" }),
    ).toBeEnabled();
  });

  it("marks the runner offline when a heartbeat becomes stale without a new query", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    convexMock.useQuery.mockReturnValue(
      publicState({ runnerOnline: true, runnerHeartbeatAt: BASE_TIME }),
    );

    render(<DemoDashboard />);
    expect(screen.getByText("Runner online")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(15_100));

    expect(screen.getByText("Runner offline")).toBeInTheDocument();
    expect(screen.getByText("Service unavailable")).toHaveClass(
      "badge-neutral",
    );
    expect(
      screen.getByRole("button", { name: "Run autonomous demo" }),
    ).toBeDisabled();
  });

  it("renders persisted runner loss in the resolution location while restoration is pending", () => {
    convexMock.useQuery.mockReturnValue(runnerLossState("pending"));

    render(<DemoDashboard />);

    const resolutionHeading = screen.getByRole("heading", {
      name: "Resolution record",
    });
    const resolutionPanel = resolutionHeading.closest("aside");
    const timelineHeading = screen.getByRole("heading", {
      name: "Incident timeline",
    });
    const lastStep = screen.queryByText("Step 4 · Read service logs");
    const reason = screen.queryByText(
      "Runner lost after step 4: read service logs",
    );
    const pending = screen.queryByText(
      "Restoration pending until the runner reconnects",
    );

    expect(resolutionPanel).not.toBeNull();
    expect(resolutionPanel?.querySelector(".outcome-banner-danger")).not.toBeNull();
    expect(lastStep).toBeInTheDocument();
    expect(reason).toBeInTheDocument();
    expect(pending).toBeInTheDocument();
    expect(resolutionPanel).toContainElement(lastStep);
    expect(resolutionPanel).toContainElement(reason);
    expect(resolutionPanel).toContainElement(pending);
    expect(
      screen.queryByText("Demo environment restored and healthy"),
    ).not.toBeInTheDocument();
    expect(
      resolutionHeading.compareDocumentPosition(timelineHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Run autonomous demo" }),
    ).toBeDisabled();
  });

  it("explains a failed restoration attempt without blaming a disconnected runner", () => {
    convexMock.useQuery.mockReturnValue(
      runnerLossState(
        "pending",
        {},
        {
          environmentRecoveryError:
            "Demo environment restoration failed; retry required.",
        },
      ),
    );

    render(<DemoDashboard />);

    expect(
      screen.getByText(
        "The last restoration attempt failed. The runner will retry automatically.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Restoration pending until the runner reconnects"),
    ).not.toBeInTheDocument();
  });

  it("keeps reset disabled until the runner is online and restoration is verified", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    let currentState = runnerLossState("pending", {
      runnerOnline: false,
      runnerHeartbeatAt: null,
    });
    convexMock.useQuery.mockImplementation(() => currentState);

    const view = render(<DemoDashboard />);
    const button = screen.getByRole("button", { name: "Run autonomous demo" });
    expect(button).toBeDisabled();
    expect(screen.getByText("Service unavailable")).toHaveClass(
      "badge-neutral",
    );

    currentState = runnerLossState("pending", {
      snapshotAt: BASE_TIME + 9_000,
      runnerOnline: true,
      runnerHeartbeatAt: BASE_TIME,
    });
    view.rerender(<DemoDashboard />);
    expect.soft(button).toBeDisabled();
    expect.soft(
      screen.queryByText(
        "Restoration queued; the runner will restore it automatically",
      ),
    ).toBeInTheDocument();
    expect.soft(
      screen.queryByText("Restoration pending until the runner reconnects"),
    ).not.toBeInTheDocument();
    expect.soft(screen.getByText("Service restoring")).toHaveClass(
      "badge-neutral",
    );

    currentState = runnerLossState("restored", {
      runnerOnline: true,
      runnerHeartbeatAt: BASE_TIME,
    });
    view.rerender(<DemoDashboard />);
    expect.soft(button).toBeEnabled();
    expect.soft(
      screen.queryByText("Demo environment restored and healthy"),
    ).toBeInTheDocument();
    expect.soft(
      screen.queryByText("Restoration pending until the runner reconnects"),
    ).not.toBeInTheDocument();
    expect
      .soft(screen.queryByText("Recovered successfully"))
      .not.toBeInTheDocument();
    expect.soft(
      screen.queryByText("Runner lost after step 4: read service logs"),
    ).toBeInTheDocument();
    expect.soft(screen.getByText("Service healthy")).toHaveClass(
      "badge-online",
    );
    expect.soft(screen.queryByText("Service unhealthy")).not.toBeInTheDocument();
  });

  it("marks a restored service unavailable when its runner heartbeat becomes stale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    convexMock.useQuery.mockReturnValue(
      runnerLossState("restored", {
        runnerOnline: true,
        runnerHeartbeatAt: BASE_TIME,
      }),
    );

    render(<DemoDashboard />);
    expect(screen.getByText("Runner online")).toBeInTheDocument();
    expect(screen.getByText("Service healthy")).toHaveClass("badge-online");

    act(() => vi.advanceTimersByTime(3_999));
    expect(screen.getByText("Runner online")).toBeInTheDocument();
    expect(screen.getByText("Service healthy")).toHaveClass("badge-online");

    act(() => vi.advanceTimersByTime(1));

    expect(screen.getByText("Runner offline")).toBeInTheDocument();
    expect(screen.getByText("Service unavailable")).toHaveClass(
      "badge-neutral",
    );
    expect(screen.queryByText("Service healthy")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Run autonomous demo" }),
    ).toBeDisabled();
  });

  it("renders a concise resolved trace without public model, cost, or login metadata", () => {
    convexMock.useQuery.mockReturnValue(resolvedState());

    render(<DemoDashboard />);

    expect(
      screen.getAllByText("Recovered successfully").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Healthy after fresh check").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("12.4s")).toBeInTheDocument();
    expect(
      screen.queryByText("Cost unavailable with ChatGPT subscription login"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Input 6,967 · Output 93 tokens"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("$0")).not.toBeInTheDocument();
    expect(screen.queryByText("$")).not.toBeInTheDocument();
    expect(screen.getAllByText("Operation").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "Executed the allowlisted, policy-checked recovery action",
      ),
    ).toBeInTheDocument();
    const evidenceControls = screen.getAllByText("View raw evidence");
    expect(evidenceControls.length).toBeGreaterThan(0);
    expect(
      evidenceControls.every(
        (control) => !control.closest("details")?.hasAttribute("open"),
      ),
    ).toBe(true);
    expect(screen.getByText("Verified healthy")).toHaveClass("rail-healthy");
    expect(
      screen.queryByText("Runner lost after step 4: read service logs"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Restoration pending until the runner reconnects"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Demo environment restored and healthy"),
    ).not.toBeInTheDocument();

    const resolution = screen.getByRole("heading", {
      name: "Resolution record",
    });
    const timeline = screen.getByRole("heading", { name: "Incident timeline" });
    expect(
      resolution.compareDocumentPosition(timeline) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows a needs-human outcome without implying an action ran", () => {
    convexMock.useQuery.mockReturnValue(
      publicState({
        incident: incident("needs_human", {
          requiresHuman: true,
          proposedActionId: "no_action",
          finishedAt: BASE_TIME + 4_000,
          terminalReason: "human_approval_required",
        }),
        steps: [
          step(1, {
            role: "policy_gate",
            kind: "policy_decision",
            status: "blocked",
            safeCommandLabel: null,
            sanitizedOutput: '{"allowed":false}',
          }),
        ],
        result: {
          finalHealth: "failed",
          totalLatencyMs: 4_000,
          reportedInputTokens: null,
          reportedOutputTokens: null,
          costStatus: "not_reported",
        },
      }),
    );

    render(<DemoDashboard />);

    expect(
      screen.getByText("Investigation complete, human decision required"),
    ).toBeInTheDocument();
    expect(screen.getByText("No recovery action executed")).toBeInTheDocument();
    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(screen.getByText("Needs human")).toHaveClass("rail-warning");
    expect(screen.queryByText("Verified healthy")).not.toBeInTheDocument();
  });

  it("shows failed recovery and preserves the unhealthy final state", () => {
    convexMock.useQuery.mockReturnValue(
      publicState({
        incident: incident("failed_recovery", {
          finalHealth: "failed",
          finishedAt: BASE_TIME + 7_000,
          terminalReason: "restart_did_not_recover_service",
        }),
        steps: [
          step(1, {
            role: "executor",
            kind: "recovery_executed",
            safeCommandLabel: "linux agent restart fixed demo service",
          }),
          step(2, {
            role: "verifier",
            kind: "verification_completed",
            status: "failed",
            safeCommandLabel: "linux agent check fixed demo service health",
            sanitizedOutput: '{"healthy":false,"httpStatus":503}',
          }),
        ],
        result: {
          finalHealth: "failed",
          totalLatencyMs: 7_000,
          reportedInputTokens: null,
          reportedOutputTokens: null,
          costStatus: "not_reported",
        },
      }),
    );

    render(<DemoDashboard />);

    expect(
      screen.getAllByText("Recovery failed verification").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Still unhealthy after fresh check").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Service unhealthy")).toBeInTheDocument();
    expect(screen.getByText("Verification failed")).toHaveClass("rail-failed");
    expect(screen.queryByText("Verified healthy")).not.toBeInTheDocument();
  });

  it("records a failed recovery attempt instead of saying no action ran", () => {
    convexMock.useQuery.mockReturnValue(
      publicState({
        incident: incident("failed_recovery", {
          finalHealth: "failed",
          finishedAt: BASE_TIME + 2_000,
          terminalReason: "fixed_restart_failed",
        }),
        steps: [
          step(1, {
            role: "executor",
            kind: "recovery_failed",
            status: "failed",
            safeCommandLabel: "linux agent restart fixed demo service",
            sanitizedOutput: null,
            errorSummary: "The fixed recovery action failed.",
          }),
        ],
        result: {
          finalHealth: "failed",
          totalLatencyMs: 2_000,
          reportedInputTokens: null,
          reportedOutputTokens: null,
          costStatus: "not_reported",
        },
      }),
    );

    render(<DemoDashboard />);

    expect(
      screen.getByText(
        "linux agent restart fixed demo service · attempt failed",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No recovery action executed"),
    ).not.toBeInTheDocument();
  });

  it("continues to render a legacy stored Docker operation label", () => {
    convexMock.useQuery.mockReturnValue(
      publicState({
        incident: incident("failed_recovery", {
          finalHealth: "failed",
          finishedAt: BASE_TIME + 2_000,
          terminalReason: "fixed_restart_failed",
        }),
        steps: [
          step(1, {
            role: "executor",
            kind: "recovery_failed",
            status: "failed",
            safeCommandLabel: "docker start fixed demo service",
            sanitizedOutput: null,
            errorSummary: "The fixed recovery action failed.",
          }),
        ],
        result: {
          finalHealth: "failed",
          totalLatencyMs: 2_000,
          reportedInputTokens: null,
          reportedOutputTokens: null,
          costStatus: "not_reported",
        },
      }),
    );

    render(<DemoDashboard />);

    expect(
      screen.getByText("docker start fixed demo service · attempt failed"),
    ).toBeInTheDocument();
  });

  it("shows an investigation failure as requiring an engineer", () => {
    convexMock.useQuery.mockReturnValue(
      publicState({
        incident: incident("investigation_failed", {
          diagnosisEvidence: null,
          diagnosisSummary: null,
          confidence: null,
          proposedActionId: null,
          finishedAt: BASE_TIME + 3_000,
          terminalReason: "codex_timeout",
        }),
        steps: [
          step(1, {
            kind: "diagnosis_failed",
            status: "failed",
            sanitizedOutput: null,
            errorSummary: "The bounded investigation did not complete.",
          }),
        ],
        result: {
          finalHealth: "failed",
          totalLatencyMs: 3_000,
          reportedInputTokens: null,
          reportedOutputTokens: null,
          costStatus: "not_reported",
        },
      }),
    );

    render(<DemoDashboard />);

    expect(
      screen.getByText("Investigation did not complete"),
    ).toBeInTheDocument();
    expect(screen.getByText("Service unhealthy")).toBeInTheDocument();
    expect(screen.getByText("Required")).toBeInTheDocument();
  });

  it("does not expose partial model-usage metadata", () => {
    convexMock.useQuery.mockReturnValue(
      publicState({
        active: true,
        incident: incident("investigating"),
        steps: [
          step(1, {
            kind: "diagnosis_completed",
            reportedInputTokens: 42,
            reportedOutputTokens: null,
          }),
        ],
      }),
    );

    render(<DemoDashboard />);

    expect(screen.queryByText("Input 42 tokens")).not.toBeInTheDocument();
    expect(screen.queryByText(/Output 0/)).not.toBeInTheDocument();
  });

  it("carries rounded seconds into the next minute", () => {
    const state = resolvedState();
    state.result = {
      ...(state.result as Record<string, unknown>),
      totalLatencyMs: 119_600,
    };
    convexMock.useQuery.mockReturnValue(state);

    render(<DemoDashboard />);

    expect(screen.getByText("2m 0s")).toBeInTheDocument();
    expect(screen.queryByText("1m 60s")).not.toBeInTheDocument();
  });

  it("starts the approval-required path through its fixed empty route", async () => {
    convexMock.useQuery.mockReturnValue(publicState());
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ demoCommandId: "command_approval" }), {
        status: 202,
      }),
    );

    render(<DemoDashboard />);
    fireEvent.click(
      screen.getByRole("button", { name: "Run approval demo" }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/demo/reset/approval-required",
        { method: "POST" },
      );
    });
    expect(
      await screen.findByText("Approval demo started. Waiting for the runner."),
    ).toHaveAttribute("aria-live", "polite");
  });

  it("shows the initiating browser an embedded approval checkpoint", async () => {
    convexMock.useQuery.mockReturnValue(pendingApprovalState());
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ canDecide: true }), { status: 200 }),
    );

    render(<DemoDashboard />);

    const gate = await screen.findByRole("region", {
      name: "Approve the staged restart?",
    });
    expect(gate).toHaveTextContent("linux agent restart fixed demo service");
    expect(gate).toHaveTextContent(
      "This public demo has no user account. The decision applies only to the disposable service and does not identify an approver.",
    );
    expect(
      screen.getByRole("button", { name: "Approve staged restart" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Reject and restore demo" }),
    ).toBeEnabled();
    expect(screen.getByText("Service stopped")).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Demo status" }),
    ).toHaveTextContent("Waiting for browser approval");
    expect(fetchMock).toHaveBeenCalledWith("/api/demo/approval/session", {
      method: "GET",
    });
  });

  it("keeps spectators read-only without implying an approver identity", async () => {
    convexMock.useQuery.mockReturnValue(pendingApprovalState());
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ canDecide: false }), { status: 200 }),
    );

    render(<DemoDashboard />);

    expect(
      await screen.findByRole("heading", {
        name: "Waiting for the initiating browser",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Only the browser that started this run can approve or reject it.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve staged restart" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reject and restore demo" }),
    ).not.toBeInTheDocument();
  });

  it("rechecks the starting browser when the approval phase opens after an early read-only response", async () => {
    let currentState = pendingApprovalState({
      incident: incident("policy_check"),
    });
    convexMock.useQuery.mockImplementation(() => currentState);
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ canDecide: false }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ canDecide: true }), { status: 200 }),
      );

    const view = render(<DemoDashboard />);

    expect(
      await screen.findByRole("heading", {
        name: "Waiting for the initiating browser",
      }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    currentState = pendingApprovalState();
    view.rerender(<DemoDashboard />);

    expect(
      await screen.findByRole("button", { name: "Approve staged restart" }),
    ).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("marks the pending approval checkpoint as the current timeline step", () => {
    convexMock.useQuery.mockReturnValue(pendingApprovalState());
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ canDecide: false }), { status: 200 }),
    );

    render(<DemoDashboard />);

    expect(
      screen
        .getByText("Paused before the fixed restart for browser approval")
        .closest("li"),
    ).toHaveAttribute("aria-current", "step");
  });

  it("retries a failed approval-session lookup without claiming a decision", async () => {
    convexMock.useQuery.mockReturnValue(pendingApprovalState());
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockRejectedValueOnce(new Error("session unavailable"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ canDecide: true }), { status: 200 }),
      );

    render(<DemoDashboard />);

    expect(
      await screen.findByRole("heading", {
        name: "Decision access unavailable",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/retry before the approval window closes/i),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry decision access" }),
    );

    expect(
      await screen.findByRole("button", { name: "Approve staged restart" }),
    ).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("describes an approved and verified restart as completed history", () => {
    convexMock.useQuery.mockReturnValue(
      pendingApprovalState({
        active: false,
        commandStatus: "complete",
        incident: incident("resolved", {
          finalHealth: "healthy",
          finishedAt: BASE_TIME + 12_000,
        }),
        approval: {
          status: "approved",
          actionId: "restart_demo_service",
          actionLabel: "linux agent restart fixed demo service",
          requestedAt: BASE_TIME + 6_000,
          expiresAt: BASE_TIME + 306_000,
          decidedAt: BASE_TIME + 8_000,
        },
        steps: [
          step(3, {
            role: "executor",
            kind: "recovery_executed",
            safeCommandLabel: "linux agent restart fixed demo service",
          }),
          step(4, {
            role: "verifier",
            kind: "verification_completed",
            safeCommandLabel: "linux agent check fixed demo service health",
            sanitizedOutput: '{"healthy":true}',
          }),
        ],
      }),
    );

    render(<DemoDashboard />);

    const gate = screen.getByRole("region", {
      name: "Approved restart completed",
    });
    expect(gate).toHaveTextContent(
      "The fixed restart ran and a fresh health check verified the service is healthy.",
    );
    expect(gate).toHaveTextContent("Fixed executed action");
    expect(gate).not.toHaveTextContent("Fixed proposed action");
    expect(gate).not.toHaveTextContent(/may resume/i);
  });

  it("describes an approved failed recovery without claiming verification", () => {
    convexMock.useQuery.mockReturnValue(
      pendingApprovalState({
        active: false,
        commandStatus: "failed",
        incident: incident("failed_recovery", {
          finalHealth: "failed",
          finishedAt: BASE_TIME + 12_000,
        }),
        approval: {
          status: "approved",
          actionId: "restart_demo_service",
          actionLabel: "linux agent restart fixed demo service",
          requestedAt: BASE_TIME + 6_000,
          expiresAt: BASE_TIME + 306_000,
          decidedAt: BASE_TIME + 8_000,
        },
        steps: [
          step(3, {
            role: "executor",
            kind: "recovery_failed",
            status: "failed",
            safeCommandLabel: "linux agent restart fixed demo service",
          }),
        ],
      }),
    );

    render(<DemoDashboard />);

    const gate = screen.getByRole("region", {
      name: "Approved recovery did not verify",
    });
    expect(gate).toHaveTextContent(
      "The fixed restart was authorized and attempted, but recovery did not finish with verified health.",
    );
    expect(gate).toHaveTextContent("Fixed attempted action");
    expect(gate).not.toHaveTextContent("Fixed proposed action");
    expect(gate).not.toHaveTextContent(/may resume/i);
  });

  it.each([
    ["rejected", "Staged restart rejected"],
    ["expired", "Approval window expired"],
  ] as const)(
    "describes a %s approval after restoration as completed history",
    (status, heading) => {
      convexMock.useQuery.mockReturnValue(
        pendingApprovalState({
          active: false,
          commandStatus: "complete",
          incident: incident("needs_human", {
            finalHealth: "failed",
            finishedAt: BASE_TIME + 12_000,
            environmentRecoveryStatus: "restored",
            environmentRecoveryStartedAt: BASE_TIME + 9_000,
            environmentRecoveredAt: BASE_TIME + 12_000,
          }),
          approval: {
            status,
            actionId: "restart_demo_service",
            actionLabel: "linux agent restart fixed demo service",
            requestedAt: BASE_TIME + 6_000,
            expiresAt: BASE_TIME + 306_000,
            decidedAt: BASE_TIME + 8_000,
          },
        }),
      );

      render(<DemoDashboard />);

      const gate = screen.getByRole("region", { name: heading });
      expect(gate).toHaveTextContent(
        "No recovery action was authorized. The demo environment was restored and is healthy.",
      );
      expect(gate).not.toHaveTextContent("will be restored");
    },
  );

  it("moves focus to the updated checkpoint after this browser decides", async () => {
    let currentState = pendingApprovalState();
    convexMock.useQuery.mockImplementation(() => currentState);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input) =>
      input === "/api/demo/approval/session"
        ? new Response(JSON.stringify({ canDecide: true }), { status: 200 })
        : new Response(null, { status: 200 }),
    );

    const view = render(<DemoDashboard />);
    const approveButton = await screen.findByRole("button", {
      name: "Approve staged restart",
    });
    approveButton.focus();
    fireEvent.click(approveButton);
    expect(
      await screen.findByText(
        "Approval recorded. The Linux runner can resume the staged restart.",
      ),
    ).toBeInTheDocument();

    currentState = pendingApprovalState({
      active: false,
      commandStatus: "complete",
      incident: incident("resolved", {
        finalHealth: "healthy",
        finishedAt: BASE_TIME + 12_000,
      }),
      approval: {
        status: "approved",
        actionId: "restart_demo_service",
        actionLabel: "linux agent restart fixed demo service",
        requestedAt: BASE_TIME + 6_000,
        expiresAt: BASE_TIME + 306_000,
        decidedAt: BASE_TIME + 8_000,
      },
      steps: [
        step(3, {
          role: "executor",
          kind: "recovery_executed",
          safeCommandLabel: "linux agent restart fixed demo service",
        }),
        step(4, {
          role: "verifier",
          kind: "verification_completed",
          safeCommandLabel: "linux agent check fixed demo service health",
          sanitizedOutput: '{"healthy":true}',
        }),
      ],
    });
    view.rerender(<DemoDashboard />);

    expect(
      await screen.findByRole("heading", {
        name: "Approved restart completed",
      }),
    ).toHaveFocus();
    expect(fetchMock).toHaveBeenCalledWith("/api/demo/approval/approve", {
      method: "POST",
    });
  });

  it("records a rejected approval without saying a decision is still required", () => {
    const state = pendingApprovalState({
      active: false,
      commandStatus: "complete",
      incident: incident("needs_human", {
        finalHealth: "failed",
        finishedAt: BASE_TIME + 8_000,
        terminalReason: "approval_rejected",
      }),
      approval: {
        status: "rejected",
        actionId: "restart_demo_service",
        actionLabel: "linux agent restart fixed demo service",
        requestedAt: BASE_TIME + 6_000,
        expiresAt: BASE_TIME + 66_000,
        decidedAt: BASE_TIME + 8_000,
      },
      result: {
        finalHealth: "failed",
        totalLatencyMs: 8_000,
      },
    });
    convexMock.useQuery.mockReturnValue(state);

    render(<DemoDashboard />);

    const resolution = screen
      .getByRole("heading", { name: "Resolution record" })
      .closest("aside");
    expect(resolution).toHaveTextContent("Staged restart rejected");
    expect(resolution).toHaveTextContent("No recovery action was authorized");
    expect(resolution).not.toHaveTextContent("human decision required");
    expect(
      screen.getByRole("status", { name: "Demo status" }),
    ).toHaveTextContent("Staged restart rejected");
    expect(
      screen.queryByRole("button", { name: "Approve staged restart" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    {
      button: "Approve staged restart",
      route: "/api/demo/approval/approve",
      pendingLabel: "Recording approval…",
      accepted:
        "Approval recorded. The Linux runner can resume the staged restart.",
    },
    {
      button: "Reject and restore demo",
      route: "/api/demo/approval/reject",
      pendingLabel: "Recording rejection…",
      accepted:
        "Rejection recorded. No recovery action was authorized.",
    },
  ])(
    "submits the fixed bodyless decision route for $button",
    async ({ button, route, pendingLabel, accepted }) => {
      convexMock.useQuery.mockReturnValue(pendingApprovalState());
      const fetchMock = vi.mocked(fetch);
      let finishDecision: ((response: Response) => void) | undefined;
      fetchMock.mockImplementation(async (input) => {
        if (input === "/api/demo/approval/session") {
          return new Response(JSON.stringify({ canDecide: true }), {
            status: 200,
          });
        }
        return await new Promise<Response>((resolve) => {
          finishDecision = resolve;
        });
      });

      render(<DemoDashboard />);
      fireEvent.click(await screen.findByRole("button", { name: button }));

      expect(
        await screen.findByRole("button", { name: pendingLabel }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", {
          name:
            button === "Approve staged restart"
              ? "Reject and restore demo"
              : "Approve staged restart",
        }),
      ).toBeDisabled();
      expect(fetchMock).toHaveBeenCalledWith(route, { method: "POST" });
      const decisionCall = fetchMock.mock.calls.find(
        ([input]) => input === route,
      );
      expect(decisionCall?.[1]).not.toHaveProperty("body");

      await act(async () => {
        finishDecision?.(new Response(null, { status: 202 }));
      });
      expect(await screen.findByText(accepted)).toHaveAttribute(
        "aria-live",
        "polite",
      );
    },
  );

  it("keeps the approval checkpoint and resolution before the timeline on phone", async () => {
    convexMock.useQuery.mockReturnValue(pendingApprovalState());
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ canDecide: false }), { status: 200 }),
    );

    render(<DemoDashboard />);

    const approval = (
      await screen.findByRole("heading", {
        name: "Waiting for the initiating browser",
      })
    ).closest("section");
    const resolution = screen
      .getByRole("heading", { name: "Resolution record" })
      .closest("aside");
    const timeline = screen
      .getByRole("heading", { name: "Incident timeline" })
      .closest("section");
    expect(approval).not.toBeNull();
    expect(resolution).not.toBeNull();
    expect(timeline).not.toBeNull();
    expect(
      approval!.compareDocumentPosition(resolution!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      resolution!.compareDocumentPosition(timeline!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const css = readFileSync(
      join(process.cwd(), "src/app/globals.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.approval-action[\s\S]*?min-height:\s*(?:4[4-9]|[5-9]\d)px/,
    );
    expect(css).toMatch(
      /@media \(max-width: 620px\)[\s\S]*?\.approval-actions[\s\S]*?grid-template-columns:\s*1fr/,
    );
  });

  it("wraps long sanitized output and never renders extra secret fields", () => {
    const secret = "runner-token-must-never-render";
    const rawPrompt = "raw-system-prompt-must-never-render";
    convexMock.useQuery.mockReturnValue(
      publicState({
        active: true,
        incident: incident("investigating"),
        steps: [
          {
            ...step(1, {
              sanitizedOutput: `bounded-${"evidence".repeat(80)}`,
            }),
            requestSecret: secret,
            rawPrompt,
          },
        ],
        requestSecret: secret,
        rawPrompt,
      }),
    );

    render(<DemoDashboard />);

    expect(screen.getByTestId("trace-output")).toHaveClass("trace-output");
    const css = readFileSync(
      join(process.cwd(), "src/app/globals.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.trace-output[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?white-space:\s*pre-wrap;/,
    );
    expect(document.body).not.toHaveTextContent(secret);
    expect(document.body).not.toHaveTextContent(rawPrompt);
  });
});
