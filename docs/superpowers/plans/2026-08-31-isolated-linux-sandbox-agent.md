# Isolated Linux Sandbox Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace direct macOS Docker control with a narrowly authenticated Linux sandbox agent that owns one disposable child service while preserving the verified public recovery loop.

**Architecture:** One pinned, non-root Linux container runs a small agent and one fixed child service. The existing trusted coordinator, Codex Investigator, Convex client, Policy Gate, and Verifier stay on the Mac; they reach the sandbox only through an authenticated loopback API with six fixed operations. The container gets no Docker socket, host mount, host networking, elevated capability, ChatGPT/Codex authentication, or Convex runner token.

**Tech Stack:** Node.js 24.20.0 Alpine container, TypeScript, built-in Node HTTP and child-process APIs, Docker Desktop, Zod, Vitest, Convex, existing Next.js 16.3.3 public UI.

**Spec:** `/Users/sanidhya/Downloads/GrowthX/IDEA_SCOPE.md`, section `approved isolated Linux sandbox slice (Mon 31 Aug, after M2)`.

## Global Constraints

- Keep the public evidence explicitly controlled/staged and capped at AI Agent real-output L3.
- Keep the current fixed IDs: runner `gx-local-runner`, workload `demo-service`, service `gx-autodevops-demo-service`, action `restart_demo_service`.
- The container name is `gx-autodevops-linux-sandbox`, image tag is `gx-autodevops-linux-sandbox:m2`, and required label is `com.growthx.sandbox=autonomous-devops-agent`.
- Publish only `127.0.0.1:3410:3000/tcp`; the child service health port stays inside the container at `127.0.0.1:3001`.
- Never pass the Docker socket, a host path, host networking, host process namespace, added Linux capabilities, a privileged flag, arbitrary commands, arbitrary file paths, ChatGPT/Codex auth, or the Convex runner token into the container.
- Run the container as non-root with a read-only root filesystem, `tmpfs` only for `/tmp`, all Linux capabilities dropped, `no-new-privileges`, a 256 MiB memory limit, a 1 CPU limit, and a 64-process limit.
- Derive a separate sandbox API token in memory with HMAC-SHA256 from `RUNNER_TOKEN` and the fixed context `gx-linux-sandbox-agent-v1`; pass only the derived value through the Docker child process environment, never a command argument or committed file.
- The agent API accepts only authenticated requests to: `GET /v1/workload/state`, `GET /v1/workload/logs`, `GET /v1/workload/health`, `POST /v1/demo/stop`, `POST /v1/demo/ensure`, and `POST /v1/actions/execute`.
- The agent starts/stops only `/usr/local/bin/node /app/workload.mjs` with `shell: false`; the model never receives execution authority.
- Preserve Convex heartbeats, two-missed-heartbeat loss detection, the 20-second step deadline, the 45-second run deadline, leases, terminal persistence, cleanup, and per-second UI updates.
- Keep legacy stored evidence with label `docker start fixed demo service` readable while new evidence uses `linux agent restart fixed demo service`.
- Do not add login, cloud provisioning, general server onboarding, systemd, multiple workloads, a runbook editor, or another failure type.
- Do not stop the current production runner until every local and container verification before cutover passes.

---

### Task 1: Make workload evidence labels transport-neutral and backward compatible

**Files:**
- Create: `runner/workload-types.ts`
- Modify: `runner/docker-adapter.ts`
- Modify: `runner/orchestrator.ts`
- Modify: `runner/environment-restorer.ts`
- Modify: `runner/convex-client.ts`
- Modify: `convex/runner.ts`
- Test: `tests/orchestrator.test.ts`
- Test: `tests/convex-runner-client.test.ts`
- Test: `tests/convex-state.test.ts`

**Interfaces:**
- Produces: `LEGACY_DOCKER_RECOVERY_LABEL`, `LINUX_AGENT_RECOVERY_LABEL`, `RecoveryCommandLabel`, `SafeWorkloadState`, `SafeLogTail`, `RecoveryActionResult`, and `HealthEvidence` from `runner/workload-types.ts`.
- Preserves: old stored incidents and the still-running old Mac runner continue to validate during rollout.

- [x] **Step 1: Write failing compatibility tests**

