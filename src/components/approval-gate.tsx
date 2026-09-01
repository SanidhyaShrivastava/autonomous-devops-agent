import { useEffect, useRef } from "react";

import type { IncidentState } from "@/lib/contracts";

export type PublicApproval = {
  status: "pending" | "approved" | "rejected" | "expired";
  actionId: "restart_demo_service";
  actionLabel: string;
  requestedAt: number;
  expiresAt: number;
  decidedAt: number | null;
};

export type ApprovalSessionStatus =
  | "checking"
  | "can_decide"
  | "spectator"
  | "unavailable";

export type ApprovalDecisionNotice = {
  decision: "approve" | "reject";
  status: "submitting" | "accepted" | "error";
  message: string;
};

export type EnvironmentRecoveryStatus =
  | "pending"
  | "restoring"
  | "restored"
  | null
  | undefined;

function approvedGateContent(incidentPhase: IncidentState | null) {
  switch (incidentPhase) {
    case "resolved":
      return {
        heading: "Approved restart completed",
        detail:
          "The fixed restart ran and a fresh health check verified the service is healthy.",
        signal: "Verified",
        tone: "approved",
        proposalLabel: "Fixed executed action",
        proposalDetail:
          "One fixed restart followed by a fresh healthy check",
      } as const;
    case "failed_recovery":
      return {
        heading: "Approved recovery did not verify",
        detail:
          "The fixed restart was authorized and attempted, but recovery did not finish with verified health.",
        signal: "Not verified",
        tone: "rejected",
        proposalLabel: "Fixed attempted action",
        proposalDetail:
          "The approved attempt did not reach verified healthy service",
      } as const;
    case "executing":
      return {
        heading: "Approved restart in progress",
        detail: "The Linux runner is executing the approved fixed restart.",
        signal: "Executing",
        tone: "approved",
        proposalLabel: "Fixed approved action",
        proposalDetail:
          "One fixed restart is in progress; a fresh health check follows",
      } as const;
    case "verifying":
      return {
        heading: "Approved restart awaiting verification",
        detail:
          "The fixed restart completed and the Linux runner is checking fresh health.",
        signal: "Verifying",
        tone: "approved",
        proposalLabel: "Fixed executed action",
        proposalDetail:
          "The fixed restart completed; fresh health verification is in progress",
      } as const;
    case "awaiting_approval":
      return {
        heading: "Staged restart approved",
        detail:
          "Approval is recorded. The Linux runner may resume the same fixed restart and then verify fresh health.",
        signal: "Approved",
        tone: "approved",
        proposalLabel: "Fixed approved action",
        proposalDetail:
          "One approved restart of demo-service, then a fresh health check",
      } as const;
    case "needs_human":
    case "investigation_failed":
      return {
        heading: "Approved restart did not complete",
        detail:
          "Approval was recorded, but the run ended before recovery reached verified health.",
        signal: "Run ended",
        tone: "rejected",
        proposalLabel: "Fixed approved action",
        proposalDetail:
          "The resolution record shows whether execution began",
      } as const;
    default:
      return {
        heading: "Staged restart approved",
        detail:
          "Approval was recorded for the fixed restart. Current recovery state appears in the resolution record.",
        signal: "Approved",
        tone: "approved",
        proposalLabel: "Fixed approved action",
        proposalDetail: "One approved restart of the fixed demo service",
      } as const;
  }
}

function restorationDetail(status: EnvironmentRecoveryStatus) {
  switch (status) {
    case "restored":
      return "The demo environment was restored and is healthy.";
    case "restoring":
      return "The demo environment is being restored.";
    case "pending":
      return "Demo environment restoration is queued.";
    default:
      return "The resolution record shows the demo environment state.";
  }
}

function gateContent(
  approval: PublicApproval,
  sessionStatus: ApprovalSessionStatus,
  incidentPhase: IncidentState | null,
  environmentRecoveryStatus: EnvironmentRecoveryStatus,
) {
  if (approval.status === "approved") {
    return approvedGateContent(incidentPhase);
  }

  if (approval.status === "rejected") {
    return {
      heading: "Staged restart rejected",
      detail: `No recovery action was authorized. ${restorationDetail(environmentRecoveryStatus)}`,
      signal: "Rejected",
      tone: "rejected",
      proposalLabel: "Fixed proposed action",
      proposalDetail: "The restart was not authorized or executed",
    } as const;
  }

  if (approval.status === "expired") {
    return {
      heading: "Approval window expired",
      detail: `No recovery action was authorized. ${restorationDetail(environmentRecoveryStatus)}`,
      signal: "Expired",
      tone: "expired",
      proposalLabel: "Fixed proposed action",
      proposalDetail: "The restart was not authorized or executed",
    } as const;
  }

  switch (sessionStatus) {
    case "can_decide":
      return {
        heading: "Approve the staged restart?",
        detail:
          "The stopped service passed the fixed safety policy and is waiting before execution.",
        signal: "Decision needed",
        tone: "pending",
        proposalLabel: "Fixed proposed action",
        proposalDetail:
          "One restart of demo-service, then a fresh health check",
      } as const;
    case "spectator":
      return {
        heading: "Waiting for the initiating browser",
        detail:
          "Only the browser that started this run can approve or reject it.",
        signal: "Read-only",
        tone: "pending",
        proposalLabel: "Fixed proposed action",
        proposalDetail:
          "One restart of demo-service, then a fresh health check",
      } as const;
    case "unavailable":
      return {
        heading: "Decision access unavailable",
        detail:
          "This browser could not confirm decision access. Retry before the approval window closes.",
        signal: "Access check failed",
        tone: "pending",
        proposalLabel: "Fixed proposed action",
        proposalDetail:
          "One restart of demo-service, then a fresh health check",
      } as const;
    default:
      return {
        heading: "Checking decision access",
        detail: "Confirming whether this browser started the approval demo.",
        signal: "Checking",
        tone: "pending",
        proposalLabel: "Fixed proposed action",
        proposalDetail:
          "One restart of demo-service, then a fresh health check",
      } as const;
  }
}

