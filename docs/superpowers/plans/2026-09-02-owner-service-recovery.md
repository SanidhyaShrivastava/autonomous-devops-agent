# Owner-Bound Fixed Service Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Let one signed-in owner register one bundled disposable Linux service on the already-paired runner, observe one fixed health check, approve one fixed restart, and see fresh verified health.

**Architecture:** Keep the existing logged-out staged demo completely separate. Extend the owner-bound runner heartbeat so it can report only one fixed workload health shape, atomically claim only one previously approved fixed action, and report the execution plus a fresh verification result. The Linux host agent maps the literal action ID to a bundled child process with `shell: false`, stores a bounded execution journal locally, and never accepts a command, path, URL, log source, or parameter from the cloud.

**Tech Stack:** Next.js 16.3.3 App Router, React 19, Convex, TypeScript, Zod, Node.js child processes without a shell, Vitest, Testing Library, Docker.

**Spec:** `../IDEA_SCOPE.md`

## Global Constraints

- Preserve the existing anonymous recovery demo at `/`; do not move owner-bound work into `convex/runner.ts` or `runner/*`.
- Register exactly one fixed workload per active owner-bound runner.
- Use the fixed IDs `connected-demo-service`, `check-connected-demo-service-health`, and `restart-connected-demo-service` everywhere.
- Use only the fixed local health URL `http://127.0.0.1:3001/health`; it is never accepted from a browser or cloud request.
- Registration is unavailable until a fresh heartbeat advertises the exact capability `fixed_disposable_service_v1`.
- The connected-runner recovery policy is always `approval_required` in this slice.
- A browser approval queues an action; it does not itself prove execution or recovery.
- The local runner executes only `restart-connected-demo-service`, using `spawn(process.execPath, [fixedModulePath], { shell: false })`.
- The runner receives no shell string, path, URL, hostname, environment dump, log source, or free-form action parameter from Vercel or Convex.
- A command may execute at most once; a bounded mode-`0600` local journal stores the claim before execution, stores the result afterward, and survives host-agent restarts.
- Only a post-action exact HTTP 200 response with the expected service identity and a new service instance ID can mark recovery succeeded.
- The same stopped-service failure is seeded only by a local loopback command inside the disposable container after one healthy instance has been recorded; it is never a cloud recovery action.
- Pending approval, approved work, and claimed work have deadlines and must reach a stored terminal state.
- A claimed action whose result is lost becomes `execution_unknown`; neither server nor runner may replay it automatically.
- The approval page must deny framing so another site cannot place an invisible approval button over unrelated content.
- This remains Sanidhya's controlled Docker surface and honest AI Agent real-output L3 evidence; do not call it a genuine user production surface.
- Do not add systemd, service discovery, logs, AI diagnosis, automatic execution, another workload, or another failure type.

---

## File map

- `src/lib/connected-runner-protocol.ts`: exact fixed IDs plus strict heartbeat, command, and result schemas shared by the Next route and Linux host agent.
- `convex/schema.ts`: owner-bound fixed workload and durable recovery-command tables.
- `convex/runners.ts`: owner registration/request/decision functions, health persistence, atomic claim/result processing, and terminal deadline handling.
- `convex/crons.ts`: run the connected-command watchdog every two seconds.
- `src/lib/server/runner-enrollment.ts`: carry the bounded heartbeat request and response between the route and Convex.
- `src/app/api/runners/heartbeat/route.ts`: authenticated strict transport for health, command claim, and command result.
- `host-agent/version.ts`: runtime host-agent version `0.2.0`.
- `host-agent/connected-service.mjs`: bundled throwaway HTTP service with one exact health response.
- `host-agent/fixed-service.ts`: fixed health check, fixed restart, fresh verification, and durable bounded execution journal.
- `host-agent/seed-failure.ts`: local-only request to the bundled service's fixed loopback shutdown endpoint for repeatable test setup.
- `host-agent/connect.ts`: heartbeat loop, exact response validation, local policy check, one execution, and result delivery.
- `package.json`: expose only `host:seed-failure` for the same stopped-service test case.
- `src/components/server-onboarding.tsx`: one-service registration, health, prepare, approve/reject, execution, and verification states.
- `src/app/globals.css`: existing-console styles for the authority rail and recovery record at desktop and phone widths.
- `next.config.ts`: deny framing for the authenticated approval surface.
- `tests/convex-runners.test.ts`, `tests/runner-enrollment-route.test.ts`, `tests/host-agent.test.ts`, `tests/server-onboarding.test.tsx`, `tests/public-view.test.tsx`: state, transport, host, UI, and public-demo regression coverage.
- `README.md`, `CHANGELOG.md`, `../IDEA_SCOPE.md`: truthful boundary and verified evidence after the live proof.

