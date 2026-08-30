# Server Run Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every accepted demo run reaches a persisted terminal result even if the local runner dies or the Mac sleeps, and the disposable service is restored automatically when the runner returns.

**Architecture:** A Convex cron runs every two seconds, independently of the laptop. It closes active runs after two missed two-second heartbeats, a 20-second step deadline, or a 45-second whole-run deadline; stores the last completed step and plain failure reason; and queues a bounded environment-restoration request. The authenticated runner claims that request, starts only the fixed labelled Docker service, verifies exact health, and reports restoration before the next run is enabled.

**Tech Stack:** Next.js 16, React 19, Convex, TypeScript, Vitest, Docker, Playwright, Vercel.

**Spec:** Shaktimaan runner-loss prompt supplied by Sanidhya on Mon 31 Aug 2026; product control plane at `/Users/sanidhya/Downloads/GrowthX/IDEA_SCOPE.md`.

## Global Constraints

- Runner heartbeat interval is exactly `2_000ms`; two consecutive misses mean lost at `4_000ms`.
- Per-step deadline is `20_000ms`; whole-run deadline is `45_000ms`.
- Terminal failure is persisted by Convex, never inferred only by the browser.
- The persisted plain runner-loss reason for the observed case is `runner lost after step 4: read service logs`.
- The runner may restore only the fixed, labelled disposable Docker service; no arbitrary shell input is added.
- A failed incident remains failed even after the demo environment is restored; restoration is recorded separately.
- A new run is denied until the runner is online and environment restoration is verified.
- Keep the existing one-second public updates and all successful-path wording/layout safeguards.

---

### Task 1: Persisted server watchdog

**Files:**
- Modify: `convex/lib/guards.ts`
- Modify: `convex/schema.ts`
- Modify: `convex/runner.ts`
- Create: `convex/crons.ts`
- Test: `tests/convex-state.test.ts`

**Interfaces:**
- Produces constants `RUNNER_HEARTBEAT_INTERVAL_MS`, `RUNNER_LOST_AFTER_MS`, `STEP_DEADLINE_MS`, and `RUN_DEADLINE_MS`.
- Produces internal mutation `runner.watchActiveRun` and a two-second Convex cron.
- Persists incident fields `status`, `lastCompletedStepSequence`, `lastCompletedStepLabel`, `environmentRecoveryStatus`, `environmentRecoveryStartedAt`, and `environmentRecoveredAt`.

- [ ] **Step 1: Write failing watchdog tests**

```ts
expect(failedIncident).toMatchObject({
  status: "failed",
  terminalReason: "runner lost after step 4: read service logs",
  lastCompletedStepSequence: 4,
  lastCompletedStepLabel: "read service logs",
  environmentRecoveryStatus: "pending",
  finishedAt: now,
});
expect(failedCommand.status).toBe("failed");
expect(control).not.toHaveProperty("activeDemoCommandId");
```

- [ ] **Step 2: Run the focused tests and confirm they fail before implementation**

Run: `npm test -- tests/convex-state.test.ts -t "watchdog"`

Expected: FAIL because the server watchdog and persisted failure fields do not exist.

- [ ] **Step 3: Implement one idempotent terminalization helper and the watchdog**

```ts
export const watchActiveRun = internalMutation({
  args: {},
  handler: async (ctx) => closeOverdueActiveRun(ctx, Date.now()),
});
```

The helper must choose runner loss before step/run deadlines, derive the last completed step from stored rows, insert one failed watchdog step, fail any recovery command, clear active locks, expire the cooldown, and queue environment restoration only if the disposable service may have been stopped.

- [ ] **Step 4: Register the independent cloud cron**

```ts
crons.interval(
  "active demo run watchdog",
  { seconds: 2 },
  internal.runner.watchActiveRun,
);
```

- [ ] **Step 5: Run focused tests until the runner-loss, step-deadline, run-deadline, idempotency, and pre-incident lock cases pass**

Run: `npm test -- tests/convex-state.test.ts -t "watchdog"`

### Task 2: Authenticated automatic environment restoration

**Files:**
- Modify: `convex/runner.ts`
- Modify: `runner/convex-client.ts`
- Create: `runner/environment-restorer.ts`
- Modify: `runner/index.ts`
- Test: `tests/convex-runner-client.test.ts`
- Test: `tests/environment-restorer.test.ts`
- Test: `tests/runner-loop.test.ts`

**Interfaces:**
- `heartbeat()` returns the timestamp plus an optional fixed restoration request.
- Runner client exposes `claimEnvironmentRecovery`, `completeEnvironmentRecovery`, and `failEnvironmentRecovery`.
- `restoreDemoEnvironment(request)` starts only the validated labelled container, performs a fresh exact health check, then persists `restored`.

- [ ] **Step 1: Write failing restoration and heartbeat tests**

