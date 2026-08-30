import type { FunctionReturnType } from "convex/server";

import { api } from "../../convex/_generated/api";

type PublicDemoState = FunctionReturnType<typeof api.demo.getPublicState>;
type PublicIncident = NonNullable<PublicDemoState["incident"]>;
type PublicStep = PublicDemoState["steps"][number];

function humanize(value: string | null) {
  if (!value) {
    return "Not available";
  }

  return value
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatDuration(durationMs: number | null) {
  if (durationMs === null) {
    return "Not available";
  }

  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  if (durationMs < 60_000) {
    const seconds = durationMs / 1_000;
    return `${seconds.toFixed(Number.isInteger(seconds) ? 0 : 1)}s`;
  }

  const totalSeconds = Math.round(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function lastStepOfKinds(steps: PublicStep[], kinds: string[]) {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index] && kinds.includes(steps[index].kind)) {
      return steps[index];
    }
  }

  return null;
}

function outcomeFor(incident: PublicIncident | null) {
  switch (incident?.currentPhase) {
    case "resolved":
      return {
        label: "Recovered successfully",
        tone: "success",
        health: "Healthy after fresh check",
      } as const;
    case "needs_human":
      return {
        label: "Investigation complete, human decision required",
        tone: "warning",
        health:
          incident.finalHealth === "healthy"
            ? "Healthy without an agent action"
            : "No verified recovery",
      } as const;
    case "failed_recovery":
      return {
        label: "Recovery failed verification",
        tone: "danger",
        health: "Still unhealthy after fresh check",
      } as const;
    case "investigation_failed":
      return {
        label: "Investigation did not complete",
        tone: "danger",
        health: "Recovery not attempted",
      } as const;
    default:
      return {
        label: incident ? "Resolution pending" : "Awaiting first incident",
        tone: "neutral",
        health: incident ? "Verification pending" : "No measured result yet",
      } as const;
  }
}

function humanIntervention(incident: PublicIncident | null) {
  if (!incident) {
    return "Not available";
  }

  if (
    incident.currentPhase === "needs_human" ||
    incident.currentPhase === "investigation_failed" ||
    incident.requiresHuman
  ) {
    return "Required";
  }

  if (
    incident.currentPhase === "resolved" ||
    incident.currentPhase === "failed_recovery"
  ) {
    return "None";
  }

  return "Pending";
}

export function ResolutionCard({
  incident,
  result,
  steps,
}: {
  incident: PublicDemoState["incident"];
  result: PublicDemoState["result"];
  steps: PublicStep[];
}) {
  const outcome = outcomeFor(incident);
  const recoveryStep = lastStepOfKinds(steps, [
    "recovery_executed",
    "recovery_failed",
  ]);
  const verificationStep = lastStepOfKinds(steps, ["verification_completed"]);
  const recoveryAction = recoveryStep?.safeCommandLabel
    ? recoveryStep.kind === "recovery_failed"
      ? `${recoveryStep.safeCommandLabel} · attempt failed`
      : recoveryStep.safeCommandLabel
    : "No recovery action executed";
  const confidence =
    incident?.confidence === null || incident?.confidence === undefined
      ? null
      : `${Math.round(incident.confidence * 100)}% confidence`;

  return (
    <aside className="panel resolution-panel" aria-labelledby="resolution-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Measured outcome</p>
          <h2 id="resolution-title">Resolution record</h2>
        </div>
        <span className={`outcome-signal outcome-${outcome.tone}`}>
          <span className="status-dot" aria-hidden="true" />
          {incident?.currentPhase ? humanize(incident.currentPhase) : "Waiting"}
        </span>
      </div>

      <div className={`outcome-banner outcome-banner-${outcome.tone}`}>
        <span className="outcome-path" aria-hidden="true">
          {incident ? "FAILED →" : "—"}
        </span>
        <strong>{outcome.label}</strong>
        <span>{outcome.health}</span>
      </div>

      <dl className="resolution-list">
        <div>
          <dt>Incident type</dt>
          <dd>{humanize(incident?.incidentCategory ?? null)}</dd>
        </div>
        <div>
          <dt>Root cause</dt>
          <dd>
            {incident?.diagnosisSummary ?? "Not available"}
            {confidence ? <small>{confidence}</small> : null}
          </dd>
        </div>
        <div>
          <dt>Executed action</dt>
          <dd>
            <code>{recoveryAction}</code>
          </dd>
        </div>
        <div>
          <dt>Fresh verification</dt>
          <dd>
            {outcome.health}
            {verificationStep?.sanitizedOutput ? (
              <code className="verification-evidence">
                {verificationStep.sanitizedOutput}
              </code>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Human intervention</dt>
          <dd>{humanIntervention(incident)}</dd>
        </div>
        <div>
          <dt>Recovery time</dt>
          <dd>{formatDuration(result?.totalLatencyMs ?? null)}</dd>
        </div>
      </dl>

      {incident?.diagnosisEvidence?.length ? (
        <div className="evidence-block">
          <h3>Evidence behind the diagnosis</h3>
          <ul>
            {incident.diagnosisEvidence.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="result-empty">
          Evidence and measured recovery values will appear after a run.
        </p>
      )}

      {incident?.terminalReason ? (
        <p className="terminal-reason">
          <span>System record</span>
          {humanize(incident.terminalReason)}
        </p>
      ) : null}
    </aside>
  );
}