### Task 1: Exact protocol and owner-bound durable state

**Files:**
- Create: `src/lib/connected-runner-protocol.ts`
- Modify: `convex/schema.ts`
- Modify: `convex/runners.ts`
- Modify: `convex/crons.ts`
- Test: `tests/convex-runners.test.ts`

**Interfaces:**
- Produces: `CONNECTED_WORKLOAD_ID`, `CONNECTED_HEALTH_CHECK_ID`, `CONNECTED_RECOVERY_ACTION_ID`, `CONNECTED_SERVICE_HEALTH_URL`, and `HOST_AGENT_VERSION` constants.
- Produces: `api.runners.registerFixedWorkload({})`.
- Produces: `api.runners.requestFixedRecovery({})`.
- Produces: `api.runners.decideFixedRecovery({ commandId, decision })` where `decision` is `approved | rejected`.
- Extends: `api.runners.listMine()` with one safe workload DTO and one latest recovery DTO.
- Extends: `api.runners.recordHeartbeat(...)` to accept the fixed capability, fixed health report and optional prior-command result, then atomically return zero or one approved command.
- Produces: `internal.runners.watchFixedRecoveryCommands({})` for stored expiry/failure transitions.

- [x] **Step 1: Write failing Convex state tests**

Add tests with these exact expectations:

```ts
await owner.client.mutation(registerFixedWorkload, {});
expect(await owner.client.query(listMine, {})).toMatchObject({
  workload: {
    workloadId: "connected-demo-service",
    healthCheckId: "check-connected-demo-service-health",
    recoveryActionId: "restart-connected-demo-service",
    recoveryMode: "approval_required",
    healthStatus: "unknown",
  },
});
```

Cover: authenticated owner only; one workload; no workload before an active runner with a fresh `fixed_disposable_service_v1` capability; another owner cannot view/decide it; health updates require the matching runner credential and exact fixed IDs; runner-supplied timestamps are not accepted; recovery cannot be requested until one healthy instance was recorded and a later fresh unhealthy report exists; no command is claimable before approval; rejection is terminal; approval is rechecked against fresh runner and health state; only one concurrent request wins; an approved command is claimed once; a successful process result with unhealthy verification is `failed`, not `succeeded`; success requires a new post-action instance ID; duplicate results are idempotent; revoked runners cannot claim; pending/approved/claimed deadlines persist terminal states; terminal states never reopen.

- [x] **Step 2: Run the focused state tests and confirm failure**

Run: `npm test -- tests/convex-runners.test.ts`

Expected: FAIL because the workload tables and functions do not exist.

- [x] **Step 3: Add two bounded tables**

Add `managedWorkloads` with owner, runner record, runner ID, the three fixed IDs, `approval_required`, timestamps, only `unknown | healthy | unhealthy`, fixed detail codes, and the latest service instance ID. Add `runnerRecoveryRequests` with owner/workload/runner IDs, the fixed action ID, `pending_approval | approved | claimed | succeeded | failed | rejected | expired | not_needed | execution_unknown`, timestamps, execution nonce, lease, pre-action instance ID, and fixed execution/verification result codes. Add indexes by runner, workload creation time, and deadline.

- [x] **Step 4: Implement owner mutations and safe DTOs**

`registerFixedWorkload` finds the caller's one active runner and requires the exact capability heartbeat newer than 6 seconds before inserting only fixed values. `requestFixedRecovery` requires a heartbeat newer than 6 seconds, a healthy instance previously recorded by the server, and a later unhealthy report received within 8 seconds. `decideFixedRecovery` binds the decision to the authenticated owner and rechecks those facts before setting `approved`; rejection stores `rejected` without execution. `listMine` returns no digests, credential, local URL, file path, or execution journal.

- [x] **Step 5: Implement atomic machine state transitions**