Add assertions that both exact labels parse through the Convex client and that Convex accepts and persists either submitted label while rejecting every third value:

```ts
expect(parseRecoveryLabel("docker start fixed demo service")).toBeTruthy();
expect(parseRecoveryLabel("linux agent restart fixed demo service")).toBeTruthy();
expect(() => parseRecoveryLabel("run anything")).toThrow();
```

Add an orchestrator test whose workload returns `linux agent restart fixed demo service` and assert the executor step and durable execution evidence use that same value.

- [x] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
npm test -- tests/orchestrator.test.ts tests/convex-runner-client.test.ts tests/convex-state.test.ts
```

Expected: failure because all three current contracts accept only `docker start fixed demo service`.

- [x] **Step 3: Create the shared types and labels**

Create `runner/workload-types.ts` with these exact exported constants and shapes:

```ts
export const LEGACY_DOCKER_RECOVERY_LABEL =
  "docker start fixed demo service" as const;
export const LINUX_AGENT_RECOVERY_LABEL =
  "linux agent restart fixed demo service" as const;
export type RecoveryCommandLabel =
  | typeof LEGACY_DOCKER_RECOVERY_LABEL
  | typeof LINUX_AGENT_RECOVERY_LABEL;

export interface SafeWorkloadState {
  readonly status: string;
  readonly exitCode: number;
  readonly oomKilled: boolean;
  readonly finishedAt: string;
  readonly demoLabel: "autonomous-devops-agent";
}

export interface SafeLogTail {
  readonly lines: readonly string[];
  readonly lineCount: number;
  readonly characterCount: number;
  readonly truncated: boolean;
}

export interface RecoveryActionResult {
  readonly actionId: "restart_demo_service";
  readonly commandLabel: RecoveryCommandLabel;
  readonly exitCode: 0;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
}

export interface HealthEvidence {
  readonly healthy: boolean;
  readonly httpStatus: number | null;
  readonly service: string | null;
  readonly status: string | null;
  readonly requestStartedAt: number;
  readonly checkedAt: number;
  readonly attempts: number;
}
```

Move the equivalent types out of `docker-adapter.ts`, re-export them there temporarily for source compatibility, and update the orchestrator/restorer to import the transport-neutral names.

- [x] **Step 4: Accept old and new labels without accepting arbitrary strings**

Use an exact two-value Zod union in `runner/convex-client.ts`. In `convex/runner.ts`, replace the single constant check with an exact set, persist the submitted allowed label, and require that the stored label remains a member of the same set before resolution.

Do not change the database field to accept arbitrary execution semantics; the existing field can remain a string because the mutation boundary enforces the exact two-label set.

- [x] **Step 5: Run focused and full tests**

Run:

```bash
npm test -- tests/orchestrator.test.ts tests/convex-runner-client.test.ts tests/convex-state.test.ts
npm test
```

Expected: all tests pass and legacy-label cases remain present.

- [x] **Step 6: Commit the compatibility boundary**

```bash
git add runner/workload-types.ts runner/docker-adapter.ts runner/orchestrator.ts runner/environment-restorer.ts runner/convex-client.ts convex/runner.ts tests/orchestrator.test.ts tests/convex-runner-client.test.ts tests/convex-state.test.ts
git commit -m "refactor: support truthful linux agent evidence"
```

---

### Task 2: Build the fixed Linux sandbox agent and child workload

**Files:**
- Create: `linux-sandbox/agent.ts`
- Create: `linux-sandbox/workload.mjs`
- Create: `linux-sandbox/Dockerfile`
- Create: `linux-sandbox/.dockerignore`
- Test: `tests/linux-sandbox-agent.test.ts`

**Interfaces:**
- Consumes: the fixed service/action/workload IDs from the global constraints.
- Produces: the six authenticated HTTP endpoints on container port `3000` and manages only the exact child process `/usr/local/bin/node /app/workload.mjs`.

- [x] **Step 1: Write failing request-boundary tests**

Test the exported `createAgentRequestHandler` with a fake workload manager. Cover: missing/wrong bearer token returns the same `401`; unknown route `404`; body over 2,048 bytes `413`; unknown fields `400`; unknown action/workload `400`; duplicate execution ID `409`; logs are capped at 30 lines and 4,000 characters; and valid stop/restart/health calls invoke only the corresponding fixed manager method.

The valid action request is exactly:

```ts
{
  actionId: "restart_demo_service",
  workloadId: "demo-service",
  executionId: "execution_test_1",
}
```

- [x] **Step 2: Run the agent test and confirm it fails**

Run:

```bash
npm test -- tests/linux-sandbox-agent.test.ts
```

Expected: failure because `linux-sandbox/agent.ts` does not exist.

- [x] **Step 3: Implement the fixed child workload**

Create `workload.mjs` as a Node HTTP service bound only to `127.0.0.1:3001`. It responds to `GET /health` with status 200 and exactly:

```json
{"status":"healthy","service":"gx-autodevops-demo-service"}
```

It logs startup, health, and graceful shutdown events; no request can execute code or change service state.

- [x] **Step 4: Implement the managed-workload boundary**

In `agent.ts`, create a manager that:

- spawns only `process.execPath` with `[/app/workload.mjs]`, `shell: false`, `cwd: /app`, and a fixed minimal child environment;
- keeps the most recent 30 sanitized stdout/stderr lines in memory;
- reports only `status`, `exitCode`, `oomKilled: false`, `finishedAt`, and `demoLabel`;
- stops only the stored child PID, waits two seconds, then sends `SIGKILL` only to that same child if needed;
- restarts only when the child is exited;
- rejects a repeated execution ID before a second restart;
- performs health checks only against `http://127.0.0.1:3001/health`.

