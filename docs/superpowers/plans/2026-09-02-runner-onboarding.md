# Owner-Bound Linux Runner Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one signed-in engineer create a short-lived pairing code, connect one non-sensitive Linux runner, and see its heartbeat online without granting recovery access.

**Architecture:** Keep the existing logged-out recovery demo isolated. Add Convex Auth for owner identity, separate owner-bound runner and enrollment tables, two narrow Next.js endpoints for one-time pairing and heartbeats, and a small Linux host agent that only stores a scoped credential and sends outbound heartbeats. The first slice explicitly does not read logs, discover services, or execute commands on the connected server.

**Tech Stack:** Next.js 16 App Router, React 19, Convex, `@convex-dev/auth`, TypeScript, Zod, Vitest, Testing Library.

**Spec:** `../IDEA_SCOPE.md`

## Global Constraints

- The existing public staged recovery flow at `/` must remain working and anonymous.
- Never reuse `RUNNER_TOKEN`, `DEMO_REQUEST_SECRET`, `demoControl`, or demo approval cookies for a real runner.
- A runner belongs to exactly one authenticated owner.
- Pairing codes expire after 10 minutes, can be used once, and are stored only as SHA-256 digests.
- Runner credentials are 256-bit random values, returned only once, stored only as digests on the server, and written with mode `0600` on Linux.
- The host agent makes outbound HTTPS requests only; it does not open an inbound port.
- This slice does not inspect hostnames, IP addresses, files, logs, processes, services, or environment values.
- This slice does not run shell commands or recovery actions on a connected server.
- The UI must say that no recovery actions are enabled yet.
- Use `src/proxy.ts`, not deprecated `middleware.ts`, for Next.js 16 route protection.
- Password sign-in is a Build Week fallback because the current Convex Auth package does not ship its planned passkey provider; password reset and email verification remain outside this slice.

---

## File map

- `convex/convex.config.ts`: register the Convex Auth component.
- `convex/auth.ts`, `convex/auth.config.ts`, `convex/http.ts`: password provider and auth endpoints.
- `convex/schema.ts`: include auth tables plus pairing, runner, and workload records.
- `convex/runners.ts`: owner-authenticated enrollment creation/list/revoke and server-secret pairing/heartbeat mutations.
- `convex/lib/auth.ts`: require and return the authenticated Convex user ID.
- `src/app/ConvexClientProvider.tsx`, `src/app/layout.tsx`, `src/proxy.ts`: connect browser and server auth state and protect `/servers`.
- `src/app/sign-in/page.tsx`, `src/components/sign-in-form.tsx`: sign up/sign in screen.
- `src/app/servers/new/page.tsx`, `src/components/server-onboarding.tsx`: one-screen connection flow.
- `src/app/api/runners/pair/route.ts`, `src/app/api/runners/heartbeat/route.ts`: bounded public machine endpoints.
- `src/lib/server/runner-enrollment.ts`: strict validation, code/credential hashing, and Convex calls.
- `host-agent/config.ts`, `host-agent/pair.ts`, `host-agent/connect.ts`: prompt for a code, save the credential safely, and send heartbeats.
- `src/components/demo-dashboard.tsx`, `src/app/globals.css`: add the entry link and onboarding styles using the existing console language.
- `tests/convex-auth.test.ts`, `tests/convex-runners.test.ts`, `tests/runner-enrollment-route.test.ts`, `tests/host-agent.test.ts`, `tests/server-onboarding.test.tsx`, `tests/public-view.test.tsx`: regression and boundary tests.
- `README.md`, `../IDEA_SCOPE.md`, `CHANGELOG.md`: truthful setup, status, and milestone evidence.

### Task 1: Owner authentication foundation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `convex/convex.config.ts`
- Create: `convex/auth.ts`
- Create: `convex/auth.config.ts`
- Create: `convex/http.ts`
- Create: `convex/lib/auth.ts`
- Modify: `convex/schema.ts`
- Modify: `convex/tsconfig.json`
- Modify: `src/app/ConvexClientProvider.tsx`
- Modify: `src/app/layout.tsx`
- Create: `src/proxy.ts`
- Create: `src/app/sign-in/page.tsx`
- Create: `src/components/sign-in-form.tsx`
- Test: `tests/convex-auth.test.ts`

