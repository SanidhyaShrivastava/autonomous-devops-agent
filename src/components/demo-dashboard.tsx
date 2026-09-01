"use client";

import { ConvexHttpClient } from "convex/browser";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { PUBLIC_APP_HEADLINE } from "@/lib/public-copy";
import {
  ApprovalGate,
  type ApprovalDecisionNotice,
  type ApprovalSessionStatus,
  type PublicApproval,
} from "./approval-gate";
import { IncidentTimeline } from "./incident-timeline";
import { ResolutionCard } from "./resolution-card";

const PHASE_LABELS: Record<string, string> = {
  failed_detected: "Failure detected",
  investigating: "Investigating evidence",
  manager_review: "Manager reviewing evidence",
  policy_check: "Checking recovery policy",
  awaiting_approval: "Waiting for browser approval",
  executing: "Executing policy-checked recovery",
  verifying: "Verifying fresh health",
  resolved: "Recovered successfully",
  needs_human: "Human decision required",
  failed_recovery: "Recovery failed verification",
  investigation_failed: "Investigation failed",
};

const RUNNER_FRESHNESS_MS = 4_000;
const ACTIVE_RUN_REFRESH_MS = 1_000;
const ACTIVE_RUN_REFRESH_LIMIT_MS = 90_000;
const TERMINAL_COMMAND_STATUSES = new Set(["complete", "failed", "expired"]);

type ExecutionMode = "autonomous" | "approval_required";

type PublicDemoState = FunctionReturnType<typeof api.demo.getPublicState> & {
  executionMode: ExecutionMode;
  approval: PublicApproval | null;
};

type TrackedRun = {
  demoCommandId: Id<"demoCommands">;
  refreshDeadline: number;
  executionMode: ExecutionMode;
};

type ScopedApprovalSession = {
  key: string;
  status: ApprovalSessionStatus;
};

type ScopedApprovalDecisionNotice = ApprovalDecisionNotice & {
  key: string;
};

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!convexUrl) {
  throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured");
}
const publicStateHttpClient = new ConvexHttpClient(convexUrl);

function isTerminalCommandStatus(status: string | null | undefined) {
  return (
    status !== null &&
    status !== undefined &&
    TERMINAL_COMMAND_STATUSES.has(status)
  );
}

function didCommandFailBeforeIncident(state: PublicDemoState | undefined) {
  return (
    state?.incident === null &&
    (state.commandStatus === "failed" || state.commandStatus === "expired")
  );
}

function environmentRecoveryStatus(state: PublicDemoState | undefined) {
  if (!state?.incident) {
    return null;
  }

  return state.incident.environmentRecoveryStatus;
}

function freshestState(
  subscribedState: PublicDemoState | undefined,
  polledState: PublicDemoState | null,
) {
  if (!subscribedState) {
    return polledState ?? undefined;
  }
  if (!polledState) {
    return subscribedState;
  }
  return polledState.snapshotAt > subscribedState.snapshotAt
    ? polledState
    : subscribedState;
}

function acceptedRunPlaceholder(
  latestState: PublicDemoState | undefined,
  demoCommandId: Id<"demoCommands">,
  executionMode: ExecutionMode,
): PublicDemoState | undefined {
  if (!latestState) {
    return undefined;
  }
  return {
    ...latestState,
    demoCommandId,
    executionMode,
    approval: null,
    commandStatus: "queued",
    commandExpiresAt: null,
    active: true,
    incident: null,
    steps: [],
    result: null,
  };
}

