"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { api } from "../../convex/_generated/api";

const RUNNER_FRESHNESS_MS = 6_000;

function base64Url(bytes: Uint8Array) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return window
    .btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createPairingCode() {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  return `gxpair_${base64Url(bytes)}`;
}

async function sha256(value: string) {
  const digest = await window.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function ServerOnboarding() {
  const state = useQuery(api.runners.listMine);
  const createEnrollment = useMutation(api.runners.createEnrollment);
  const revokeRunner = useMutation(api.runners.revoke);
  const { signOut } = useAuthActions();
  const router = useRouter();
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [hasPermission, setHasPermission] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);
  const [showReplacementForm, setShowReplacementForm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const stateHeadingRef = useRef<HTMLHeadingElement>(null);

  const runner = state?.runner ?? null;
  const activeRunner = runner && runner.revokedAt === null ? runner : null;
  const runnerOnline = Boolean(
    activeRunner?.lastHeartbeatAt &&
      clock - activeRunner.lastHeartbeatAt < RUNNER_FRESHNESS_MS,
  );
  const waitingEnrollment =
    state?.enrollment?.state === "waiting" ? state.enrollment : null;
  const showCreateForm =
    !activeRunner &&
    (!waitingEnrollment || Boolean(issuedCode) || showReplacementForm);

  useEffect(() => {
    if (!activeRunner) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activeRunner]);

  useEffect(() => {
    if (activeRunner || issuedCode || showReplacementForm) {
      stateHeadingRef.current?.focus();
    }
  }, [activeRunner, issuedCode, showReplacementForm]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isCreating || !hasPermission || label.trim().length < 2) return;
    setIsCreating(true);
    setNotice(null);
    const pairingCode = createPairingCode();
    try {
      await createEnrollment({
        codeDigest: await sha256(pairingCode),
        label: label.trim(),
      });
      setIssuedCode(pairingCode);
      setShowReplacementForm(false);
    } catch {
      setNotice("A pairing code could not be created. No credential was issued.");
    } finally {
      setIsCreating(false);
    }
  }

  async function copyPairingCode() {
    if (!issuedCode) return;
    try {
      await navigator.clipboard.writeText(issuedCode);
      setNotice("Pairing code copied. It expires in 10 minutes.");
    } catch {
      setNotice("Copy was blocked. Select the code and copy it manually.");
    }
  }

  async function handleRevoke() {
    if (!activeRunner || isRevoking) return;
    setIsRevoking(true);
    setNotice(null);
    try {
      await revokeRunner({ runnerId: activeRunner.runnerId });
      setIssuedCode(null);
      setLabel("");
      setHasPermission(false);
      setNotice("Runner access revoked. Its saved credential can no longer heartbeat.");
    } catch {
      setNotice("Runner access could not be revoked. Try again.");
    } finally {
      setIsRevoking(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <div className="onboarding-shell">
      <header className="onboarding-topbar">
        <Link className="product-mark" href="/" aria-label="Return to public demo">
          <span>
            <strong>Autonomous DevOps Agent</strong>
            <small>Runner onboarding</small>
          </span>
        </Link>
        <button className="quiet-action" onClick={handleSignOut} type="button">
          Sign out
        </button>
      </header>

      <section className="onboarding-hero" aria-labelledby="onboarding-title">
        <p className="section-kicker">Server onboarding · private preview</p>
        <h1 id="onboarding-title">Connect one Linux runner</h1>
        <p>
          Give the control plane a heartbeat from one non-sensitive Linux server.
          This proves ownership and reachability before any service access is added.
        </p>
      </section>

      <ol className="connection-rail" aria-label="Connection path">
        <li className="connection-node connection-node-active">
          <span>01</span>
          <strong>Browser</strong>
          <small>Signed-in owner</small>
        </li>
        <li className="connection-line" aria-hidden="true">→</li>
        <li className="connection-node connection-node-active">
          <span>02</span>
          <strong>Control plane</strong>
          <small>One-time pairing</small>
        </li>
        <li className="connection-line" aria-hidden="true">→</li>
        <li className={`connection-node ${runnerOnline ? "connection-node-online" : ""}`}>
          <span>03</span>
          <strong>Linux runner</strong>
          <small>{runnerOnline ? "Heartbeat online" : "Awaiting heartbeat"}</small>
        </li>
      </ol>

      <div className="onboarding-grid">
        <section className="onboarding-panel" aria-labelledby="connection-step-title">
          {state === undefined ? (
            <div className="onboarding-state" role="status">
              <p className="section-kicker">Checking owner state</p>
              <h2 id="connection-step-title">Loading runner access…</h2>
            </div>
          ) : activeRunner ? (
            <div className="onboarding-state">
              <p className="section-kicker">Connection received</p>
              <h2 id="connection-step-title" ref={stateHeadingRef} tabIndex={-1}>
                Runner connected
              </h2>
              <span className={`system-badge ${runnerOnline ? "badge-online" : "badge-offline"}`}>
                <span className="status-dot" aria-hidden="true" />
                {runnerOnline ? "Online" : "Heartbeat offline"}
              </span>
              <dl className="runner-facts">
                <div><dt>Private label</dt><dd>{activeRunner.label}</dd></div>
                <div><dt>Runner ID</dt><dd><code>{activeRunner.runnerId}</code></dd></div>
                <div><dt>Platform</dt><dd>Linux · {activeRunner.architecture}</dd></div>
                <div><dt>Agent</dt><dd>{activeRunner.agentVersion}</dd></div>
              </dl>
              <p className="onboarding-boundary-copy">
                No logs, services, or commands are available to the control plane.
                This runner sends heartbeat status only.
              </p>
              <button
                className="danger-outline-action"
                disabled={isRevoking}
                onClick={handleRevoke}
                type="button"
              >
                {isRevoking ? "Revoking…" : "Revoke runner access"}
              </button>
            </div>
          ) : waitingEnrollment && !issuedCode && !showReplacementForm ? (
            <div className="onboarding-state">
              <p className="section-kicker">Pairing window active</p>
              <h2 id="connection-step-title">Create a fresh one-time code</h2>
              <p>
                For safety, the previous code cannot be shown again after this page
                reloads. Creating a new code cancels the old one.
              </p>
              <button
                className="primary-action"
                onClick={() => {
                  setLabel(waitingEnrollment.label);
                  setShowReplacementForm(true);
                }}
                type="button"
              >
                Create a new code
              </button>
            </div>
          ) : issuedCode ? (
            <div className="onboarding-state">
              <p className="section-kicker">Pairing window open</p>
              <h2 id="connection-step-title" ref={stateHeadingRef} tabIndex={-1}>
                Run this on your Linux server
              </h2>
              <p>This one-time code expires in 10 minutes and connects only this runner.</p>
              <div className="pairing-code-block">
                <span>ONE-TIME PAIRING CODE</span>
                <code>{issuedCode}</code>
                <button className="copy-action" onClick={copyPairingCode} type="button">
                  Copy code
                </button>
              </div>
              <ol className="server-steps">
                <li><span>01</span><div><strong>Open the project on your Linux server</strong><code>git clone https://github.com/SanidhyaShrivastava/autonomous-devops-agent.git</code></div></li>
                <li><span>02</span><div><strong>Install this project</strong><code>cd autonomous-devops-agent &amp;&amp; npm install</code></div></li>
                <li><span>03</span><div><strong>Pair and paste the code when asked</strong><code>npm run host:pair</code></div></li>
                <li><span>04</span><div><strong>Start outbound heartbeats</strong><code>npm run host:connect</code></div></li>
              </ol>
              <p className="waiting-heartbeat" role="status">
                <span className="status-dot" aria-hidden="true" />
                Waiting for the first heartbeat…
              </p>
            </div>
          ) : showCreateForm ? (
            <form className="onboarding-form" onSubmit={handleCreate}>
              <p className="section-kicker">Step 01 · name the runner</p>
              <h2 id="connection-step-title" ref={stateHeadingRef} tabIndex={-1}>
                Create a one-time pairing code
              </h2>
              <label htmlFor="runner-label">Private runner label</label>
              <p className="field-help" id="runner-label-help">
                Use a private label such as staging-web-1. Do not enter a hostname,
                IP address, or secret.
              </p>
              <input
                aria-describedby="runner-label-help"
                autoComplete="off"
                id="runner-label"
                maxLength={48}
                minLength={2}
                onChange={(event) => setLabel(event.target.value)}
                required
                type="text"
                value={label}
              />
              <label className="permission-check">
                <input
                  checked={hasPermission}
                  onChange={(event) => setHasPermission(event.target.checked)}
                  type="checkbox"
                />
                <span>I own this server or have permission to connect it.</span>
              </label>
              <button
                className="primary-action"
                disabled={isCreating || !hasPermission || label.trim().length < 2}
                type="submit"
              >
                {isCreating ? "Creating one-time code…" : "Create pairing code"}
              </button>
            </form>
          ) : null}

          <p className="live-notice" aria-live="polite" role="status">
            {notice}
          </p>
        </section>

        <aside className="onboarding-policy" aria-labelledby="policy-title">
          <p className="section-kicker">Fixed boundary</p>
          <h2 id="policy-title">Access before authority</h2>
          <dl>
            <div><dt>Environment</dt><dd>One non-sensitive Linux server</dd></div>
            <div><dt>Connection</dt><dd>Outbound HTTPS heartbeat only</dd></div>
            <div><dt>Recovery policy</dt><dd>Not configured</dd></div>
            <div><dt>Enabled actions</dt><dd className="policy-warning">No recovery actions enabled</dd></div>
            <div><dt>Host access</dt><dd>No shell, logs, files, or discovery</dd></div>
          </dl>
          <p>
            The next build will register one explicit service and one safe action.
            Pairing this runner does not grant that authority.
          </p>
        </aside>
      </div>
    </div>
  );
}