**Interfaces:**
- Produces: `requireUserId(ctx): Promise<Id<"users">>` for authenticated Convex functions.
- Produces: `/sign-in` and an authenticated browser session available to Convex hooks.
- Produces: route protection for `/servers/:path*` with `/` left public.

- [ ] **Step 1: Install exact auth packages**

Run: `npm install --save-exact @convex-dev/auth@0.0.95 @auth/core@0.41.3`

Expected: lockfile records exact versions; no unrelated package is added.

- [ ] **Step 2: Write the failing auth boundary test**

Create `tests/convex-auth.test.ts` with a Convex test that calls a small authenticated query without identity and expects the generic `Authentication required` error, then supplies an identity and expects a user ID.

```ts
expect(runWithoutIdentity()).rejects.toThrow("Authentication required");
expect(await runWithIdentity({ subject: userId })).toBe(userId);
```

- [ ] **Step 3: Run the new test and confirm the missing module failure**

Run: `npm test -- tests/convex-auth.test.ts`

Expected: FAIL because `convex/lib/auth.ts` does not exist yet.

- [ ] **Step 4: Add the minimal supported Convex Auth wiring**

Use the official password provider and auth tables:

```ts
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password],
});
```

```ts
export async function requireUserId(ctx: QueryCtx | MutationCtx) {
  const userId = await auth.getUserId(ctx);
  if (userId === null) throw new ConvexError("Authentication required");
  return userId;
}
```

Wrap the app with `ConvexAuthNextjsServerProvider` and `ConvexAuthNextjsProvider`. Protect only `/servers/:path*` in `src/proxy.ts`; redirect signed-out visitors to `/sign-in?returnTo=/servers/new`.

- [ ] **Step 5: Add a plain sign-up/sign-in form**

Use `useAuthActions().signIn("password", formData)` with a hidden `flow` field of `signUp` or `signIn`. Require a valid email and a password of at least eight characters, show generic errors, and redirect to `/servers/new` after success.

- [ ] **Step 6: Generate and set auth keys without displaying them**

Generate separate RS256 key pairs for development and production with `jose`, set `JWT_PRIVATE_KEY` and `JWKS` using Convex `NAME=VALUE` commands, set `SITE_URL` to `http://localhost:3000` for development and `https://autonomous-devops-agent.vercel.app` for production, then delete the temporary key files.

- [ ] **Step 7: Verify auth checks locally**

Run: `npm test -- tests/convex-auth.test.ts && npm run typecheck && npm run lint`

Expected: all commands pass.

- [ ] **Step 8: Commit the auth foundation**

```bash
git add package.json package-lock.json convex src/app src/components/sign-in-form.tsx src/proxy.ts tests/convex-auth.test.ts
git commit -m "feat: add owner authentication"
```

### Task 2: One-time runner pairing and heartbeat state

**Files:**
- Modify: `convex/schema.ts`
- Create: `convex/runners.ts`
- Create: `src/lib/server/runner-enrollment.ts`
- Create: `src/app/api/runners/pair/route.ts`
- Create: `src/app/api/runners/heartbeat/route.ts`
- Test: `tests/convex-runners.test.ts`
- Test: `tests/runner-enrollment-route.test.ts`

**Interfaces:**
- Consumes: `requireUserId(ctx)` from Task 1.
- Produces: `api.runners.createEnrollment({ label, codeDigest })` returning `{ enrollmentId, expiresAt }`.
- Produces: `api.runners.listMine()` returning only the current owner's bounded runner data.
- Produces: `internal.runners.consumeEnrollment(...)` and `internal.runners.recordHeartbeat(...)` called only by server routes.
- Produces: `POST /api/runners/pair` and `POST /api/runners/heartbeat`.

- [ ] **Step 1: Write failing database tests**

Cover owner isolation, ten-minute expiry, atomic single use, replay rejection, digest-only storage, heartbeat binding, and revocation. The tests must assert that no raw code, raw credential, hostname, IP, path, URL, log, or command field is present in any stored document.

- [ ] **Step 2: Run the database tests and confirm they fail**

Run: `npm test -- tests/convex-runners.test.ts`

Expected: FAIL because the runner schema and functions do not exist.

- [ ] **Step 3: Add minimal separate tables**

Add `runnerPairingInvites`, `registeredRunners`, and `managedWorkloads`. Bind every record to `ownerId: v.id("users")`. Store `codeDigest` and `credentialDigest`, never raw secrets. Restrict runner metadata to label, generated ID, `linux`, architecture, agent version, timestamps, and revoked state.