Process an optional previous result first, update the fixed capability and health record second, then claim at most one approved action. A claim stores a fresh execution nonce, the pre-action instance ID, and a 15-second lease before returning the literal action. If the current health report is already healthy, store `not_needed` rather than restarting. A matching duplicate result returns the existing terminal result without changing it; a late result never reopens a terminal record.

- [x] **Step 6: Add the two-second watchdog**

Expire `pending_approval` and unclaimed `approved` requests at their deadline. Mark a missed claimed lease `execution_unknown`; a claimed action may have run and must never be retried automatically. Process a bounded batch through the deadline index and store `finishedAt` for every terminal transition.

- [x] **Step 7: Run focused tests**

Run: `npm test -- tests/convex-runners.test.ts`

Expected: PASS with zero failed tests.

- [x] **Step 8: Commit durable state**

```bash
git add src/lib/connected-runner-protocol.ts convex/schema.ts convex/runners.ts convex/crons.ts tests/convex-runners.test.ts
git commit -m "feat: add owner service recovery state"
```

### Task 2: Strict heartbeat command transport

**Files:**
- Modify: `src/lib/server/runner-enrollment.ts`
- Modify: `src/app/api/runners/heartbeat/route.ts`
- Test: `tests/runner-enrollment-route.test.ts`

**Interfaces:**
- Consumes: the fixed health/result/command contracts from Task 1.
- Produces: a `200` no-store heartbeat response:

```ts
{
  heartbeatIntervalMs: 2000,
  workloadRegistered: boolean,
  command: null | {
    commandId: string,
    executionNonce: string,
    actionId: "restart-connected-demo-service"
  }
}
```

- [x] **Step 1: Write failing strict-route tests**

Cover the legacy body with no capability or health report, the exact capability plus fixed unhealthy/healthy report, instance IDs, an exact command result bound to its execution nonce, unknown fields, a caller-supplied URL/path/command, oversized bodies, malformed command IDs/nonces, missing/wrong bearer credentials, rate limits, generic errors, no-store, and proving the raw credential never reaches Convex.

- [x] **Step 2: Run the focused route tests and confirm failure**

Run: `npm test -- tests/runner-enrollment-route.test.ts`

Expected: FAIL because heartbeat still returns `204` and has no fixed health/result schema.

- [x] **Step 3: Extend the server wrapper**

Pass only credential/client digests, runner/agent IDs, and parsed fixed health/result fields to Convex. Return only the bounded workload flag and optional fixed command.

- [x] **Step 4: Extend the POST route**

Keep Node runtime, bearer parsing, trusted client-address digest, shared Convex rate limits, strict JSON, body cap, generic failures, and `Cache-Control: no-store`. Accept no operational string beyond the fixed literal IDs and fixed enum result codes.

- [x] **Step 5: Run route and database tests**

Run: `npm test -- tests/runner-enrollment-route.test.ts tests/convex-runners.test.ts`

Expected: PASS.

- [x] **Step 6: Commit the transport**

```bash
git add src/lib/server/runner-enrollment.ts src/app/api/runners/heartbeat/route.ts tests/runner-enrollment-route.test.ts
git commit -m "feat: carry fixed runner recovery commands"
```

### Task 3: Fixed local service, health check, and restart

**Files:**
- Create: `host-agent/version.ts`
- Create: `host-agent/connected-service.mjs`
- Create: `host-agent/fixed-service.ts`
- Create: `host-agent/seed-failure.ts`
- Modify: `host-agent/pair.ts`
- Modify: `host-agent/connect.ts`
- Modify: `package.json`
- Test: `tests/host-agent.test.ts`

**Interfaces:**
- Produces: `createFixedServiceController(...)` with `checkHealth()`, `execute(command)`, and `stop()`.
- Produces: a mode-`0600` journal at `~/.autonomous-devops-agent/executions.json`, holding at most 50 claims and their last stored results.
- Extends: `runHeartbeatLoop` to send fixed health, parse one exact command, execute once, verify freshly, and deliver the result on the next authenticated heartbeat.

- [x] **Step 1: Replace the obsolete child-process ban with exact safety tests**

Keep a source-level rejection for `exec(`, `execFile(`, `shell: true`, caller-provided command/path/URL fields, inbound listeners in `connect.ts`, and arbitrary environment forwarding. Assert the only spawn call is equivalent to:

