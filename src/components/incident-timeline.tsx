import type { FunctionReturnType } from "convex/server";

import { api } from "../../convex/_generated/api";

type PublicDemoState = FunctionReturnType<typeof api.demo.getPublicState>;
type PublicStep = PublicDemoState["steps"][number];

const ROLE_LABELS: Record<PublicStep["role"], string> = {
  incident_manager: "Incident Manager",
  investigator: "Investigator",
  recovery_planner: "Recovery Planner",
  policy_gate: "Policy Gate",
  executor: "Executor",
  verifier: "Verifier",
};

const ACTION_LABELS: Record<string, string> = {
  reset_applied: "Seeded a disposable service failure",
  failure_confirmed: "Confirmed the service is unhealthy",
  safe_state_collected: "Read bounded container state",
  safe_logs_collected: "Read the latest 30 log lines",
  evidence_collection_failed: "Could not collect bounded evidence",
  diagnosis_failed: "Could not complete the diagnosis",
  diagnosis_completed: "Produced an evidence-backed diagnosis",
  manager_evidence_review: "Reviewed evidence and selected the next step",
  policy_decision: "Checked the action against the safety policy",
  recovery_failed: "Attempted the allowlisted, policy-checked recovery action",
  recovery_executed: "Executed the allowlisted, policy-checked recovery action",
  verification_completed: "Ran a fresh service health check",
};

const STATUS_LABELS: Record<PublicStep["status"], string> = {
  pending: "Pending",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  blocked: "Blocked",
};

const TIME_FORMATTER = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function humanize(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatLatency(latencyMs: number | null) {
  if (latencyMs === null) {
    return "Latency pending";
  }

  if (latencyMs < 1_000) {
    return `${latencyMs}ms`;
  }

  return `${(latencyMs / 1_000).toFixed(1)}s`;
}

function TimelineStep({ step }: { step: PublicStep }) {
  const action = ACTION_LABELS[step.kind] ?? humanize(step.kind);
  const status = STATUS_LABELS[step.status];

  return (
    <li
      className="trace-step"
      data-step-status={step.status}
      aria-current={step.status === "running" ? "step" : undefined}
    >
      <div className="trace-marker" aria-hidden="true">
        <span>{String(step.sequence).padStart(2, "0")}</span>
      </div>
      <article className="trace-card">
        <div className="trace-card-header">
          <div className="trace-identity">
            <span className="trace-role">{ROLE_LABELS[step.role]}</span>
            <span className={`trace-status trace-status-${step.status}`}>
              <span className="status-dot" aria-hidden="true" />
              {status}
            </span>
          </div>
          <time dateTime={new Date(step.startedAt).toISOString()}>
            {TIME_FORMATTER.format(step.startedAt)}
          </time>
        </div>

        <h3>{action}</h3>

        {step.safeCommandLabel ? (
          <div className="operation-line">
            <span className="operation-label">Operation</span>
            <code>{step.safeCommandLabel}</code>
          </div>
        ) : null}

        {step.sanitizedOutput ? (
          <details className="trace-evidence">
            <summary>View raw evidence</summary>
            <pre className="trace-output" data-testid="trace-output">
              {step.sanitizedOutput}
            </pre>
          </details>
        ) : null}

        {step.errorSummary ? (
          <p className="trace-error">{step.errorSummary}</p>
        ) : null}

        <div className="trace-metrics">
          <span>{formatLatency(step.latencyMs)}</span>
        </div>
      </article>
    </li>
  );
}

export function IncidentTimeline({ steps }: { steps: PublicStep[] }) {
  return (
    <section className="panel timeline-panel" aria-labelledby="timeline-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Live evidence</p>
          <h2 id="timeline-title">Incident timeline</h2>
        </div>
        <span className="step-count">
          {steps.length} {steps.length === 1 ? "step" : "steps"}
        </span>
      </div>

      {steps.length > 0 ? (
        <ol className="trace-list">
          {steps.map((step) => (
            <TimelineStep key={step.stepId} step={step} />
          ))}
        </ol>
      ) : (
        <div className="empty-state">
          <span className="empty-state-mark" aria-hidden="true">
            00
          </span>
          <div>
            <h3>No incident steps yet</h3>
            <p>
              Run the recovery demo to watch each recorded recovery step appear
              here.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
