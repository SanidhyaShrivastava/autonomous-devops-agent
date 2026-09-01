"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
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
const HEALTH_FRESHNESS_MS = 8_000;
const FIXED_CAPABILITY_ID = "fixed_disposable_service_v1";

const RECOVERY_STATE_COPY = {
  approved: {
    heading: "Restart approved",
    message:
      "The one-time fixed restart is authorized. The runner has not claimed it yet.",
    tone: "warning",
  },
  claimed: {
    heading: "Restart in progress",
    message:
      "The runner claimed this request. A second restart cannot be issued while it runs.",
    tone: "warning",
  },
  failed: {
    heading: "Recovery failed",
    message:
      "The fixed restart did not produce a verified healthy service. It will not retry automatically.",
    tone: "danger",
  },
  rejected: {
    heading: "Recovery rejected",
    message: "No restart was authorized or sent to the Linux runner.",
    tone: "neutral",
  },
  expired: {
    heading: "Approval expired",
    message: "The approval window closed. No restart was authorized.",
    tone: "neutral",
  },
  not_needed: {
    heading: "Recovery not needed",
    message:
      "A fresh health check showed that the service was already healthy, so no restart ran.",
    tone: "success",
  },
  execution_unknown: {
    heading: "Recovery result unknown",
    message:
      "The runner stopped reporting after it claimed the restart. The command will not be replayed.",
    tone: "danger",
  },
} as const;

const RECOVERY_REASON_COPY = {
  approval_expired: {
    heading: "Approval window expired",
    message:
      "The request expired before an owner approved it. No restart was authorized.",
    tone: "neutral",
  },
  command_expired: {
    heading: "Approved restart expired",
    message:
      "The restart was approved, but the runner did not claim it before the deadline.",
    tone: "neutral",
  },
  runner_revoked_before_claim: {
    heading: "Runner revoked before restart",
    message:
      "Runner access was revoked before it claimed the restart. No action was executed.",
    tone: "neutral",
  },
  runner_lost_during_action: {
    heading: "Runner lost during restart",
    message:
      "The runner stopped reporting after it claimed the restart. The result cannot be confirmed or replayed.",
    tone: "danger",
  },
  runner_revoked_after_claim: {
    heading: "Runner revoked during restart",
    message:
      "Runner access was revoked after it claimed the restart. The result is unknown and will not be replayed.",
    tone: "danger",
  },
  execution_failed: {
    heading: "Restart command failed",
    message:
      "The runner reported that the fixed restart failed. The service was not marked recovered.",
    tone: "danger",
  },
  verification_failed: {
    heading: "Recovery verification failed",
    message:
      "The restart ran, but fresh verification did not prove a healthy new service instance.",
    tone: "danger",
  },
} as const;