```ts
spawn(process.execPath, [fixedServiceModulePath], {
  shell: false,
  stdio: "ignore",
});
```

- [x] **Step 2: Add failing behavior tests**

Cover exact localhost health URL, request timeout, exact HTTP 200 plus expected service identity and instance ID, connection refusal as unhealthy, unknown/extra action fields rejected, fixed restart success, process success plus failed verification, new instance ID required, claim stored before execution, lost result resent without execution, duplicate command blocked from the durable journal, journal mode `0600`, journal capped at 50 claims, malformed heartbeat response rejection, and no action before the server returns an approved command.

- [x] **Step 3: Run host tests and confirm failure**

Run: `npm test -- tests/host-agent.test.ts`

Expected: FAIL because the fixed service controller does not exist.

- [x] **Step 4: Implement the bundled service and controller**

The service listens only on `127.0.0.1:3001`; it generates a new random instance ID on each start; `/health` returns exact JSON `{ "service": "connected-demo-service", "status": "healthy", "instanceId": "..." }`; a fixed loopback-only shutdown endpoint exists only for `host:seed-failure`; all other routes return 404. The controller starts one initial healthy child, uses a one-second request timeout, starts only the bundled module with a minimal environment that excludes the runner credential, stores the claim before execution, requires a different post-action instance ID, stores the result for retry delivery, and kills only its owned child on graceful agent shutdown.

- [x] **Step 5: Extend the heartbeat loop**

Send runtime version `0.2.0` and capability `fixed_disposable_service_v1` even when the saved pairing file was created by `0.1.0`. Old heartbeat-only agents remain accepted but cannot register a workload. After receiving the literal action and nonce, check the journal, execute once, perform fresh verification, and immediately resend the stored fixed result until the server accepts it. Retry network errors and 5xx with bounded backoff, honor `429 Retry-After`, apply request timeouts, and exit immediately on `401` revocation. Never print credentials or raw response bodies.

- [x] **Step 6: Run host and route tests**

Run: `npm test -- tests/host-agent.test.ts tests/runner-enrollment-route.test.ts`

Expected: PASS.

- [x] **Step 7: Commit the host capability**

```bash
git add host-agent package.json tests/host-agent.test.ts
git commit -m "feat: add fixed Linux service recovery"
```

### Task 4: Approval-first owner interface

**Files:**
- Modify: `src/components/server-onboarding.tsx`
- Modify: `src/app/globals.css`
- Modify: `next.config.ts`
- Test: `tests/server-onboarding.test.tsx`
- Test: `tests/public-view.test.tsx`

**Interfaces:**
- Consumes: `registerFixedWorkload`, `requestFixedRecovery`, `decideFixedRecovery`, and the expanded `listMine` DTO.
- Produces: connected states `unregistered`, `waiting_for_health`, `healthy`, `unhealthy`, `pending_approval`, `approved`, `claimed`, `succeeded`, `failed`, `rejected`, `expired`, `not_needed`, and `execution_unknown`.

- [x] **Step 1: Write failing UI tests**

Assert: registration is unavailable until the fresh exact capability appears; the main action is then `Register disposable service`; no URL/path/command field exists; the registered record shows the exact health check and recovery action; recovery cannot be prepared while healthy/offline/stale; unhealthy shows `Prepare approval-first recovery`; the pending record names the exact action and offers `Approve fixed restart` plus `Reject`; one click cannot submit twice; approved/claimed disable decisions; success names fresh HTTP 200 and the changed instance ID; failed, rejected, expired, not-needed, and execution-unknown states are distinct; revocation remains separate; framing is denied; public `/` tests remain unchanged.

- [x] **Step 2: Run UI tests and confirm failure**

Run: `npm test -- tests/server-onboarding.test.tsx tests/public-view.test.tsx`

Expected: FAIL because the page currently stops at heartbeat-only connectivity.

- [x] **Step 3: Implement the state-driven controls**

Reuse native buttons and existing Convex mutations. Keep the current owner query stopped before sign-out. Render only actions permitted by current owner, capability freshness, runner freshness, health freshness, and request status. Use plain error text and preserve focus on the new state heading after each mutation. Add `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'` through Next.js headers.

- [x] **Step 4: Apply the interface checkpoint**