```ts
expect(fakeWorkload.ensureDemoService).toHaveBeenCalledOnce();
expect(fakeWorkload.verifyFreshHealth).toHaveBeenCalledOnce();
expect(fakeClient.completeEnvironmentRecovery).toHaveBeenCalledWith(
  expect.objectContaining({ incidentId: "incident_1" }),
);
```

- [ ] **Step 2: Run focused tests and confirm the missing interfaces fail**

Run: `npm test -- tests/convex-runner-client.test.ts tests/environment-restorer.test.ts tests/runner-loop.test.ts`

- [ ] **Step 3: Implement fixed restoration mutations and client methods**

The server accepts only the fixed runner identity and exact verified health fields: service `gx-autodevops-demo-service`, status `healthy`, and HTTP `200`. Failed restoration stays queued for a bounded retry and does not enable a new run.

- [ ] **Step 4: Change the default heartbeat to two seconds and connect restoration to heartbeat responses**

```ts
const DEFAULT_HEARTBEAT_INTERVAL_MS = 2_000;
```

On a restoration request, abort unfinished orchestration, wait for it to unwind, restore the fixed service once, and report the verified result. On startup, process pending restoration before requiring an idle healthy workload.

- [ ] **Step 5: Run focused tests until kill/reconnect, duplicate cleanup, failed verification, and clean-start cases pass**

Run: `npm test -- tests/convex-runner-client.test.ts tests/environment-restorer.test.ts tests/runner-loop.test.ts`

### Task 3: Public failure result and safe button state

**Files:**
- Modify: `convex/demo.ts`
- Modify: `src/components/demo-dashboard.tsx`
- Modify: `src/components/resolution-card.tsx`
- Modify: `src/components/incident-timeline.tsx`
- Test: `tests/public-view.test.tsx`

**Interfaces:**
- `getPublicState` returns the persisted failure status, last completed step, and environment-restoration state for the exact accepted run.
- The resolution card renders the failed terminal result in the same outcome-first position used by success.

- [ ] **Step 1: Write failing visitor tests**

```tsx
expect(screen.getByText("Step 4 · Read service logs")).toBeInTheDocument();
expect(
  screen.getByText("Runner lost after step 4: read service logs"),
).toBeInTheDocument();
expect(screen.getByText("Demo environment restored and healthy")).toBeInTheDocument();
```

- [ ] **Step 2: Run the focused UI tests and confirm they fail**

Run: `npm test -- tests/public-view.test.tsx`

- [ ] **Step 3: Render terminal failure and restoration truthfully**

Show `Restoration pending until the runner reconnects` before cleanup and `Demo environment restored and healthy` only after exact verified cleanup. Keep the failed incident outcome unchanged after restoration.

- [ ] **Step 4: Keep one-second updates and make the run-button rule complete**

Disable for active run, offline runner, or pending restoration. Enable when the terminal incident is persisted, the runner heartbeat is fresh, restoration is verified, and no cooldown remains. Expire the failed-run cooldown server-side so a clean retry can start immediately.

- [ ] **Step 5: Re-run public UI tests**

Run: `npm test -- tests/public-view.test.tsx`

### Task 4: Full verification, destructive proof, and release

**Files:**
- Modify: `CHANGELOG.md`
- Modify after public proof: `/Users/sanidhya/Downloads/GrowthX/IDEA_SCOPE.md`

**Interfaces:**
- Produces one persisted runner-loss incident, one restored environment record, and one fresh nine-step success run.

- [ ] **Step 1: Run all local quality gates**

Run: `npm test && npm run typecheck && npm run lint && npm run build && git diff --check`

- [ ] **Step 2: Kill the runner after step 4 at 1440px**

Open the public/local production-connected UI, start a run, wait for `Read the latest 30 log lines`, terminate only the runner process, and measure from the last heartbeat. Require a persisted failed outcome within 15 seconds, exact last-step/reason copy, and a released active lock.

- [ ] **Step 3: Reload and verify persistence**

Reload while failed. Require the same incident ID, finish timestamp, reason, last completed step, and failed result.

- [ ] **Step 4: Restart the runner and verify automatic restoration**

Require the runner to claim the fixed cleanup, start the labelled disposable service, verify HTTP 200 with the exact service identity, persist `restored`, and enable the run button.

- [ ] **Step 5: Repeat the runner-loss proof at 390px**

Require failure within 15 seconds, 390px document width, resolution record above timeline, raw evidence collapsed, and zero browser errors/warnings.

- [ ] **Step 6: Restart and run the successful path**

Require a fresh nine-step FAILED → HEALTHY run and confirm headline, button label, allowlisted/policy-checked wording, outcome-first phone order, collapsed evidence, and absence of token/cost/auth metadata.

- [ ] **Step 7: Commit, push, wait for production Vercel/Convex deployment, and repeat the same public checks**

The production alias remains `https://autonomous-devops-agent.vercel.app`. Record the commit, Vercel deployment ID, failure timing at both widths, restoration proof, reload proof, and successful retry in `IDEA_SCOPE.md` only after the public run passes.
