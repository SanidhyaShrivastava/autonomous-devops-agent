# Active Run Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a newly accepted recovery run refresh its public Convex state once per second and stop refreshing as soon as that same run reaches a final state.

**Architecture:** Subscribe to the exact Convex command ID returned by an accepted reset, so the browser cannot fall back to an older incident. Keep that live stream as the primary path, add a fresh HTTP state check once per second as a bounded fallback, and stop the fallback on `complete`, `failed`, `expired`, or the existing 90-second command limit.

**Tech Stack:** Next.js, React, Convex, TypeScript, Vitest, Testing Library, Playwright CLI

**Spec:** `../../../../IDEA_SCOPE.md` M1 acceptance test and Shaktimaan's 31 Aug review requiring active-run updates once per second with no post-run polling.

## Global Constraints

- Keep the one disposable Linux service and one allowlisted restart; do not add another failure type.
- Do not weaken the local runner allowlist, policy gate, verification, cooldown, or request cap.
- Keep the public page free of model login, token, and cost metadata.
- The refresh timer must run only after an accepted reset and must stop after the newly requested run becomes terminal.
- Verify the final public result at 1440px and 390px before deployment is called complete.

---

### Task 1: Bounded active-run refresh

**Files:**

- Modify: `convex/demo.ts`
- Modify: `src/components/demo-dashboard.tsx`
- Test: `tests/public-view.test.tsx`
- Test: `tests/convex-state.test.ts`

**Interfaces:**

- Consumes: `api.demo.getPublicState`, the accepted `POST /api/demo/reset` command ID, and existing terminal command statuses.
- Produces: exact-command live state plus a one-second HTTP fallback that stops at terminal state or the command-expiry boundary.

- [ ] **Step 1: Add regression coverage**

```tsx
// The UI test starts with an older resolved incident, accepts a new command,
// receives exact-command state through the HTTP fallback, and proves the
// fallback stops after the new command becomes terminal.
```

```ts
// The Convex tests query the accepted command ID immediately after completion
// and prove that a newer failed command never falls back to an older success.
```

- [ ] **Step 2: Implement the minimal refresh contract**

```ts
export const getPublicState = query({
  args: { demoCommandId: v.optional(v.id("demoCommands")) },
  handler: async (ctx, args) => {
    // With a command ID, return only that command, its incident, and its steps.
  },
});
```

```tsx
// Start the HTTP fallback only after POST returns 202 with a command ID.
// Keep the exact-command Convex subscription as the primary live stream.
// Stop on complete, failed, expired, or the 90-second safety boundary.
```

- [ ] **Step 3: Run the focused tests**

Run: `npm test -- tests/public-view.test.tsx tests/convex-state.test.ts`

Expected: all focused tests pass, including the new refresh-start, terminal-stop, and immediate-public-terminal checks.

- [ ] **Step 4: Run full local verification**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Run: `npm run lint`

Expected: tests, type checking, and build pass; lint has no errors.

### Task 2: Public timing proof and deployment

**Files:**

- Modify: `CHANGELOG.md`
- Modify after proof: `../IDEA_SCOPE.md`

**Interfaces:**

- Consumes: the verified local change and existing GitHub-to-Vercel deployment pipeline.
- Produces: a deployed canonical URL and measured desktop/phone evidence that the result appears without a one-minute wait.

- [ ] **Step 1: Verify locally in a real browser**

Run the recovery flow at 1440px and 390px. Record the click time, terminal display time, backend recovery time, phase sequence, and browser errors.

Expected: the page visibly advances during the run, shows the terminal result no later than one refresh interval after the backend terminal write, and the refresh timer stops.

- [ ] **Step 2: Record the user-visible change**

Add one `CHANGELOG.md` line saying a visitor can now see active recovery updates once per second and the final result immediately after the run finishes.

- [ ] **Step 3: Commit and deploy**

Run: `git add convex/demo.ts src/components/demo-dashboard.tsx tests/public-view.test.tsx tests/convex-state.test.ts CHANGELOG.md docs/superpowers/plans/2026-08-31-active-run-refresh.md`

Run: `git commit -m "fix: refresh active recovery state promptly"`

Run: `git push origin main`

Expected: the connected Convex/Vercel workflow reaches Ready and the canonical URL serves the new commit.

- [ ] **Step 4: Repeat public verification**

Run one fresh logged-out recovery at 1440px and one at 390px after the cooldown. Confirm the result, raw evidence, fresh HTTP 200 verification, and zero browser errors.

Expected: each page shows the final result within one second of backend completion; no active refresh continues after terminal state.