- [x] **Step 5: Implement the authenticated HTTP wrapper**

Require `SANDBOX_AGENT_TOKEN` at startup. Compare bearer tokens with `timingSafeEqual` after checking equal byte length. Read at most 2,048 request bytes. Return JSON with `cache-control: no-store`; never echo a token, authorization header, environment, file path, or stack trace.

Use these exact POST bodies:

```json
{"kind":"STOP_DEMO_SERVICE_V1"}
```

```json
{"kind":"ENSURE_DEMO_SERVICE_V1"}
```

Use the exact action request shown in Step 1 for execution.

- [x] **Step 6: Add the hardened pinned image**

Create `linux-sandbox/Dockerfile` from the already pinned Node 24.20.0 Alpine digest used by the demo service. Copy only `agent.ts` and `workload.mjs`, use `USER node`, expose only port 3000, and run:

```dockerfile
CMD ["node", "agent.ts"]
```

Create `linux-sandbox/.dockerignore` so Docker uses it for the `linux-sandbox` build context. Exclude local environment files, logs, coverage, and test artifacts; the context contains only the three required sandbox source files.

- [x] **Step 7: Run the agent tests and static checks**

Run:

```bash
npm test -- tests/linux-sandbox-agent.test.ts
npm run typecheck
npm run lint
```

Expected: tests/typecheck pass; lint has no new warnings outside generated Convex files.

- [x] **Step 8: Commit the sandbox agent**

```bash
git add linux-sandbox tests/linux-sandbox-agent.test.ts
git commit -m "feat: add isolated linux workload agent"
```

---

### Task 3: Add the authenticated Linux sandbox adapter

**Files:**
- Create: `runner/sandbox-token.ts`
- Create: `runner/linux-sandbox-adapter.ts`
- Test: `tests/linux-sandbox-adapter.test.ts`

**Interfaces:**
- Consumes: base origin `http://127.0.0.1:3410`, a derived sandbox token, and the six fixed agent endpoints.
- Produces: all methods of `DemoWorkloadPort` plus `ensureDemoService()` for environment restoration.

- [x] **Step 1: Write failing adapter tests**

With a fake `fetch`, verify that every request uses the fixed origin, `redirect: "error"`, `cache: "no-store"`, JSON accept/content headers, a bearer token, and a bounded timeout. Verify strict response schemas reject extra keys, wrong service identity, wrong demo label, negative times, excessive logs, an unknown command label, or a nonzero successful exit code.

Also verify:

- unknown input to `executeRecoveryAction` fails before fetch;
- duplicate IDs are rejected locally before the second POST;
- `verifyFreshHealth(notBefore)` rejects stale success and retries fresh evidence;
- an abort signal stops verification;
- public output is sanitized again on the Mac even though the agent already bounds it.