function getRecoveryCopy(status: string, terminalReason?: string | null) {
  if (terminalReason && terminalReason in RECOVERY_REASON_COPY) {
    return RECOVERY_REASON_COPY[
      terminalReason as keyof typeof RECOVERY_REASON_COPY
    ];
  }
  if (status in RECOVERY_STATE_COPY) {
    return RECOVERY_STATE_COPY[status as keyof typeof RECOVERY_STATE_COPY];
  }
  return null;
}

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
  const { isAuthenticated } = useConvexAuth();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const state = useQuery(
    api.runners.listMine,
    isAuthenticated && !isSigningOut ? {} : "skip",
  );
  const createEnrollment = useMutation(api.runners.createEnrollment);
  const revokeRunner = useMutation(api.runners.revoke);
  const registerFixedWorkload = useMutation(api.runners.registerFixedWorkload);
  const requestFixedRecovery = useMutation(api.runners.requestFixedRecovery);
  const decideFixedRecovery = useMutation(api.runners.decideFixedRecovery);
  const { signOut } = useAuthActions();
  const router = useRouter();
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [hasPermission, setHasPermission] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);
  const [showReplacementForm, setShowReplacementForm] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<
    "register" | "prepare" | "approve" | "reject" | null
  >(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const stateHeadingRef = useRef<HTMLHeadingElement>(null);
  const operationHeadingRef = useRef<HTMLHeadingElement>(null);
  const operationInFlightRef = useRef(false);
  const revocationInFlightRef = useRef(false);
  const signOutStartedRef = useRef(false);

  const runner = state?.runner ?? null;
  const activeRunner = runner && runner.revokedAt === null ? runner : null;
  const runnerOnline = Boolean(
    activeRunner?.lastHeartbeatAt &&
      clock - activeRunner.lastHeartbeatAt < RUNNER_FRESHNESS_MS,
  );
  const capabilityFresh = Boolean(
    runnerOnline &&
      activeRunner?.capabilityId === FIXED_CAPABILITY_ID &&
      activeRunner.capabilityReportedAt &&
      clock - activeRunner.capabilityReportedAt < RUNNER_FRESHNESS_MS,
  );
  const workload = state?.workload ?? null;
  const latestRecovery = state?.latestRecovery ?? null;
  const activeRunnerId = activeRunner?.runnerId ?? null;
  const healthFresh = Boolean(
    workload?.healthReportedAt &&
      clock - workload.healthReportedAt < HEALTH_FRESHNESS_MS,
  );
  const recoveryVerified = Boolean(
    latestRecovery?.status === "succeeded" &&
      latestRecovery.executionResultCode === "restart_succeeded" &&
      latestRecovery.verificationStatus === "healthy" &&
      latestRecovery.verificationDetailCode === "exact_http_200" &&
      latestRecovery.postActionInstanceId &&
      latestRecovery.postActionInstanceId !==
        latestRecovery.preActionInstanceId,
  );
  const previousSuccessSuperseded = Boolean(
    latestRecovery?.status === "succeeded" &&
      healthFresh &&
      workload?.healthStatus === "unhealthy",
  );
  const recoveryPathVerified =
    recoveryVerified && !previousSuccessSuperseded;
  const recoveryFocusKey = workload
    ? `${workload.workloadId}:${workload.healthStatus}:${latestRecovery?.status ?? "none"}`
    : null;
  const recoveryIsActive = Boolean(
    latestRecovery?.status === "pending_approval" ||
      latestRecovery?.status === "approved" ||
      latestRecovery?.status === "claimed",
  );
  const recoveryIsStickyTerminal = Boolean(
    latestRecovery?.status === "failed" ||
      latestRecovery?.status === "rejected" ||
      latestRecovery?.status === "expired" ||
      latestRecovery?.status === "execution_unknown",
  );
  const latestRecoveryCopy = latestRecovery
    ? getRecoveryCopy(latestRecovery.status, latestRecovery.terminalReason)
    : null;
  const approvalWindowOpen = Boolean(
    latestRecovery?.status === "pending_approval" &&
      latestRecovery.deadlineAt > clock,
  );
  const canApproveFixedRecovery = Boolean(
    approvalWindowOpen &&
      runnerOnline &&
      capabilityFresh &&
      healthFresh &&
      workload?.healthStatus === "unhealthy",
  );
  const recoveryPrerequisitesFresh = Boolean(
    !recoveryIsActive &&
      activeRunner &&
      runnerOnline &&
      capabilityFresh &&
      workload &&
      healthFresh &&
      workload.healthStatus === "unhealthy",
  );
  const canPrepareFixedRecovery =
    !isRevoking && recoveryPrerequisitesFresh;
  const recoverySafetyStatus = !runnerOnline
    ? "Recovery is blocked because the runner heartbeat is offline."
    : !capabilityFresh
      ? "Recovery is blocked because the fixed recovery capability is stale."
      : !workload
        ? "The fixed recovery capability is fresh. No service is registered yet."
        : !healthFresh
          ? "Recovery is blocked because the service health report is stale."
          : workload.healthStatus === "unhealthy"
            ? "The service is unhealthy. Recovery requires an owner decision."
            : workload.healthStatus === "healthy"
              ? "The service has a fresh healthy report."
              : "Recovery is blocked while the first health report is pending.";
  const waitingEnrollment =
    state?.enrollment?.state === "waiting" ? state.enrollment : null;
  const showCreateForm =
    !activeRunner &&
    (!waitingEnrollment || Boolean(issuedCode) || showReplacementForm);

  useEffect(() => {
    if (!activeRunnerId) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activeRunnerId]);

  useEffect(() => {
    if (activeRunnerId || issuedCode || showReplacementForm) {
      stateHeadingRef.current?.focus();
    }
  }, [activeRunnerId, issuedCode, showReplacementForm]);

  useEffect(() => {
    if (!recoveryFocusKey) return;
    operationHeadingRef.current?.focus();
  }, [recoveryFocusKey]);

  useEffect(() => {
    if (!isSigningOut || signOutStartedRef.current) return;
    signOutStartedRef.current = true;
    void (async () => {
      try {
        await signOut();
        router.push("/");
        router.refresh();
      } catch {
        signOutStartedRef.current = false;
        setIsSigningOut(false);
        setNotice("Sign out failed. Your private runner page is still open.");
      }
    })();
  }, [isSigningOut, router, signOut]);

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
    if (
      !activeRunner ||
      isRevoking ||
      revocationInFlightRef.current ||
      operationInFlightRef.current ||
      pendingOperation !== null
    ) {
      return;
    }
    revocationInFlightRef.current = true;
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
      revocationInFlightRef.current = false;
      setIsRevoking(false);
    }
  }

  async function runOwnerOperation(
    operation: "register" | "prepare" | "approve" | "reject",
    request: () => Promise<unknown>,
    successMessage: string,
    failureMessage: string,
  ) {
    if (
      operationInFlightRef.current ||
      revocationInFlightRef.current ||
      isRevoking
    ) {
      return;
    }
    operationInFlightRef.current = true;
    setPendingOperation(operation);
    setNotice(null);
    try {
      await request();
      setNotice(successMessage);
    } catch {
      setNotice(failureMessage);
    } finally {
      operationInFlightRef.current = false;
      setPendingOperation(null);
      operationHeadingRef.current?.focus();
    }
  }

  function handleRegisterWorkload() {
    if (
      isRevoking ||
      revocationInFlightRef.current ||
      !activeRunner ||
      !capabilityFresh ||
      workload
    ) {
      return;
    }
    void runOwnerOperation(
      "register",
      () => registerFixedWorkload({}),
      "Disposable service registered.",
      "The service could not be registered. Keep the runner online and try again.",
    );
  }

  function handlePrepareRecovery() {
    if (
      !activeRunner ||
      isRevoking ||
      revocationInFlightRef.current ||
      !capabilityFresh ||
      !runnerOnline ||
      !workload ||
      !healthFresh ||
      workload.healthStatus !== "unhealthy" ||
      !canPrepareFixedRecovery
    ) {
      return;
    }
    void runOwnerOperation(
      "prepare",
      () => requestFixedRecovery({}),
      "Approval-first recovery prepared. Review the fixed action before approving it.",
      "Recovery could not be prepared. The runner and unhealthy report must both be fresh.",
    );
  }

  function handleRecoveryDecision(decision: "approved" | "rejected") {
    if (
      isRevoking ||
      revocationInFlightRef.current ||
      !latestRecovery ||
      latestRecovery.status !== "pending_approval"
    ) {
      return;
    }
    const approving = decision === "approved";
    if (!approvalWindowOpen || (approving && !canApproveFixedRecovery)) return;
    void runOwnerOperation(
      approving ? "approve" : "reject",
      () =>
        decideFixedRecovery({
          commandId: latestRecovery.commandId,
          decision,
        }),
      approving
        ? "Fixed restart approved."
        : "Recovery rejected. No restart was authorized.",
      approving
        ? "Approval failed. No restart was authorized."
        : "Rejection could not be recorded. Try again.",
    );
  }

  function handleSignOut() {
    setIsSigningOut(true);
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
        <button
          className="quiet-action"
          disabled={isSigningOut}
          onClick={handleSignOut}
          type="button"
        >
          {isSigningOut ? "Signing out…" : "Sign out"}
        </button>
      </header>

      <section className="onboarding-hero" aria-labelledby="onboarding-title">
        <p className="section-kicker">Server onboarding · private preview</p>
        <h1 id="onboarding-title">Connect one Linux runner</h1>
        <p>
          {workload
            ? "Fixed policy recovery is active for one disposable service: one health check, one approval-required restart, and fresh verification."
            : "Give the control plane a heartbeat from one non-sensitive Linux server. This proves ownership and reachability before any service access is added."}
        </p>
      </section>

      <ol className="connection-rail" aria-label="Recovery authority path">
        <li
          className={`connection-node ${
            runnerOnline
              ? "connection-node-online"
              : activeRunner
                ? "connection-node-danger"
                : "connection-node-current"
          }`}
        >
          <span>01</span>
          <strong>Runner</strong>
          <small>
            {runnerOnline
              ? "Online"
              : activeRunner
                ? "Heartbeat offline"
                : "Connect first"}
          </small>
        </li>
        <li className="connection-line" aria-hidden="true">→</li>
        <li
          className={`connection-node ${
            workload && healthFresh
              ? workload.healthStatus === "healthy"
                ? "connection-node-online"
                : "connection-node-danger"
              : activeRunner
                ? "connection-node-current"
                : ""
          }`}
        >
          <span>02</span>
          <strong>Health check</strong>
          <small>
            {workload && healthFresh
              ? workload.healthStatus === "healthy"
                ? "Fresh HTTP 200"
                : "Unhealthy"
              : workload
                ? "Waiting for fresh report"
                : "Not registered"}
          </small>
        </li>
        <li className="connection-line" aria-hidden="true">→</li>
        <li
          className={`connection-node ${
            latestRecovery?.status === "pending_approval"
              ? "connection-node-current connection-node-warning"
              : latestRecovery?.status === "approved" ||
                  latestRecovery?.status === "claimed" ||
                  recoveryPathVerified
                ? "connection-node-online"
                : ""
          }`}
        >
          <span>03</span>
          <strong>Approval</strong>
          <small>
            {latestRecovery?.status === "pending_approval"
              ? "Owner decision needed"
              : latestRecovery?.approvedAt && !previousSuccessSuperseded
                ? "Approved"
                : "Always required"}
          </small>
        </li>
        <li className="connection-line" aria-hidden="true">→</li>
        <li
          className={`connection-node ${
            latestRecovery?.status === "approved"
              ? "connection-node-current connection-node-warning"
              : latestRecovery?.status === "claimed"
                ? "connection-node-current"
                : recoveryPathVerified
                  ? "connection-node-online"
                  : ""
          }`}
        >
          <span>04</span>
          <strong>Restart</strong>
          <small>
            {latestRecovery?.status === "claimed"
              ? "Executing"
              : recoveryPathVerified
                ? "Completed"
                : "Fixed action only"}
          </small>
        </li>
        <li className="connection-line" aria-hidden="true">→</li>
        <li
          className={`connection-node ${
            recoveryPathVerified ? "connection-node-online" : ""
          }`}
        >
          <span>05</span>
          <strong>Verified</strong>
          <small>
            {recoveryPathVerified ? "Recovery was verified" : "Not reached"}
          </small>
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
              <span
                className={`system-badge ${runnerOnline ? "badge-online" : "badge-offline"}`}
              >
                <span className="status-dot" aria-hidden="true" />
                {runnerOnline ? "Online" : "Heartbeat offline"}
              </span>
              <span
                aria-label="Runner connection status"
                aria-live="polite"
                className="visually-hidden"
                role="status"
              >
                {runnerOnline
                  ? "Runner heartbeat online."
                  : "Runner heartbeat offline."}
              </span>
              <span
                aria-label="Recovery safety status"
                aria-live="polite"
                className="visually-hidden"
                role="status"
              >
                {recoverySafetyStatus}
              </span>
              <p className="runner-summary">
                <strong>{activeRunner.label}</strong>
                <span>Linux · {activeRunner.architecture} · agent {activeRunner.agentVersion}</span>
              </p>

              <section className="recovery-control" aria-labelledby="recovery-state-title">
                {!workload ? (
                  capabilityFresh ? (
                    <div className="recovery-next-action">
                      <p className="section-kicker">Next safe grant</p>
                      <h3
                        id="recovery-state-title"
                        ref={operationHeadingRef}
                        tabIndex={-1}
                      >
                        Register one fixed service
                      </h3>
                      <p>
                        This enables one fixed HTTP health check and one fixed restart.
                        There are no editable paths, URLs, or commands.
                      </p>
                      <button
                        className="primary-action recovery-primary-action"
                        disabled={isRevoking || pendingOperation !== null}
                        onClick={handleRegisterWorkload}
                        type="button"
                      >
                        {pendingOperation === "register"
                          ? "Registering service…"
                          : "Register disposable service"}
                      </button>
                    </div>
                  ) : (
                    <div className="recovery-outcome recovery-outcome-neutral">
                      <p className="section-kicker">No service authority yet</p>
                      <h3
                        id="recovery-state-title"
                        ref={operationHeadingRef}
                        tabIndex={-1}
                      >
                        Waiting for safe runner capability
                      </h3>
                      <p>
                        Waiting for the fixed service capability from a fresh runner
                        heartbeat. No recovery actions are enabled.
                      </p>
                    </div>
                  )
                ) : (
                  <>
                    <dl className="fixed-policy-facts" aria-label="Fixed recovery policy">
                      <div><dt>Service</dt><dd>Connected demo service</dd></div>
                      <div><dt>Health check</dt><dd>Fixed HTTP 200 health check</dd></div>
                      <div><dt>Recovery action</dt><dd>Fixed service restart</dd></div>
                      <div><dt>Decision rule</dt><dd>Human approval required</dd></div>
                    </dl>

                    {latestRecovery?.status === "pending_approval" ? (
                      <div className="recovery-outcome recovery-outcome-warning">
                        <p className="section-kicker">Owner decision</p>
                        <h3
                          id="recovery-state-title"
                          ref={operationHeadingRef}
                          tabIndex={-1}
                        >
                          Approval required
                        </h3>
                        <p>
                          The fixed restart is prepared. Nothing runs until you choose.
                        </p>
                        {!canApproveFixedRecovery ? (
                          <p className="approval-blocked-copy">
                            Approval is blocked until the runner, capability, and
                            unhealthy health report are fresh. You can still reject it.
                          </p>
                        ) : null}
                        <div className="recovery-decision-actions">
                          <button
                            className="approval-owner-action"
                            disabled={
                              isRevoking ||
                              pendingOperation !== null ||
                              !canApproveFixedRecovery
                            }
                            onClick={() => handleRecoveryDecision("approved")}
                            type="button"
                          >
                            {pendingOperation === "approve"
                              ? "Approving…"
                              : "Approve fixed restart"}
                          </button>
                          <button
                            className="rejection-owner-action"
                            disabled={
                              isRevoking ||
                              pendingOperation !== null ||
                              !approvalWindowOpen
                            }
                            onClick={() => handleRecoveryDecision("rejected")}
                            type="button"
                          >
                            {pendingOperation === "reject" ? "Rejecting…" : "Reject"}
                          </button>
                        </div>
                      </div>
                    ) : latestRecovery?.status === "approved" ||
                      latestRecovery?.status === "claimed" ? (
                      <div
                        className={`recovery-outcome recovery-outcome-${
                          RECOVERY_STATE_COPY[
                            latestRecovery.status as keyof typeof RECOVERY_STATE_COPY
                          ].tone
                        }`}
                      >
                        <p className="section-kicker">Latest recovery</p>
                        <h3
                          id="recovery-state-title"
                          ref={operationHeadingRef}
                          tabIndex={-1}
                        >
                          {
                            RECOVERY_STATE_COPY[
                              latestRecovery.status as keyof typeof RECOVERY_STATE_COPY
                            ].heading
                          }
                        </h3>
                        <p>
                          {
                            RECOVERY_STATE_COPY[
                              latestRecovery.status as keyof typeof RECOVERY_STATE_COPY
                            ].message
                          }
                        </p>
                      </div>
                    ) : recoveryIsStickyTerminal && latestRecoveryCopy ? (
                      <div
                        className={`recovery-outcome recovery-outcome-${latestRecoveryCopy.tone}`}
                      >
                        <p className="section-kicker">Latest recovery</p>
                        <h3
                          id="recovery-state-title"
                          ref={operationHeadingRef}
                          tabIndex={-1}
                        >
                          {latestRecoveryCopy.heading}
                        </h3>
                        <p>{latestRecoveryCopy.message}</p>
                        {recoveryPrerequisitesFresh ? (
                          <button
                            className="primary-action recovery-primary-action"
                            disabled={isRevoking || pendingOperation !== null}
                            onClick={handlePrepareRecovery}
                            type="button"
                          >
                            {pendingOperation === "prepare"
                              ? "Preparing recovery…"
                              : "Prepare approval-first recovery"}
                          </button>
                        ) : null}
                      </div>
                    ) : !runnerOnline ? (
                      <div className="recovery-outcome recovery-outcome-danger">
                        <p className="section-kicker">Connection required</p>
                        <h3
                          id="recovery-state-title"
                          ref={operationHeadingRef}
                          tabIndex={-1}
                        >
                          Runner offline
                        </h3>
                        <p>Recovery is blocked until this runner sends a fresh heartbeat.</p>
                      </div>
                    ) : !capabilityFresh ? (
                      <div className="recovery-outcome recovery-outcome-neutral">
                        <p className="section-kicker">Capability required</p>
                        <h3
                          id="recovery-state-title"
                          ref={operationHeadingRef}
                          tabIndex={-1}
                        >
                          Waiting for safe runner capability
                        </h3>
                        <p>
                          The runner is online, but its fixed recovery capability is not fresh.
                        </p>
                      </div>
                    ) : !healthFresh || workload.healthStatus === "unknown" ? (
                      <div className="recovery-outcome recovery-outcome-neutral">
                        <p className="section-kicker">Health required</p>
                        <h3
                          id="recovery-state-title"
                          ref={operationHeadingRef}
                          tabIndex={-1}
                        >
                          Waiting for fresh health
                        </h3>
                        <p>
                          No recovery can be prepared until the fixed health check reports again.
                        </p>
                      </div>
                    ) : workload.healthStatus === "unhealthy" ? (
                      <div className="recovery-outcome recovery-outcome-danger">
                        <p className="section-kicker">Current outcome</p>
                        <h3
                          id="recovery-state-title"
                          ref={operationHeadingRef}
                          tabIndex={-1}
                        >
                          Service unhealthy
                        </h3>
                        <p>
                          The fresh fixed health check failed. Prepare the one allowlisted
                          restart for an explicit owner decision.
                        </p>
                        <button
                          className="primary-action recovery-primary-action"
                          disabled={isRevoking || pendingOperation !== null}
                          onClick={handlePrepareRecovery}
                          type="button"
                        >
                          {pendingOperation === "prepare"
                            ? "Preparing recovery…"
                            : "Prepare approval-first recovery"}
                        </button>
                      </div>
                    ) : latestRecovery?.status === "succeeded" ? (
                      recoveryVerified ? (
                        <div className="recovery-outcome recovery-outcome-success">
                          <p className="section-kicker">Verified outcome</p>
                          <h3
                            id="recovery-state-title"
                            ref={operationHeadingRef}
                            tabIndex={-1}
                          >
                            Recovery verified
                          </h3>
                          <p>
                            A fresh HTTP 200 health check passed after the service
                            instance changed. The restart is complete.
                          </p>
                          <strong className="verified-instance">
                            {latestRecovery.postActionInstanceId}
                          </strong>
                        </div>
                      ) : (
                        <div className="recovery-outcome recovery-outcome-danger">
                          <p className="section-kicker">Verification blocked</p>
                          <h3
                            id="recovery-state-title"
                            ref={operationHeadingRef}
                            tabIndex={-1}
                          >
                            Verification evidence incomplete
                          </h3>
                          <p>
                            A command result arrived, but it did not prove both a fresh
                            HTTP 200 and a changed service instance.
                          </p>
                        </div>
                      )
                    ) : latestRecoveryCopy ? (
                      <div
                        className={`recovery-outcome recovery-outcome-${latestRecoveryCopy.tone}`}
                      >
                        <p className="section-kicker">Latest recovery</p>
                        <h3
                          id="recovery-state-title"
                          ref={operationHeadingRef}
                          tabIndex={-1}
                        >
                          {latestRecoveryCopy.heading}
                        </h3>
                        <p>{latestRecoveryCopy.message}</p>
                      </div>
                    ) : (
                      <div className="recovery-outcome recovery-outcome-success">
                        <p className="section-kicker">Current outcome</p>
                        <h3
                          id="recovery-state-title"
                          ref={operationHeadingRef}
                          tabIndex={-1}
                        >
                          Healthy — no recovery needed
                        </h3>
                        <p>
                          The fixed health check returned a fresh HTTP 200. No restart is permitted.
                        </p>
                      </div>
                    )}

                    <details className="technical-identifiers">
                      <summary>Technical identifiers</summary>
                      <dl>
                        <div><dt>Runner ID</dt><dd><code>{activeRunner.runnerId}</code></dd></div>
                        <div><dt>Workload ID</dt><dd><code>{workload.workloadId}</code></dd></div>
                        <div><dt>Health check ID</dt><dd><code>{workload.healthCheckId}</code></dd></div>
                        <div><dt>Action ID</dt><dd><code>{workload.recoveryActionId}</code></dd></div>
                        {latestRecovery ? (
                          <div><dt>Recovery ID</dt><dd><code>{latestRecovery.commandId}</code></dd></div>
                        ) : null}
                      </dl>
                    </details>
                  </>
                )}
              </section>

              <div className="runner-access-control">
                <div>
                  <strong>Runner access</strong>
                  <p>Revocation is separate from any recovery decision.</p>
                </div>
                <button
                  className="danger-outline-action"
                  disabled={isRevoking || pendingOperation !== null}
                  onClick={handleRevoke}
                  type="button"
                >
                  {isRevoking ? "Revoking…" : "Revoke runner access"}
                </button>
              </div>
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
            <div>
              <dt>Connection</dt>
              <dd>{workload ? "Outbound HTTPS runner channel" : "Outbound HTTPS heartbeat only"}</dd>
            </div>
            <div><dt>Recovery policy</dt><dd>{workload ? "Approval-first" : "Not configured"}</dd></div>
            <div>
              <dt>Enabled actions</dt>
              <dd className={workload ? "policy-ready" : "policy-warning"}>
                {workload ? "One allowlisted restart" : "No recovery actions enabled"}
              </dd>
            </div>
            <div>
              <dt>Host access</dt>
              <dd>{workload ? "One health probe + one restart; no shell input" : "No shell, logs, files, or discovery"}</dd>
            </div>
          </dl>
          <p>
            {workload
              ? "This is fixed policy recovery, not AI investigation. The private path cannot discover services or accept generated commands."
              : "Registration grants one explicit service and one safe action. Pairing alone does not grant that authority."}
          </p>
        </aside>
      </div>
    </div>
  );
}