export function ApprovalGate({
  approval,
  incidentPhase,
  environmentRecoveryStatus,
  sessionStatus,
  runnerOnline,
  decisionNotice,
  onDecision,
  onRetrySession,
}: {
  approval: PublicApproval;
  incidentPhase: IncidentState | null;
  environmentRecoveryStatus: EnvironmentRecoveryStatus;
  sessionStatus: ApprovalSessionStatus;
  runnerOnline: boolean;
  decisionNotice: ApprovalDecisionNotice | null;
  onDecision: (decision: "approve" | "reject") => void;
  onRetrySession: () => void;
}) {
  const content = gateContent(
    approval,
    sessionStatus,
    incidentPhase,
    environmentRecoveryStatus,
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeadingAfterDecisionRef = useRef(false);
  const pending = approval.status === "pending";
  const canDecide = pending && sessionStatus === "can_decide";
  const canRetrySession = pending && sessionStatus === "unavailable";
  const requestBusy = decisionNotice?.status === "submitting";
  const decisionAccepted = decisionNotice?.status === "accepted";
  const controlsDisabled = requestBusy || decisionAccepted;
  const approveDisabled = controlsDisabled || !runnerOnline;

  useEffect(() => {
    if (pending || !focusHeadingAfterDecisionRef.current) {
      return;
    }

    focusHeadingAfterDecisionRef.current = false;
    headingRef.current?.focus();
  }, [pending]);

  const submitDecision = (decision: "approve" | "reject") => {
    focusHeadingAfterDecisionRef.current = true;
    onDecision(decision);
  };

  return (
    <section
      className={`panel approval-gate approval-gate-${content.tone}`}
      aria-labelledby="approval-gate-title"
      aria-describedby="approval-gate-detail approval-gate-boundary"
      aria-busy={requestBusy || undefined}
    >
      <div className="approval-gate-copy">
        <div className="approval-gate-heading">
          <div>
            <p className="section-kicker">Approval checkpoint</p>
            <h2 id="approval-gate-title" ref={headingRef} tabIndex={-1}>
              {content.heading}
            </h2>
          </div>
          <span className={`approval-signal approval-signal-${content.tone}`}>
            <span className="status-dot" aria-hidden="true" />
            {content.signal}
          </span>
        </div>

        <p id="approval-gate-detail" className="approval-detail">
          {content.detail}
        </p>

        <div className="approval-proposal">
          <span>{content.proposalLabel}</span>
          <code>{approval.actionLabel}</code>
          <small>{content.proposalDetail}</small>
        </div>

        <p id="approval-gate-boundary" className="approval-boundary">
          This public demo has no user account. The decision applies only to
          the disposable service and does not identify an approver.
        </p>
      </div>

      {canDecide ? (
        <div className="approval-control-column">
          {!runnerOnline ? (
            <p id="approval-runner-note" className="approval-runner-note">
              The runner is offline. Approval is paused; rejection is still
              available.
            </p>
          ) : (
            <p id="approval-runner-note" className="approval-runner-note">
              No recovery action runs until this browser decides.
            </p>
          )}

          <div className="approval-actions">
            <button
              className="approval-action approval-action-primary"
              type="button"
              onClick={() => submitDecision("approve")}
              disabled={approveDisabled}
              aria-describedby="approval-runner-note approval-gate-boundary"
            >
              {requestBusy && decisionNotice.decision === "approve"
                ? "Recording approval…"
                : "Approve staged restart"}
            </button>
            <button
              className="approval-action approval-action-secondary"
              type="button"
              onClick={() => submitDecision("reject")}
              disabled={controlsDisabled}
              aria-describedby="approval-runner-note approval-gate-boundary"
            >
              {requestBusy && decisionNotice.decision === "reject"
                ? "Recording rejection…"
                : "Reject and restore demo"}
            </button>
          </div>
        </div>
      ) : null}

      {canRetrySession ? (
        <div className="approval-control-column">
          <p className="approval-runner-note">
            No recovery action runs while decision access is unconfirmed.
          </p>
          <div className="approval-actions approval-actions-single">
            <button
              className="approval-action approval-action-secondary"
              type="button"
              onClick={onRetrySession}
              aria-describedby="approval-gate-detail approval-gate-boundary"
            >
              Retry decision access
            </button>
          </div>
        </div>
      ) : null}

      {decisionNotice ? (
        <p
          className={`approval-notice approval-notice-${decisionNotice.status}`}
          role={decisionNotice.status === "error" ? "alert" : "status"}
          aria-live={decisionNotice.status === "error" ? "assertive" : "polite"}
        >
          {decisionNotice.message}
        </p>
      ) : null}
    </section>
  );
}