- [x] **Step 2: Run the adapter test and confirm it fails**

Run:

```bash
npm test -- tests/linux-sandbox-adapter.test.ts
```

Expected: failure because the adapter and token helper do not exist.

- [x] **Step 3: Implement isolated token derivation**

Export:

```ts
export function deriveSandboxAgentToken(runnerToken: string): string
```

Validate that `runnerToken` is nonempty, then return:

```ts
createHmac("sha256", runnerToken)
  .update("gx-linux-sandbox-agent-v1")
  .digest("base64url")
```

Never log either value.

- [x] **Step 4: Implement the adapter**

Use strict Zod schemas for every response. Map methods exactly:

```text
inspectSafeState       -> GET  /v1/workload/state
readSafeLogTail        -> GET  /v1/workload/logs
checkHealthOnce        -> GET  /v1/workload/health
stopDemoService        -> POST /v1/demo/stop
ensureDemoService      -> POST /v1/demo/ensure
executeRecoveryAction  -> POST /v1/actions/execute
```

Return `commandLabel: "linux agent restart fixed demo service"`. Keep the same 2-second request timeout, 10-second verification window, 250 ms retry interval, and fresh-request timestamp rule used by the current Docker adapter.

- [x] **Step 5: Run focused and full tests**

Run:

```bash
npm test -- tests/linux-sandbox-adapter.test.ts tests/orchestrator.test.ts tests/environment-restorer.test.ts
npm test
```

Expected: all tests pass.

- [x] **Step 6: Commit the adapter**

```bash
git add runner/sandbox-token.ts runner/linux-sandbox-adapter.ts tests/linux-sandbox-adapter.test.ts
git commit -m "feat: connect coordinator to linux sandbox"
```

---

### Task 4: Add hardened container lifecycle and an offline proof

**Files:**
- Modify: `runner/command-executor.ts`
- Create: `runner/sandbox-container.ts`
- Create: `scripts/linux-sandbox-start.ts`
- Create: `scripts/linux-sandbox-proof.ts`
- Modify: `package.json`
- Test: `tests/command-executor.test.ts`
- Test: `tests/sandbox-container.test.ts`

**Interfaces:**
- Consumes: derived `SANDBOX_AGENT_TOKEN` as a child-process environment value, fixed image/name/label/port, Docker CLI.
- Produces: `sandbox:build`, `sandbox:start`, and `sandbox:proof` commands; no production/Convex mutation.

- [x] **Step 1: Write failing lifecycle tests**

Assert that the exact `docker container run` arguments contain:

```text
--publish 127.0.0.1:3410:3000/tcp
--user node
--read-only
--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m
--cap-drop ALL
--security-opt no-new-privileges:true
--pids-limit 64
--memory 256m
--cpus 1
--restart=no
--env SANDBOX_AGENT_TOKEN
```

Assert they never contain `/var/run/docker.sock`, `--privileged`, `--network=host`, `--pid=host`, `--volume`, `--mount`, the raw runner token, or the derived token. Assert the secret exists only in the `execFile` child environment.

- [x] **Step 2: Run the lifecycle tests and confirm they fail**

Run:

```bash
npm test -- tests/command-executor.test.ts tests/sandbox-container.test.ts
```

Expected: failure because environment overrides and the sandbox manager do not exist.

- [x] **Step 3: Add secret environment support to the Docker executor**

Extend `run` with an optional environment override used only by the child process. Merge it with `process.env` in `execFile` options, never store it on `DockerCommandResult` or `DockerCommandError`, and keep the executable fixed to `docker` with `shell: false`.

- [x] **Step 4: Implement the fixed container manager**

Validate the existing container with one bounded `docker inspect --format` payload containing only container ID, exact sandbox label, image, running state, privilege state, user, read-only flag, host binds, port bindings, security options, cap additions/drops, PID mode, and network mode. Refuse to start or reuse a container whose identity or hardening differs.

If missing, create only the exact fixed container with the arguments in Step 1. If safely present but stopped, start only its validated immutable container ID. Never recreate or remove a mismatched container automatically.

- [x] **Step 5: Implement start and proof scripts**

`linux-sandbox-start.ts` loads the ignored runner environment, derives the agent token, ensures the fixed container, waits for the authenticated agent, ensures the child service, and verifies exact fresh health.

