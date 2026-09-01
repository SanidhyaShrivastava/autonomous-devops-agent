# Human Approval Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a visitor run the existing fixed Linux-service recovery either autonomously or with a durable human approval pause before the restart.

**Architecture:** The existing autonomous path remains unchanged. A second, fixed start route creates an approval-required command plus a short-lived browser capability stored only in an HttpOnly cookie. After the deterministic policy passes, Convex persists an `awaiting_approval` incident and the runner stops without executing. The initiating browser can approve or reject through bodyless fixed routes; approval lets the authenticated runner resume the existing allowlisted restart and fresh verification, while rejection ends safely and restores the disposable service.

**Tech Stack:** Next.js 16, React 19, Convex, TypeScript, Vitest, Docker, Vercel.

**Spec:** Three user interviews on Tue 1 Sep 2026: safe routine actions may run automatically, while restricted actions should require approval. Product control plane: `/Users/sanidhya/Downloads/GrowthX/IDEA_SCOPE.md`.

## Global Constraints

- Keep exactly one failure type, one disposable Linux service, and one immutable `restart_demo_service` action.
- The approval demo is anonymous and staged. It must not claim identity-backed, privileged, or production authorization.
- `requiresHuman` remains the diagnosis safety flag. A low-confidence or policy-denied incident cannot be overridden by this approval gate.
- Only the browser that starts the approval run can decide it. Public incident IDs are never authority.
- No browser request can supply a command, workload, server, path, or action.
- Approval never executes directly; it only permits the authenticated runner to resume.
- Rejection and expiry execute no recovery action and queue restoration of the fixed disposable service.
- The existing autonomous path and all public safety wording/layout protections must remain correct.

---

### Task 1: Approval state contract

**Files:**
- Modify: `src/lib/contracts.ts`
- Modify: `src/lib/incident-state.ts`
- Modify: `convex/schema.ts`
- Test: `tests/incident-state.test.ts`
- Test: `tests/convex-state.test.ts`

- [x] Write failing tests for `policy_check → awaiting_approval → executing`, terminal rejection, and forbidden bypasses.
- [x] Add command mode `autonomous | approval_required`, active phase `awaiting_approval`, and durable pending/approved/rejected/expired approval fields on the fixed recovery record.
- [x] Require an approved record before an approval-mode incident can enter `executing`.
- [x] Run focused state tests.

### Task 2: Server-owned start and decision boundary

**Files:**
- Modify: `convex/demo.ts`
- Modify: `convex/runner.ts`
- Modify: `src/lib/server/convex.ts`
- Create: `src/lib/server/demo-approval.ts`
- Create: `src/app/api/demo/reset/approval-required/route.ts`
- Create: `src/app/api/demo/approval/approve/route.ts`
- Create: `src/app/api/demo/approval/reject/route.ts`
- Create: `src/app/api/demo/approval/session/route.ts`
- Test: `tests/convex-state.test.ts`
- Test: `tests/approval-route.test.ts`

- [x] Write failing tests for bodyless fixed routes, exact Origin, HttpOnly capability cookie, missing/wrong/replayed capability, cross-run use, and approve/reject races.
- [x] Generate a random 256-bit capability at the Vercel route, store only its server-derived digest, and bind it to the exact command/incident/recovery tuple.
- [x] Persist first-write-wins approve/reject decisions. Approve changes no workload state; reject terminalizes as `needs_human`, records no execution, and queues restoration.
- [x] Expose only safe approval status/timestamps/action label in public state; never expose the digest, cookie, runner token, lease, or execution nonce.
- [x] Run focused route and Convex tests.

### Task 3: Runner pause and resume

**Files:**
- Modify: `runner/orchestrator.ts`
- Modify: `runner/convex-client.ts`
- Modify: `runner/index.ts`
- Modify: `convex/runner.ts`
- Modify: `convex/lib/guards.ts`
- Test: `tests/orchestrator.test.ts`
- Test: `tests/convex-runner-client.test.ts`
- Test: `tests/runner-loop.test.ts`
- Test: `tests/convex-state.test.ts`

- [x] Write failing tests showing pending approval performs zero restarts and an approved snapshot resumes exactly once.
- [x] After policy success, persist the fixed proposed recovery, record an approval-requested step, move to `awaiting_approval`, and return without touching the workload.
- [x] Keep heartbeat/lease safety during the valid human wait, expire the approval on the server, and reset step/run deadlines from the decision time when approved.
- [x] Recheck policy and the durable approval before the runner enters `executing`; preserve the existing execution nonce and fresh verification rules.
- [x] Run focused runner tests.

### Task 4: Visible approval checkpoint

**Files:**
- Modify: `src/components/demo-dashboard.tsx`
- Create: `src/components/approval-gate.tsx`
- Modify: `src/components/resolution-card.tsx`
- Modify: `src/components/incident-timeline.tsx`
- Modify: `src/app/globals.css`
- Test: `tests/public-view.test.tsx`

- [x] Write failing tests for both start choices, owner/spectator pending states, approve/reject requests, truthful copy, disabled controls, and mobile layout.
- [x] Add `Run autonomous demo` and `Run approval demo` choices without changing the existing visual language.
- [x] Render an inline amber approval checkpoint above the timeline with the fixed action, its effect, `Approve staged restart`, and `Reject and restore demo`.
- [x] Say plainly that this public demo has no user account and the decision applies only to the disposable service.
- [x] Keep the resolution record before the timeline on phone, raw evidence collapsed, and all buttons at least 44px high.
- [x] Run focused UI tests.

### Task 5: Verification and public release

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `/Users/sanidhya/Downloads/GrowthX/IDEA_SCOPE.md`

- [ ] Run `npm test`, typecheck, lint, build, eval, sandbox proof, preflight, and `git diff --check`.
- [ ] Locally verify autonomous success remains nine steps.
- [ ] Locally verify approval pause survives reload, a spectator cannot decide, approval resumes to verified healthy, rejection runs no recovery, and restoration completes.
- [ ] Verify 1440px and 390px with no horizontal overflow or browser errors.
- [ ] Push to GitHub, wait for the production Vercel/Convex deployment, restart exactly one compatible runner, and repeat the public checks.
- [ ] Record only verified evidence in `IDEA_SCOPE.md` and one user-visible line in `CHANGELOG.md`.