Intent: a DevOps engineer has just paired a safe test runner and must understand the next grant of authority without reading documentation. Hierarchy: the one permitted next action is the focal element. Palette: existing charcoal/steel surfaces, red only for unhealthy, amber only for approval, green only for fresh verification. Depth: borders-only and quiet surface shifts. Typography: existing Geist/Geist Mono with labels muted and operational values stronger. Spacing: existing 4px base, dense 16px control panels, 48px minimum primary actions.

Extend the connection rail to `Runner → Health check → Approval → Restart → Verified`. On phone, stack it vertically, put current outcome before history, collapse technical identifiers, and keep every action at least 44px tall.

- [x] **Step 5: Run UI tests**

Run: `npm test -- tests/server-onboarding.test.tsx tests/public-view.test.tsx`

Expected: PASS.

- [x] **Step 6: Commit the owner interface**

```bash
git add src/components/server-onboarding.tsx src/app/globals.css next.config.ts tests/server-onboarding.test.tsx tests/public-view.test.tsx
git commit -m "feat: add approval-first service recovery UI"
```

### Task 5: Disposable-container proof, deployment, and truthful evidence

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `../IDEA_SCOPE.md`

**Interfaces:**
- Consumes: Tasks 1–4 and the already-paired `gx-onboarding-test-linux` container.
- Produces: one live owner-bound staged proof from unhealthy to approved restart to fresh healthy, with the existing public demo unchanged.

- [x] **Step 1: Run the complete automated gate**

Run: `npm test && npm run typecheck && npm run lint && npm run build`

Expected: zero failed tests, zero type errors, zero lint errors, and a successful production build.

- [x] **Step 2: Deploy through the existing GitHub/Vercel/Convex pipeline**

Push the verified commits to `main`, wait for the matching Vercel deployment to become Ready, and confirm Convex production contains the new functions and tables. Do not create a second project.

- [x] **Step 3: Update only the disposable Linux container**

Pull the deployed commit inside `gx-onboarding-test-linux`, install only changed dependencies if the lockfile changed, stop the old `host:connect` process, and start exactly one `0.2.0` connection process. Do not mount Mac files, publish ports, or add Docker socket access.

- [x] **Step 4: Prove the owner-bound path live**

Using the test-only account: verify runner online with the fresh exact capability and a recorded healthy instance; register the fixed service; run `npm run host:seed-failure` inside the disposable container; observe `unhealthy`; prepare recovery; verify no command is claimed before approval; approve once; observe approved then claimed; require fresh exact HTTP 200 plus an instance ID different from the pre-failure instance; verify the stored terminal state is `succeeded`; reload and confirm it persists; prove a duplicate command cannot run again.

- [x] **Step 5: Check failure controls**

Run one rejected request and confirm no process starts. Kill the host agent during a claimed test command and confirm the server stores `execution_unknown` within the lease deadline. Restart exactly one host agent and confirm the old claim is never replayed automatically.

- [x] **Step 6: Verify desktop, phone, and the existing public demo**

At 1440px and 390px, verify no overflow, action visibility, focus order, readable approval copy, and zero browser errors. Run the anonymous public recovery demo once and confirm its nine-step `FAILED → HEALTHY` path still works.

- [x] **Step 7: Record truthful evidence**

Update README and `IDEA_SCOPE.md` to say: one owner-bound disposable service, one fixed health check, one approval-gated fixed restart, and fresh verification are live on a controlled Docker test surface; arbitrary servers, systemd, logs, production access, and L4 evidence remain unavailable. Append one CHANGELOG line describing what a signed-in owner can now do.

- [x] **Step 8: Commit the evidence**

```bash
git add README.md CHANGELOG.md ../IDEA_SCOPE.md
git commit -m "docs: record owner service recovery proof"
```

## Self-review

- Spec coverage: exactly one connected service, one health check, one fixed recovery action, approval-first execution, fresh verification, durability, owner isolation, and UI evidence each have an implementation and test task.
- Scope protection: the anonymous demo remains separate; systemd, logs, AI investigation, automatic real-runner execution, service discovery, and a second failure type remain excluded.
- Placeholder scan: every interface, ID, state, deadline, command, URL, and verification expectation used by a later task is defined above.
- Type consistency: the workload, health-check, action, status, and result names are identical across Convex, route, host agent, UI, and tests.
- Safety review: no browser or cloud request supplies an executable string, path, URL, or parameter; the local runner checks the fixed action again and records executions durably.