`linux-sandbox-proof.ts` runs locally without Convex: ensure healthy → reject an unknown action before the agent → stop service → confirm failed health → read bounded state/logs → execute the fixed restart → reject the duplicate ID → verify fresh health. It prints only non-sensitive booleans, counts, labels, and durations.

- [x] **Step 6: Add package commands**

Add:

```json
"sandbox:build": "docker buildx build --pull --load --tag gx-autodevops-linux-sandbox:m2 --file linux-sandbox/Dockerfile linux-sandbox",
"sandbox:start": "tsx scripts/linux-sandbox-start.ts",
"sandbox:proof": "tsx scripts/linux-sandbox-proof.ts"
```

- [x] **Step 7: Run tests, build the image, start it, and run the offline proof**

Run:

```bash
npm test -- tests/command-executor.test.ts tests/sandbox-container.test.ts
npm run sandbox:build
npm run sandbox:start
npm run sandbox:proof
```

Expected: the image builds, the container becomes healthy, unknown/duplicate actions are rejected, and the fixed service returns to healthy without any Convex or public-demo call.

- [x] **Step 8: Inspect the actual container safety boundary**

Run one bounded `docker inspect` format and verify: `Privileged=false`, `ReadonlyRootfs=true`, no binds, no mounts except Docker-managed `/tmp`, no added capabilities, `ALL` dropped, no host PID/network, user `node`, and only host-loopback port 3410 published. Do not print environment values.

- [x] **Step 9: Commit lifecycle support**

```bash
git add runner/command-executor.ts runner/sandbox-container.ts scripts/linux-sandbox-start.ts scripts/linux-sandbox-proof.ts package.json package-lock.json tests/command-executor.test.ts tests/sandbox-container.test.ts
git commit -m "feat: harden linux sandbox lifecycle"
```

---

### Task 5: Switch the trusted coordinator and trace to the Linux sandbox

**Files:**
- Modify: `runner/index.ts`
- Modify: `runner/orchestrator.ts`
- Modify: `scripts/demo-service-preflight.ts`
- Modify: `scripts/m0-runner-proof.ts`
- Modify: `package.json`
- Test: `tests/runner-loop.test.ts`
- Test: `tests/orchestrator.test.ts`
- Test: `tests/public-view.test.tsx`

**Interfaces:**
- Consumes: `RUNNER_TOKEN`, derives the separate agent token, and constructs `LinuxSandboxAdapter` at fixed loopback origin.
- Produces: the existing `npm run runner`, `npm run demo:start`, `npm run demo:proof`, and `npm run demo:preflight` workflow backed by the Linux sandbox.

- [x] **Step 1: Write failing startup and truthful-label tests**

Assert that coordinator startup constructs the Linux adapter from the derived token and never passes the Convex runner token to it. Update trace expectations to these exact operation labels:

```text
linux agent stop fixed demo service
linux agent inspect fixed demo service
linux agent read fixed demo service logs
linux agent restart fixed demo service
linux agent check fixed demo service health
```

Keep tests proving public raw evidence is collapsed and token/cost/auth metadata is absent.

