"use client";

import { useQuery } from "convex/react";
import { useEffect, useState, useTransition } from "react";

import { api } from "../../convex/_generated/api";
import { IncidentTimeline } from "./incident-timeline";
import { ResolutionCard } from "./resolution-card";

const PHASE_LABELS: Record<string, string> = {
  failed_detected: "Failure detected",
  investigating: "Investigating evidence",
  manager_review: "Manager reviewing evidence",
  policy_check: "Checking recovery policy",
  executing: "Executing approved recovery",
  verifying: "Verifying fresh health",
  resolved: "Recovered successfully",
  needs_human: "Human decision required",
  failed_recovery: "Recovery failed verification",
  investigation_failed: "Investigation failed",
};

const RUNNER_FRESHNESS_MS = 15_000;

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

      timer = window.setTimeout(() => {
        setClockTime(Date.now());
        scheduleNextTick();
      }, Math.min(1_000, remainingMs));
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
    if (!reportedOnline || runnerHeartbeatAt === null || runnerHeartbeatAt === undefined) {
      return;
    }

    const expiresAt = runnerHeartbeatAt + RUNNER_FRESHNESS_MS;
    const timer = window.setTimeout(
      () => setExpiredHeartbeatAt(runnerHeartbeatAt),
      Math.max(0, expiresAt - Date.now()) + 1,
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

function resetFailureMessage(status: number) {
  switch (status) {
    case 409:
      return "A recovery run is already active.";
    case 429:
      return "Reset is temporarily unavailable. Please wait for the cooldown.";
    case 503:
      return "The Linux runner is unavailable right now.";
    default:
      return "The demo could not start. No action was taken.";
  }
}

export function DemoDashboard() {
  const state = useQuery(api.demo.getPublicState, {});
  const [requestNotice, setRequestNotice] = useState<{
    message: string;
    stateKey: string;
  } | null>(null);
  const [isStarting, startReset] = useTransition();
  const cooldownRemainingMs = useCooldownRemaining(
    state?.cooldownUntil,
    state?.cooldownRemainingMs ?? 0,
  );
  const runnerOnline = useLiveRunnerOnline(
    state?.runnerOnline ?? false,
    state?.runnerHeartbeatAt,
  );
  const stateKey = state
    ? `${state.active}:${state.incident?.incidentId ?? "none"}:${state.incident?.currentPhase ?? "none"}:${state.steps.length}`
    : "loading";

  const phaseLabel = !state
    ? "Loading live recovery state"
    : state.incident
      ? (PHASE_LABELS[state.incident.currentPhase] ?? "Incident in progress")
      : !state.enabled
        ? "Public demo disabled"
        : state.active
          ? "Runner claiming reset"
          : !runnerOnline
            ? "Waiting for runner"
            : "Ready for reset";

  let disabledReason: string | null = null;
  if (state === undefined) {
    disabledReason = "Reset is unavailable while live state is loading.";
  } else if (isStarting) {
    disabledReason = "Reset request is being sent.";
  } else if (!state.enabled) {
    disabledReason = "Reset is unavailable because the public demo is disabled.";
  } else if (!runnerOnline) {
    disabledReason = "Reset is unavailable because the Linux runner is offline.";
  } else if (state.active) {
    disabledReason = "Reset is unavailable while an incident is active.";
  } else if (cooldownRemainingMs > 0) {
    disabledReason = `Reset is unavailable for ${Math.ceil(cooldownRemainingMs / 1_000)} more seconds.`;
  }

  const requestReset = () => {
    setRequestNotice(null);
    const requestStateKey = stateKey;
    startReset(async () => {
      try {
        const response = await fetch("/api/demo/reset", { method: "POST" });
        if (!response.ok) {
          setRequestNotice({
            message: resetFailureMessage(response.status),
            stateKey: requestStateKey,
          });
          return;
        }

        setRequestNotice({
          message: "Reset accepted. Waiting for the runner.",
          stateKey: requestStateKey,
        });
      } catch {
        setRequestNotice({
          message: "The demo could not start. No action was taken.",
          stateKey: requestStateKey,
        });
      }
    });
  };

  const runnerLabel = runnerOnline ? "Runner online" : "Runner offline";
  const serviceLabel = !state
    ? "Service unknown"
    : !runnerOnline
      ? "Service unavailable"
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
  const serviceBadgeClass = !runnerOnline
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
      : state.active
        ? "Recovery evidence is streaming below"
        : !runnerOnline
          ? "Waiting for a fresh runner heartbeat"
          : state.incident
            ? "Latest recorded incident"
            : "Standing by for one isolated failure";
  const railOutcome = recoveryRailOutcome(state?.incident?.currentPhase);
  const liveAnnouncement =
    requestNotice?.stateKey === stateKey ? requestNotice.message : phaseLabel;

  return (
    <div className="dashboard-shell">
      <header className="console-header">
        <div className="console-intro">
          <div className="product-mark" aria-label="Autonomous DevOps Agent">
            <span>
              <strong>Autonomous DevOps Agent</strong>
              <small>Live recovery console</small>
            </span>
          </div>

          <div className="headline-block">
            <p className="section-kicker">One service · one safe recovery path</p>
            <h1>
              An AI operations agent that investigates a failed Linux service,
              performs one approved recovery action, and verifies the result.
            </h1>
          </div>

          <p className="safety-line">
            <span aria-hidden="true">◆</span>
            Disposable demo container · one allowlisted restart · no arbitrary
            shell access
          </p>
        </div>

        <div className="control-deck">
          <div className="system-badges" aria-label="System status">
            <span
              className={`system-badge ${runnerBadgeClass}`}
            >
              <span className="status-dot" aria-hidden="true" />
              {state ? runnerLabel : "Checking runner"}
            </span>
            <span
              className={`system-badge ${serviceBadgeClass}`}
            >
              <span className="status-dot" aria-hidden="true" />
              {serviceLabel}
            </span>
          </div>

          <button
            className="reset-button"
            type="button"
            onClick={requestReset}
            disabled={disabledReason !== null}
            aria-describedby="reset-assistance"
          >
            <span>{isStarting ? "Starting…" : "Reset demo"}</span>
            <span aria-hidden="true">↗</span>
          </button>

          <p id="reset-assistance" className="reset-assistance">
            {disabledReason ??
              "Stops only the disposable service and starts one measured recovery run."}
          </p>

          <div className="phase-readout">
            <span className="phase-index">CURRENT PHASE</span>
            <strong>{phaseLabel}</strong>
            {cooldownRemainingMs > 0 && !state?.active ? (
              <small>
                Reset available in {Math.ceil(cooldownRemainingMs / 1_000)}s
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
        <span>Recovery</span>
        <span aria-hidden="true">→</span>
        <span className={`rail-state ${railOutcome.className}`}>
          {railOutcome.label}
        </span>
      </div>

      <div className="evidence-layout">
        <IncidentTimeline steps={state?.steps ?? []} />
        <ResolutionCard
          incident={state?.incident ?? null}
          result={state?.result ?? null}
          steps={state?.steps ?? []}
        />
      </div>
    </div>
  );
}