- [ ] **Step 4: Implement owner and machine mutations**

`createEnrollment` checks identity and allows one active enrollment. `consumeEnrollment` checks a dedicated server secret before reading state, validates expiry, atomically marks the invite consumed, and creates one runner. `recordHeartbeat` checks the runner ID plus credential digest and updates `lastHeartbeatAt`. `revoke` is owner-only.

- [ ] **Step 5: Run database tests**

Run: `npm test -- tests/convex-runners.test.ts`

Expected: PASS.

- [ ] **Step 6: Write failing route tests**

Cover malformed JSON, oversized body, unknown fields, wrong/expired/reused codes, bad bearer credentials, generic errors, no-store responses, and ensuring raw values never reach logs. Pair accepts only `pairingCode`, `agentVersion`, and a bounded architecture; heartbeat accepts only a bearer credential and runner ID.

- [ ] **Step 7: Implement the narrow route helper and endpoints**

Create 256-bit credentials with `crypto.randomBytes(32)`, format public IDs separately, hash secrets with SHA-256, and return the raw credential exactly once from the pairing response. Set `Cache-Control: no-store`; never echo a submitted pairing code in an error.

- [ ] **Step 8: Run route and state tests**

Run: `npm test -- tests/convex-runners.test.ts tests/runner-enrollment-route.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit pairing state and endpoints**

```bash
git add convex/schema.ts convex/runners.ts src/lib/server/runner-enrollment.ts src/app/api/runners tests/convex-runners.test.ts tests/runner-enrollment-route.test.ts
git commit -m "feat: add owner-bound runner pairing"
```

### Task 3: Minimal Linux heartbeat agent

**Files:**
- Create: `host-agent/config.ts`
- Create: `host-agent/pair.ts`
- Create: `host-agent/connect.ts`
- Modify: `package.json`
- Test: `tests/host-agent.test.ts`

**Interfaces:**
- Consumes: `POST /api/runners/pair` and `POST /api/runners/heartbeat` from Task 2.
- Produces: `saveRunnerConfig(path, config)` with file mode `0600`.
- Produces: `npm run host:pair` and `npm run host:connect`.

- [ ] **Step 1: Write failing host-agent tests**

Use a temporary directory. Assert that pairing reads the code from an interactive prompt rather than process arguments, saves only endpoint/runner ID/credential, sets mode `0600`, redacts secrets from errors, and that connect sends a heartbeat every two seconds. Scan the source to reject `child_process`, shell execution, host discovery, inbound listeners, and log/file reading.

- [ ] **Step 2: Run the host-agent test and confirm it fails**

Run: `npm test -- tests/host-agent.test.ts`

Expected: FAIL because `host-agent` does not exist.

- [ ] **Step 3: Implement the pairing command**

Prompt for `Base URL` and `One-time pairing code`, require HTTPS except `localhost`, call the pair endpoint, and atomically write the returned configuration to a user-selected/default config path with mode `0600`.

- [ ] **Step 4: Implement the heartbeat command**

Load and validate the config, POST a heartbeat immediately and every two seconds, display only `runner online` plus the safe public ID, stop cleanly on SIGINT/SIGTERM, and never print the credential.

- [ ] **Step 5: Run host-agent tests**

Run: `npm test -- tests/host-agent.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the agent**

```bash
git add host-agent package.json package-lock.json tests/host-agent.test.ts
git commit -m "feat: add safe Linux heartbeat agent"
```

### Task 4: One-screen authenticated onboarding

**Files:**
- Create: `src/app/servers/new/page.tsx`
- Create: `src/components/server-onboarding.tsx`
- Modify: `src/components/demo-dashboard.tsx`
- Modify: `src/app/globals.css`
- Test: `tests/server-onboarding.test.tsx`
- Modify: `tests/public-view.test.tsx`

**Interfaces:**
- Consumes: auth state and `api.runners.createEnrollment`, `api.runners.listMine`, and `api.runners.revoke`.
- Produces: `/servers/new` states `ready`, `issuing`, `waiting`, `connected`, `expired`, and `error`.

- [ ] **Step 1: Write failing interface tests**

Assert visible label/help/permission consent, fixed `No actions enabled` policy, duplicate-submit prevention, code shown once only, waiting/connected/expired/error copy, accessible live status and focus movement, no hostname/IP/secret field, and the unchanged public demo plus `Connect a server →` link.