- [x] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
npm test -- tests/runner-loop.test.ts tests/orchestrator.test.ts tests/public-view.test.tsx
```

Expected: startup still uses `DockerAdapter` and trace labels still mention Docker.

- [x] **Step 3: Switch the coordinator boundary**

In `startLocalRunner`, keep `createCodexInvestigator()` on macOS and replace only the workload with:

```ts
new LinuxSandboxAdapter({
  token: deriveSandboxAgentToken(runnerToken),
})
```

Update preflight and proof scripts to use the same adapter. Point the existing `demo:start` and `demo:proof` aliases to the sandbox scripts while retaining the old files as a rollback path through the end of Build Week.

- [x] **Step 4: Make every new public operation label truthful**

Use the exact Linux-agent labels in Step 1 for stop, state, logs, restart, and health. Preserve old stored strings on historical incidents; do not rewrite database history.

- [x] **Step 5: Run the complete local verification suite**

Run:

```bash
npm test
npm run typecheck
npm run lint
npm run eval
npm run build
npm run demo:preflight
git diff --check
```

Expected: all tests/typecheck/build/eval pass, lint has no errors, preflight reports the Linux sandbox and healthy child service, and no whitespace errors exist.

- [x] **Step 6: Commit the coordinator cutover code**

```bash
git add runner/index.ts runner/orchestrator.ts scripts/demo-service-preflight.ts scripts/m0-runner-proof.ts package.json package-lock.json tests/runner-loop.test.ts tests/orchestrator.test.ts tests/public-view.test.tsx
git commit -m "feat: run recovery through linux sandbox agent"
```

---

### Task 6: Review, deploy compatibility first, then cut over the live runner

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `/Users/sanidhya/Downloads/GrowthX/IDEA_SCOPE.md`

**Interfaces:**
- Produces: a backward-compatible Convex deployment, one live Linux-sandbox recovery, watchdog evidence, and honest L3 documentation.

- [x] **Step 1: Run two independent read-only reviews**

Review A checks exact spec coverage and code correctness. Review B checks the security boundary: no auth leakage, no Docker socket/host mounts/elevated container, exact operations only, strict schemas, duplicate handling, and old/new label compatibility. Fix blockers and rerun affected tests before deployment.

- [x] **Step 2: Push the compatibility code before stopping the old runner**

Push the commits so GitHub-triggered Vercel deploys the Convex two-label compatibility change. Wait for the deployment to become Ready and confirm the existing public URL still renders and the old runner heartbeat remains online.

- [x] **Step 3: Perform the single-runner cutover**

Resolve and validate the exact old runner process, stop only that process gracefully, start the Linux sandbox, then start exactly one new Mac coordinator using the sandbox adapter. Confirm one fresh heartbeat before accepting a run. Never run both coordinators with `gx-local-runner` simultaneously.

- [x] **Step 4: Verify one fresh public nine-step recovery**

At 1440 width: press **Run recovery demo**, confirm the Linux child service really stops, nine new steps appear, the new Linux-agent operation labels are visible, final health is exact HTTP 200, status becomes healthy, and the incident persists after reload.

- [x] **Step 5: Verify phone behavior and public redaction**

At 390 width: run a fresh recovery, confirm result above timeline, no horizontal overflow, raw evidence collapsed, no token/cost/auth metadata, and zero browser errors.

- [x] **Step 6: Verify runner-loss behavior**

During a fresh run after step 4, stop only the validated coordinator process. Confirm Convex writes a terminal failed incident within 15 seconds, reload preserves it, the page explains the runner loss, and the button stays blocked until the coordinator returns and the sandbox child service is freshly restored. Restart one coordinator and complete a new nine-step healthy run.

- [x] **Step 7: Update documentation with measured facts only**

README must explain: Linux sandbox container, Mac coordinator, exact fixed action, no host access, start/preflight commands, controlled/staged L3 cap, and rollback boundary. CHANGELOG gets one line stating what a visitor can now do. IDEA_SCOPE records exact test counts, measured times, commit/deployment IDs, and remaining limits; it must not call the container an external server or L4 evidence.

- [x] **Step 8: Run final verification and commit docs**

Run:

```bash
npm test
npm run typecheck
npm run lint
npm run eval
npm run build
npm run demo:preflight
git diff --check
git status --short
```

Then commit only verified documentation:

```bash
git add README.md CHANGELOG.md
git commit -m "docs: record linux sandbox verification"
```

Record the separate root `IDEA_SCOPE.md` update without pretending it belongs to the application repository.

---

## Self-Review

- **Spec coverage:** Tasks 1–6 cover the Linux container, fixed child service, authenticated operations, no host authority, token separation, backward-compatible evidence, truthful trace, local proof, public recovery, watchdog failure, reload, phone, and honest L3 classification.
- **Deliberate exclusions:** no user login, external Linux VM, systemd, cloud provisioning, Docker socket, arbitrary command, general onboarding, second workload/failure, or L4 claim.
- **Type consistency:** `RecoveryCommandLabel`, `SafeWorkloadState`, `SafeLogTail`, `RecoveryActionResult`, and `HealthEvidence` are defined once in Task 1 and consumed by both adapters and the orchestrator.
- **Rollback:** the old container/adapter files remain until after Build Week; production cutover occurs only after the compatibility deployment and full local suite pass.
