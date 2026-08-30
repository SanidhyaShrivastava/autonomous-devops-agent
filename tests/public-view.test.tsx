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

const convexMock = vi.hoisted(() => ({
  useQuery: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: convexMock.useQuery,
}));

import { DemoDashboard } from "@/components/demo-dashboard";

const BASE_TIME = Date.UTC(2026, 7, 30, 14, 0, 0);

function publicState(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runnerOnline: true,
    enabled: true,
    active: false,
    runnerHeartbeatAt: BASE_TIME,
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
    safeCommandLabel: "docker logs --tail 30 fixed demo service",
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
        safeCommandLabel: "docker start fixed demo service",
        sanitizedOutput: '{"actionId":"restart_demo_service","exitCode":0}',
        latencyMs: 342,
      }),
      step(4, {
        role: "verifier",
        kind: "verification_completed",
        safeCommandLabel: "HTTP GET fixed demo health",
        sanitizedOutput:
          '{"healthy":true,"httpStatus":200,"status":"healthy"}',
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

describe("public recovery dashboard", () => {
  beforeEach(() => {
    convexMock.useQuery.mockReset();
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

    expect(screen.getByRole("status", { name: "Demo status" })).toHaveTextContent(
      "Loading live recovery state",
    );
    expect(screen.queryByText("Recovered successfully")).not.toBeInTheDocument();
  });

  it("shows runner offline in text and explains why reset is disabled", () => {
    convexMock.useQuery.mockReturnValue(
      publicState({ runnerOnline: false, runnerHeartbeatAt: null }),
    );

    render(<DemoDashboard />);

    expect(screen.getByText("Runner offline")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Demo status" })).toHaveTextContent(
      "Waiting for runner",
    );
    const button = screen.getByRole("button", { name: "Reset demo" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(
      "Reset is unavailable because the Linux runner is offline.",
    );
  });

  it("does not claim readiness while the public demo is disabled", () => {
    convexMock.useQuery.mockReturnValue(
      publicState({ enabled: false, runnerOnline: false }),
    );

    render(<DemoDashboard />);

    expect(screen.getByRole("status", { name: "Demo status" })).toHaveTextContent(
      "Public demo disabled",
    );
    expect(screen.queryByText("Ready for reset")).not.toBeInTheDocument();
  });

  it("shows a ready state and keeps the native button keyboard focusable", () => {
    convexMock.useQuery.mockReturnValue(publicState());

    render(<DemoDashboard />);

    expect(screen.getByText("Runner online")).toBeInTheDocument();
    expect(screen.getByText("Service ready")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Demo status" })).toHaveTextContent(
      "Ready for reset",
    );
    const button = screen.getByRole("button", { name: "Reset demo" });
    button.focus();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("type", "button");
    expect(button.tabIndex).toBe(0);
    expect(button).toBeEnabled();
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
    fireEvent.click(screen.getByRole("button", { name: "Reset demo" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/demo/reset", {
        method: "POST",
      });
    });
    expect(
      await screen.findByText("Reset accepted. Waiting for the runner."),
    ).toHaveAttribute("aria-live", "polite");
  });

  it("announces the live phase after the accepted request advances", async () => {
    let currentState = publicState();
    convexMock.useQuery.mockImplementation(() => currentState);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));

    const view = render(<DemoDashboard />);
    fireEvent.click(screen.getByRole("button", { name: "Reset demo" }));
    expect(
      await screen.findByText("Reset accepted. Waiting for the runner."),
    ).toBeInTheDocument();

    currentState = publicState({
      active: true,
      incident: incident("investigating"),
      steps: [step(1)],
    });
    view.rerender(<DemoDashboard />);

    expect(screen.getByRole("status", { name: "Demo status" })).toHaveTextContent(
      "Investigating evidence",
    );
    expect(
      screen.getByRole("status", { name: "Demo status" }),
    ).not.toHaveTextContent("Reset accepted");
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

    expect(screen.getByRole("status", { name: "Demo status" })).toHaveTextContent(
      "Investigating evidence",
    );
    const button = screen.getByRole("button", { name: "Reset demo" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(
      "Reset is unavailable while an incident is active.",
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

    expect(screen.getByText("Reset available in 13s")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset demo" })).toBeDisabled();
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
    act(() => vi.advanceTimersByTime(5_000));

    expect(convexMock.useQuery).toHaveBeenCalledTimes(callsAtExpiry);
    expect(screen.getByRole("button", { name: "Reset demo" })).toBeEnabled();
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
    expect(screen.getByText("Service unavailable")).toHaveClass("badge-neutral");
    expect(screen.getByRole("button", { name: "Reset demo" })).toBeDisabled();
  });

  it("renders a resolved trace and measured result without claiming zero cost", () => {
    convexMock.useQuery.mockReturnValue(resolvedState());

    render(<DemoDashboard />);

    expect(screen.getAllByText("Recovered successfully").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Healthy after fresh check").length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("12.4s")).toBeInTheDocument();
    expect(
      screen.getByText("Cost unavailable with ChatGPT subscription login"),
    ).toBeInTheDocument();
    expect(screen.getByText("Input 6,967 · Output 93 tokens")).toBeInTheDocument();
    expect(screen.queryByText("$0")).not.toBeInTheDocument();
    expect(screen.getByText("Verified healthy")).toHaveClass("rail-healthy");
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
            safeCommandLabel: "docker start fixed demo service",
          }),
          step(2, {
            role: "verifier",
            kind: "verification_completed",
            status: "failed",
            safeCommandLabel: "HTTP GET fixed demo health",
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
    expect(screen.queryByText("No recovery action executed")).not.toBeInTheDocument();
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

    expect(screen.getByText("Investigation did not complete")).toBeInTheDocument();
    expect(screen.getByText("Service unhealthy")).toBeInTheDocument();
    expect(screen.getByText("Required")).toBeInTheDocument();
  });

  it("does not invent a missing token count", () => {
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

    expect(screen.getByText("Input 42 tokens")).toBeInTheDocument();
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