- [ ] **Step 2: Run the interface tests and confirm they fail**

Run: `npm test -- tests/server-onboarding.test.tsx tests/public-view.test.tsx`

Expected: FAIL because the route and link do not exist.

- [ ] **Step 3: Implement the onboarding state machine**

The form takes only a private label and ownership/permission confirmation. Generate a 256-bit pairing code with Web Crypto, send only its SHA-256 digest to Convex, and show a copyable `gxpair_…` value once. Subscribe to the current owner's runner state; display `Server connected` only after a fresh heartbeat. On reload, show waiting/connected/expired but never recover the raw code.

- [ ] **Step 4: Apply the interface design checkpoint**

Reuse the existing dark console tokens, square borders, Geist/Geist Mono type, and responsive breakpoints. Make the connection rail `Browser → Control plane → Runner` the focal object; put the immutable boundary `one non-sensitive Linux server · no actions enabled · recovery requires a later policy` before the action. Use one column under 980px, 14px gutters under 620px, actions at least 48px tall, and no horizontal code overflow.

- [ ] **Step 5: Run component and public-demo tests**

Run: `npm test -- tests/server-onboarding.test.tsx tests/public-view.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit onboarding UI**

```bash
git add src/app/servers src/components/server-onboarding.tsx src/components/demo-dashboard.tsx src/app/globals.css tests/server-onboarding.test.tsx tests/public-view.test.tsx
git commit -m "feat: add one-runner onboarding"
```

### Task 5: Verification, deployment, and truthful handoff

**Files:**
- Modify: `README.md`
- Modify: `../IDEA_SCOPE.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: a deployed, owner-authenticated pairing flow and evidence that the public demo has not regressed.

- [ ] **Step 1: Set a separate route-to-Convex secret**

Generate `RUNNER_PAIRING_REQUEST_SECRET` without displaying it. Set it for Convex development, Convex production, and Vercel production. Do not reuse any demo or runner secret.

- [ ] **Step 2: Run the complete automated verification**

Run: `npm test && npm run typecheck && npm run lint && npm run build`

Expected: every command exits 0.

- [ ] **Step 3: Run a local protocol proof**

Create a temporary user and enrollment, pair the host agent against localhost, verify an online heartbeat within five seconds, stop the agent, verify offline after the UI freshness window, revoke it, and prove its saved credential cannot heartbeat again. Keep all secrets out of the terminal transcript.

- [ ] **Step 4: Deploy production**

Deploy the existing Vercel project to production and deploy the production Convex functions. Record the deployment URL and commit SHA.

- [ ] **Step 5: Pause for the owner's real sign-in**

Ask Sanidhya to open `/sign-in`, create or sign into his account, then say `done`. This is the only browser-input pause.

- [ ] **Step 6: Verify in a real browser at 1440 and 390 pixels**

Check signed-out redirect, real sign-in, invite issuance, copy action, reload without secret replay, Linux agent pairing, online heartbeat, revoke, keyboard focus, no horizontal overflow, and no browser console errors. Re-run the public recovery demo and confirm all nine steps still resolve healthy.

- [ ] **Step 7: Update truthful project status**

Document that users can now own and pair one heartbeat-only Linux runner. State plainly that external log collection, service discovery, recovery approval, and execution are not enabled yet. Update `IDEA_SCOPE.md` current state without altering the locked product vision.

- [ ] **Step 8: Record the user-visible change**

Append exactly one line to `CHANGELOG.md`: `A signed-in engineer can now pair one non-sensitive Linux runner and see its live heartbeat without enabling any remote action.`

- [ ] **Step 9: Commit verified documentation**

```bash
git add README.md ../IDEA_SCOPE.md CHANGELOG.md
git commit -m "docs: record runner onboarding proof"
```

## Self-review

- Spec coverage: owner identity, one-time pairing, one runner, outbound heartbeat, safe boundary, mobile onboarding, public demo isolation, verification, and truthful scope status are each assigned to a task.
- Deliberate deferral: registering a service and every external recovery capability are excluded until pairing and ownership are verified; the UI names this boundary.
- Placeholder scan: no implementation step depends on an unnamed API, credential value, or invented user metric.
- Type consistency: `runnerPairingInvites`, `registeredRunners`, owner ID, code digest, credential digest, runner ID, and heartbeat timestamps keep the same names across schema, Convex functions, routes, host agent, UI, and tests.