function useCooldownRemaining(
  cooldownUntil: number | null | undefined,
  fallbackRemainingMs: number,
) {
  const [clockTime, setClockTime] = useState(0);

  useEffect(() => {
    if (cooldownUntil === null || cooldownUntil === undefined) {
      return;
    }

    let timer: number | null = null;

    const scheduleNextTick = () => {
      const remainingMs = cooldownUntil - Date.now();
      if (remainingMs <= 0) {
        return;
      }

      timer = window.setTimeout(
        () => {
          setClockTime(Date.now());
          scheduleNextTick();
        },
        Math.min(1_000, remainingMs),
      );
    };

    scheduleNextTick();

    return () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [cooldownUntil]);

  if (
    cooldownUntil === null ||
    cooldownUntil === undefined ||
    clockTime === 0
  ) {
    return fallbackRemainingMs;
  }

  return Math.max(0, cooldownUntil - clockTime);
}

function useLiveRunnerOnline(
  reportedOnline: boolean,
  runnerHeartbeatAt: number | null | undefined,
) {
  const [expiredHeartbeatAt, setExpiredHeartbeatAt] = useState<number | null>(
    null,
  );

  useEffect(() => {
    if (
      !reportedOnline ||
      runnerHeartbeatAt === null ||
      runnerHeartbeatAt === undefined
    ) {
      return;
    }

    const expiresAt = runnerHeartbeatAt + RUNNER_FRESHNESS_MS;
    const timer = window.setTimeout(
      () => setExpiredHeartbeatAt(runnerHeartbeatAt),
      Math.max(0, expiresAt - Date.now()),
    );

    return () => window.clearTimeout(timer);
  }, [reportedOnline, runnerHeartbeatAt]);

  return (
    reportedOnline &&
    runnerHeartbeatAt !== null &&
    runnerHeartbeatAt !== undefined &&
    expiredHeartbeatAt !== runnerHeartbeatAt
  );
}

function recoveryRailOutcome(phase: string | null | undefined) {
  switch (phase) {
    case "resolved":
      return { className: "rail-healthy", label: "Verified healthy" };
    case "needs_human":
      return { className: "rail-warning", label: "Needs human" };
    case "failed_recovery":
    case "investigation_failed":
      return { className: "rail-failed", label: "Verification failed" };
    case "failed_detected":
    case "investigating":
    case "manager_review":
    case "policy_check":
    case "executing":
    case "verifying":
      return { className: "rail-active", label: "Recovery in progress" };
    default:
      return { className: "rail-pending", label: "Verification pending" };
  }
}

function approvalRailState(
  executionMode: ExecutionMode | null | undefined,
  approval: PublicApproval | null | undefined,
) {
  if (executionMode !== "approval_required") {
    return { className: "rail-pending", label: "Automatic path" };
  }

  switch (approval?.status) {
    case "pending":
      return {
        className: "rail-warning",
        label: "Approval needed",
        current: true,
      };
    case "approved":
      return { className: "rail-active", label: "Approved" };
    case "rejected":
      return { className: "rail-warning", label: "Rejected" };
    case "expired":
      return { className: "rail-warning", label: "Expired" };
    default:
      return { className: "rail-pending", label: "Approval pending" };
  }
}

function resetFailureMessage(status: number) {
  switch (status) {
    case 409:
      return "A recovery run is already active.";
    case 429:
      return "The recovery demo is temporarily unavailable. Please wait for the cooldown.";
    case 503:
      return "The Linux runner is unavailable right now.";
    default:
      return "The demo could not start. No action was taken.";
  }
}

export function DemoDashboard() {
  const latestState = useQuery(
    api.demo.getPublicState,
    {},
  ) as PublicDemoState | undefined;
  const [trackedRun, setTrackedRun] = useState<TrackedRun | null>(null);
  const trackedDemoCommandId = trackedRun?.demoCommandId ?? null;
  const trackedRefreshDeadline = trackedRun?.refreshDeadline ?? 0;
  const subscribedRunState = useQuery(
    api.demo.getPublicState,
    trackedDemoCommandId ? { demoCommandId: trackedDemoCommandId } : "skip",
  ) as PublicDemoState | undefined;
  const [polledRunState, setPolledRunState] = useState<PublicDemoState | null>(
    null,
  );
  const trackedRunState = freshestState(subscribedRunState, polledRunState);
  const trackedRunTerminal = isTerminalCommandStatus(
    trackedRunState?.commandStatus,
  );
  const state = trackedDemoCommandId
    ? (trackedRunState ??
      acceptedRunPlaceholder(
        latestState,
        trackedDemoCommandId,
        trackedRun?.executionMode ?? "autonomous",
      ))
    : latestState;
  const [requestNotice, setRequestNotice] = useState<{
    message: string;
    stateKey: string;
  } | null>(null);
  const [startingMode, setStartingMode] = useState<ExecutionMode | null>(null);
  const [approvalSession, setApprovalSession] =
    useState<ScopedApprovalSession | null>(null);
  const [approvalSessionRetryCount, setApprovalSessionRetryCount] = useState(0);
  const [approvalDecisionNotice, setApprovalDecisionNotice] =
    useState<ScopedApprovalDecisionNotice | null>(null);
  const [isStarting, startReset] = useTransition();
  const cooldownRemainingMs = useCooldownRemaining(
    state?.cooldownUntil,
    state?.cooldownRemainingMs ?? 0,
  );
  const runnerOnline = useLiveRunnerOnline(
    state?.runnerOnline ?? false,
    state?.runnerHeartbeatAt,
  );
  const recoveryStatus = environmentRecoveryStatus(state);
  const environmentRestorationPending =
    recoveryStatus !== null &&
    recoveryStatus !== undefined &&
    recoveryStatus !== "restored";
  const stateKey = state
    ? `${state.demoCommandId ?? "none"}:${state.active}:${state.incident?.incidentId ?? "none"}:${state.incident?.currentPhase ?? "none"}:${state.steps.length}`
    : "loading";
  const pendingApprovalKey =
    state?.demoCommandId && state.approval?.status === "pending"
      ? `${state.demoCommandId}:${state.approval.requestedAt}:${state.incident?.currentPhase ?? "no_incident"}`
      : null;
  const approvalSessionStatus: ApprovalSessionStatus =
    pendingApprovalKey && approvalSession?.key === pendingApprovalKey
      ? approvalSession.status
      : "checking";
  const visibleApprovalDecisionNotice =
    pendingApprovalKey && approvalDecisionNotice?.key === pendingApprovalKey
      ? approvalDecisionNotice
      : null;

  useEffect(() => {
    if (
      trackedDemoCommandId === null ||
      trackedRunTerminal ||
      trackedRefreshDeadline <= Date.now()
    ) {
      return;
    }

    let requestInFlight = false;
    let disposed = false;
    const refresh = () => {
      if (requestInFlight) {
        return;
      }
      requestInFlight = true;
      void publicStateHttpClient
        .query(api.demo.getPublicState, {
          demoCommandId: trackedDemoCommandId,
        })
        .then((nextState) => {
          if (disposed) {
            return;
          }
          setPolledRunState((currentState) =>
            currentState === null ||
            nextState.snapshotAt > currentState.snapshotAt
              ? nextState
              : currentState,
          );
        })
        .catch(() => undefined)
        .finally(() => {
          requestInFlight = false;
        });
    };
    const interval = window.setInterval(refresh, ACTIVE_RUN_REFRESH_MS);
    const limit = window.setTimeout(
      () => window.clearInterval(interval),
      Math.max(0, trackedRefreshDeadline - Date.now()),
    );

    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.clearTimeout(limit);
    };
  }, [trackedDemoCommandId, trackedRefreshDeadline, trackedRunTerminal]);

  useEffect(() => {
    if (!pendingApprovalKey) {
      return;
    }

    let disposed = false;

    void fetch("/api/demo/approval/session", { method: "GET" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Approval session unavailable");
        }
        const payload = (await response.json()) as { canDecide?: unknown };
        if (typeof payload.canDecide !== "boolean") {
          throw new Error("Approval session response was invalid");
        }
        if (!disposed) {
          setApprovalSession({
            key: pendingApprovalKey,
            status: payload.canDecide ? "can_decide" : "spectator",
          });
        }
      })
      .catch(() => {
        if (!disposed) {
          setApprovalSession({
            key: pendingApprovalKey,
            status: "unavailable",
          });
        }
      });

    return () => {
      disposed = true;
    };
  }, [pendingApprovalKey, approvalSessionRetryCount]);

  const phaseLabel = !state
    ? "Loading live recovery state"
    : state.approval?.status === "rejected"
      ? "Staged restart rejected"
      : state.approval?.status === "expired"
        ? "Approval window expired"
        : state.approval?.status === "approved" &&
            state.incident?.currentPhase === "awaiting_approval"
          ? "Approval recorded"
    : state.incident
      ? (PHASE_LABELS[state.incident.currentPhase] ?? "Incident in progress")
      : !state.enabled
        ? "Public demo disabled"
        : state.active
          ? "Runner starting recovery"
          : didCommandFailBeforeIncident(state)
            ? "Recovery could not start"
            : !runnerOnline
              ? "Waiting for runner"
              : "Ready to run";

  let disabledReason: string | null = null;
  if (state === undefined) {
    disabledReason =
      "The recovery demo is unavailable while live state is loading.";
  } else if (isStarting) {
    disabledReason = "The recovery demo is starting.";
  } else if (!state.enabled) {
    disabledReason =
      "The recovery demo is unavailable because the public demo is disabled.";
  } else if (!runnerOnline) {
    disabledReason =
      "The recovery demo is unavailable because the Linux runner is offline.";
  } else if (environmentRestorationPending) {
    disabledReason =
      "The recovery demo is unavailable until the demo environment is restored.";
  } else if (state.active) {
    disabledReason =
      "The recovery demo is unavailable while an incident is active.";
  } else if (cooldownRemainingMs > 0) {
    disabledReason = `The recovery demo is unavailable for ${Math.ceil(cooldownRemainingMs / 1_000)} more seconds.`;
  }

  const requestReset = (executionMode: ExecutionMode) => {
    setRequestNotice(null);
    setStartingMode(executionMode);
    const requestStateKey = stateKey;
    startReset(async () => {
      let requestWasAccepted = false;
      try {
        const route =
          executionMode === "approval_required"
            ? "/api/demo/reset/approval-required"
            : "/api/demo/reset";
        const response = await fetch(route, { method: "POST" });
        if (!response.ok) {
          setRequestNotice({
            message: resetFailureMessage(response.status),
            stateKey: requestStateKey,
          });
          return;
        }
        requestWasAccepted = true;

        const payload = (await response.json()) as {
          demoCommandId?: unknown;
        };
        if (typeof payload.demoCommandId !== "string") {
          throw new Error("Demo response did not include a command ID");
        }

        setRequestNotice({
          message:
            executionMode === "approval_required"
              ? "Approval demo started. Waiting for the runner."
              : "Recovery demo started. Waiting for the runner.",
          stateKey: requestStateKey,
        });
        setPolledRunState(null);
        setTrackedRun({
          demoCommandId: payload.demoCommandId as Id<"demoCommands">,
          refreshDeadline: Date.now() + ACTIVE_RUN_REFRESH_LIMIT_MS,
          executionMode,
        });
      } catch {
        setRequestNotice({
          message: requestWasAccepted
            ? "Recovery demo was accepted. Waiting for live state."
            : "The demo could not start. No action was taken.",
          stateKey: requestStateKey,
        });
      } finally {
        setStartingMode(null);
      }
    });
  };

  const submitApprovalDecision = (decision: "approve" | "reject") => {
    if (
      !pendingApprovalKey ||
      state?.approval?.status !== "pending" ||
      visibleApprovalDecisionNotice?.status === "submitting" ||
      visibleApprovalDecisionNotice?.status === "accepted"
    ) {
      return;
    }

    const submittingMessage =
      decision === "approve"
        ? "Recording approval. No recovery action has run yet."
        : "Recording rejection. No recovery action will be authorized.";
    setApprovalDecisionNotice({
      key: pendingApprovalKey,
      decision,
      status: "submitting",
      message: submittingMessage,
    });

    const route =
      decision === "approve"
        ? "/api/demo/approval/approve"
        : "/api/demo/approval/reject";
    void fetch(route, { method: "POST" })
      .then((response) => {
        if (!response.ok) {
          throw new Error("Approval decision was rejected");
        }
        setApprovalDecisionNotice({
          key: pendingApprovalKey,
          decision,
          status: "accepted",
          message:
            decision === "approve"
              ? "Approval recorded. The Linux runner can resume the staged restart."
              : "Rejection recorded. No recovery action was authorized.",
        });
      })
      .catch(() => {
        setApprovalDecisionNotice({
          key: pendingApprovalKey,
          decision,
          status: "error",
          message:
            "The decision could not be recorded. No recovery action was authorized.",
        });
      });
  };

  const retryApprovalSession = () => {
    if (!pendingApprovalKey) {
      return;
    }

    setApprovalSession({
      key: pendingApprovalKey,
      status: "checking",
    });
    setApprovalSessionRetryCount((count) => count + 1);
  };

  const runnerLabel = runnerOnline ? "Runner online" : "Runner offline";
  const serviceLabel = !state
    ? "Service unknown"
    : !runnerOnline
      ? "Service unavailable"
      : state.incident?.currentPhase === "awaiting_approval"
        ? "Service stopped"
      : recoveryStatus === "restored"
        ? "Service healthy"
        : recoveryStatus === "pending" || recoveryStatus === "restoring"
          ? "Service restoring"
          : state.active
            ? "Service recovering"
            : state.result?.finalHealth === "healthy"
              ? "Service healthy"
              : state.result?.finalHealth === "failed"
                ? "Service unhealthy"
                : "Service ready";
  const runnerBadgeClass = !state
    ? "badge-neutral"
    : runnerOnline
      ? "badge-online"
      : "badge-offline";
  const serviceBadgeClass =
    !runnerOnline
      ? "badge-neutral"
      : state?.incident?.currentPhase === "awaiting_approval"
        ? "badge-offline"
      : recoveryStatus === "restored"
        ? "badge-online"
        : recoveryStatus === "pending" || recoveryStatus === "restoring"
          ? "badge-neutral"
          : state?.result?.finalHealth === "healthy"
            ? "badge-online"
            : state?.result?.finalHealth === "failed"
              ? "badge-offline"
              : "badge-neutral";
  const phaseDetail = !state
    ? "Connecting to the public incident state"
    : !state.enabled
      ? "An operator must enable the public demo"
      : state.approval?.status === "rejected"
        ? "No recovery action was authorized"
        : state.approval?.status === "expired"
          ? "The approval closed without authorizing the restart"
          : state.approval?.status === "approved" &&
              state.incident?.currentPhase === "awaiting_approval"
            ? "Waiting for the Linux runner to resume the fixed action"
      : state.approval?.status === "pending"
        ? "The fixed service remains stopped; no recovery action has run"
      : state.active
        ? "Recovery evidence is streaming below"
        : didCommandFailBeforeIncident(state)
          ? "The exact requested run ended before an incident was created"
          : !runnerOnline
            ? "Waiting for a fresh runner heartbeat"
            : state.incident
              ? "Latest recorded incident"
              : "Standing by for one isolated failure";
  const railOutcome = recoveryRailOutcome(state?.incident?.currentPhase);
  const railApproval = approvalRailState(
    state?.executionMode,
    state?.approval,
  );
  const liveAnnouncement =
    requestNotice?.stateKey === stateKey ? requestNotice.message : phaseLabel;

  return (
    <div className="dashboard-shell">
      <header className="console-header">
        <div className="console-intro">
          <div className="console-entry-row">
            <div className="product-mark" aria-label="Autonomous DevOps Agent">
              <span>
                <strong>Autonomous DevOps Agent</strong>
                <small>Live recovery console</small>
              </span>
            </div>
            <Link className="connect-runner-link" href="/servers/new">
              Connect your Linux server <span aria-hidden="true">→</span>
            </Link>
          </div>

          <div className="headline-block">
            <p className="section-kicker">
              One service · two controlled recovery modes
            </p>
            <h1>{PUBLIC_APP_HEADLINE}</h1>
            <p className="headline-summary">
              Choose the existing autonomous path or wait for the agent to pass
              an allowlist policy check before asking this browser to decide.
              Both modes use the same fixed restart and verify fresh health.
            </p>
          </div>

          <p className="safety-line">
            <span aria-hidden="true">◆</span>
            This public demo has no user account and does not identify an
            approver · approval applies only to one disposable service · no
            arbitrary shell access
          </p>
        </div>

        <div className="control-deck">
          <div className="system-badges" aria-label="System status">
            <span className={`system-badge ${runnerBadgeClass}`}>
              <span className="status-dot" aria-hidden="true" />
              {state ? runnerLabel : "Checking runner"}
            </span>
            <span className={`system-badge ${serviceBadgeClass}`}>
              <span className="status-dot" aria-hidden="true" />
              {serviceLabel}
            </span>
            {state?.approval?.status === "pending" ? (
              <span className="system-badge badge-warning">
                <span className="status-dot" aria-hidden="true" />
                Approval needed
              </span>
            ) : null}
          </div>

          <div className="demo-mode-actions">
            <button
              className="reset-button"
              type="button"
              onClick={() => requestReset("autonomous")}
              disabled={disabledReason !== null}
              aria-describedby="reset-assistance"
            >
              <span>
                {isStarting && startingMode === "autonomous"
                  ? "Starting…"
                  : "Run autonomous demo"}
              </span>
              <span aria-hidden="true">↗</span>
            </button>
            <button
              className="reset-button reset-button-approval"
              type="button"
              onClick={() => requestReset("approval_required")}
              disabled={disabledReason !== null}
              aria-describedby="reset-assistance"
            >
              <span>
                {isStarting && startingMode === "approval_required"
                  ? "Starting…"
                  : "Run approval demo"}
              </span>
              <span aria-hidden="true">→</span>
            </button>
          </div>

          <p id="reset-assistance" className="reset-assistance">
            {disabledReason ??
              "Autonomous continues after policy. Approval pauses before the same fixed restart."}
          </p>

          <div className="phase-readout">
            <span className="phase-index">CURRENT PHASE</span>
            <strong>{phaseLabel}</strong>
            {cooldownRemainingMs > 0 && !state?.active ? (
              <small>
                Demo available in {Math.ceil(cooldownRemainingMs / 1_000)}s
              </small>
            ) : (
              <small>{phaseDetail}</small>
            )}
          </div>

          <div
            className="live-announcement"
            role="status"
            aria-label="Demo status"
            aria-live="polite"
            aria-atomic="true"
          >
            {liveAnnouncement}
          </div>
        </div>
      </header>

      <div className="recovery-rail" aria-label="Recovery stages">
        <span className="rail-state rail-failed">Failed</span>
        <span aria-hidden="true">→</span>
        <span>Evidence</span>
        <span aria-hidden="true">→</span>
        <span>Policy</span>
        <span aria-hidden="true">→</span>
        <span
          className={`rail-state ${railApproval.className}`}
          aria-current={railApproval.current ? "step" : undefined}
        >
          {railApproval.label}
        </span>
        <span aria-hidden="true">→</span>
        <span>Recovery</span>
        <span aria-hidden="true">→</span>
        <span className={`rail-state ${railOutcome.className}`}>
          {railOutcome.label}
        </span>
      </div>

      <div className="evidence-layout">
        {state?.approval ? (
          <ApprovalGate
            approval={state.approval}
            incidentPhase={state.incident?.currentPhase ?? null}
            environmentRecoveryStatus={
              state.incident?.environmentRecoveryStatus ?? null
            }
            sessionStatus={approvalSessionStatus}
            runnerOnline={runnerOnline}
            decisionNotice={visibleApprovalDecisionNotice}
            onDecision={submitApprovalDecision}
            onRetrySession={retryApprovalSession}
          />
        ) : null}
        <ResolutionCard
          incident={state?.incident ?? null}
          result={state?.result ?? null}
          steps={state?.steps ?? []}
          runnerOnline={runnerOnline}
          executionMode={state?.executionMode ?? "autonomous"}
          approval={state?.approval ?? null}
        />
        <IncidentTimeline steps={state?.steps ?? []} />
      </div>
    </div>
  );
}
