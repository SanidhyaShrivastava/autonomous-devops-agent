# Autonomous DevOps Agent

A GrowthX Build Week project proving a bounded operational recovery loop: detect a failed Linux workload, investigate it, execute one permitted recovery action, and independently verify health.

- Public app: https://autonomous-devops-agent.vercel.app
- Status: the complete M1 recovery loop is live, and a signed-in owner can pair one disposable Linux runner, register the bundled fixed service, prepare one approval-required restart, approve or reject it, and see fresh post-restart verification.
- Surface: Sanidhya-owned disposable Linux containers in Docker only. The private path is fixed policy recovery, not arbitrary service onboarding or AI investigation. Current evidence is controlled/staged and cannot support an L4 or L5 real-output claim.

## Hybrid autonomy proof

The same fixed service recovery now has two staged modes:

- **Autonomous:** after the evidence-backed diagnosis and deterministic policy check, the allowlisted restart continues automatically.
- **Approval required:** the run pauses before execution. Only the browser that started that run can approve or reject the same fixed restart; another browser is read-only. Approval resumes through the authenticated runner, while rejection or expiry executes no recovery and restores the disposable service safely.

The public demo has no user account and does not identify an approver. Its short-lived browser key is stored in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie; Convex stores only a server-derived digest. The browser never supplies a command, workload, path, server, or action. This proves the control mechanism on a staged surface only; it is not production authorization.

## Original M1 evidence

On Sun 30 Aug 2026, three separate public recovery-demo runs completed without terminal assistance after the click:

| Run | Result | Steps | Recovery time | Human action |
|---|---|---:|---:|---|
| 1 | `FAILED → HEALTHY` | 9 | 12.7s | None |
| 2 | `FAILED → HEALTHY` | 9 | 11.6s | None |
| 3 — independent review | `FAILED → HEALTHY` | 9 | 11.8s | None |

- `OUTPUT-L3`: the controlled Docker service was really stopped, failed its health check, received only the fixed allowlisted restart, and passed a fresh independent HTTP health check. Evidence: [resolution card](output/playwright/output-l3-resolution.png). This is explicitly staged/test output, so the honest rubric level is **Working product shipping real output L3**.
- `OBS-L3`: incident `jd7bxw8ahczeaj9cxx548cpaz18denet` restored after a full page reload with nine ordered steps across Incident Manager, Investigator, Policy Gate, Executor, and Verifier. Each public step shows status, its human-readable operation, collapsed sanitized evidence, and elapsed time. Private model usage and login details are not returned by the public query. Evidence: [persisted timeline](output/playwright/observability-l3-timeline.png). The public UI has no run filters or grounded per-step cost, so the honest rubric level is **Observability L3**, not L4.
- Phone check: the corrected local production build rendered at 390×844 with the outcome before the collapsed timeline, no horizontal overflow, and zero browser errors. Evidence: [phone viewport](output/playwright/recovery-loop-phone.png).
- Synthetic/control evaluation: `npm run eval` reports **7 PASS, 3 SKIPPED_M1, 0 FAIL** for `recovery-loop-v1`. The skipped scheduled-job and cross-run-memory cases are not presented as implemented.
- Fresh independent review: **PASS, no blockers**. It separately verified one empty-body public request, duplicate/offline/failed-verification controls, reload persistence, desktop and phone widths, 257/257 tests, and zero browser errors or warnings. This pass addresses the long phone trace; the brief early outcome placeholder and no visible stable incident ID remain parked for Monday user evidence.

## Verified Linux-sandbox cutover evidence

On Tue 1 Sep 2026, the production coordinator was cut over to the isolated Linux sandbox only after the compatibility deployment was ready. The old coordinator was stopped before exactly one new coordinator began sending a fresh heartbeat.

- A logged-out desktop run completed all nine steps in `21.5s`; a separate 390-pixel phone run completed all nine steps in `20.5s`. Both used truthful Linux-agent operation labels, resolved only after a fresh exact HTTP 200 health response, and persisted after reload.
- In a post-cutover failure test, the coordinator was stopped immediately after stored step 4. The page showed `Runner lost after step 4: read service logs` in `13.6s`, preserved the failed incident after reload, and kept a new run blocked. After exactly one coordinator returned, it restored and freshly checked the child service, the page showed `Demo environment restored and healthy`, and a new nine-step run recovered successfully in `22.1s`.
- At 390 pixels, the resolution record remained above the timeline, raw evidence stayed collapsed, document width matched viewport width, and the browser reported zero errors or warnings.
- `npm run demo:proof` verified the authenticated fixed operation set, rejected unknown and duplicate actions, stopped the child service, recovered it, and passed fresh health on attempt 2. Separate code review, tests, and runtime inspection verified the host boundary.
- Runtime inspection verified: user `node`, read-only root filesystem, `ALL` Linux capabilities dropped, `no-new-privileges`, no host bind or host-backed mount, one internal 16 MiB `/tmp` temporary filesystem, no Docker socket, no privileged mode, no host process or network namespace, 64-process limit, 256 MiB memory limit, one CPU, and only port 3410 published to host loopback.
- This remains a controlled test surface. It improves the safety and truthfulness of the architecture but remains **Working product shipping real output L3**.

## Current safety boundary

- Fixed sandbox container: `gx-autodevops-linux-sandbox`
- Required label: `com.growthx.sandbox=autonomous-devops-agent`
- Fixed child workload: `demo-service`
- Only recovery action: `restart_demo_service`
- Fixed agent origin: `http://127.0.0.1:3410`; the workload health request stays inside the sandbox.
- The Mac coordinator reaches exactly six authenticated agent routes. The sandbox receives only a derived agent token, not the Convex runner token or ChatGPT login.
- The agent starts only its fixed Node child process without a shell; it cannot execute caller-supplied commands or read caller-supplied paths.
- Unknown actions, extra parameters, wrong labels, and duplicate execution IDs are rejected.
- A successful restart operation never proves recovery; a fresh HTTP 200 response with the expected service identity and `status: healthy` is required.
- The container has no Docker socket, host mount, elevated privilege, added capability, host process access, host network, employer system, customer system, production data, or arbitrary shell authority.
- Any future real-user environment remains approval-first until action-level trust is validated.
- The staged public demo offers both an automatic policy-checked path and a browser approval path for the same fixed action; neither path grants arbitrary authority.

## Owner-bound Linux runner recovery

The private preview at `/servers/new` now proves one narrow connection-and-recovery path:

1. Create an operator account or sign in.
2. Enter a private runner label and confirm permission to connect the server.
3. Create a one-time pairing code; only its digest is stored in Convex and the code expires after 10 minutes.
4. On the non-sensitive Linux host, clone this repository, run `npm install`, then run `npm run host:pair` and paste the code.
5. Run `npm run host:connect`; the browser shows the runner online after its outbound two-second heartbeat arrives.
6. Click **Register disposable service**. This grants exactly one fixed loopback HTTP health check and one fixed restart; there are no editable URLs, paths, or commands.
7. For the controlled test only, run `npm run host:seed-failure` on that Linux host. A natural service failure would enter the same unhealthy state.
8. Click **Prepare approval-first recovery**, then approve or reject the named fixed restart.
9. On approval, the runner durably claims the one-time command, starts a fresh service process without a shell, and reports success only after an exact HTTP 200 from a changed service instance. Rejection executes nothing.
10. Revoke access from the browser when needed; the saved runner credential is then rejected.

The host agent has no inbound listener and accepts no caller-supplied shell, service name, path, URL, or parameters. Its saved credential and execution journal use owner-only file permissions. A claimed command is never replayed after an unknown result. Pairing, heartbeat, and recovery requests use shared bounded limits rather than temporary per-web-process counters. The Build Week password login has no reset-email flow yet, so it must not reuse an important password.

Live verification used one disposable Debian Linux container and one clearly named test-only account. A fresh unhealthy report exposed the approval-first action; rejection left the service unreachable and recorded **Recovery rejected**; two separate approvals produced new service instance IDs and fresh HTTP 200 evidence; the verified record survived reload. A deliberate runner kill after durable command claim produced a persisted **Runner lost during restart** result; one restarted runner left that result-less journal claim unreplayed, and a separate new command recovered to a new verified instance. After another healthy runner restart changed the current service ID, the page still showed the stored verified recovery instead of falsely calling its evidence incomplete. The deployed page passed at 1440 pixels and 390 pixels with no horizontal overflow or browser errors. The unchanged public autonomous demo also completed all nine steps healthy in `20.2s` after the final code release. The full suite passes 558/558 tests. This account and every controlled run are test evidence and must not be counted as users, signups, or genuine production-surface output.

This remains deliberately narrow. The private path cannot discover or configure an existing user service, read its logs, run an AI investigation, manage systemd, or execute arbitrary recovery commands. Connecting a consenting user's genuine non-sensitive workload is the next proof required before any L4 real-output claim.

## Local verification

Docker Desktop must be running. These commands build and exercise only the fixed disposable container:

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run demo:build
npm run demo:start
npm run demo:proof
npm run eval
npm run build
npm run demo:preflight
```

`npm run demo:proof` performs one controlled child-service stop and one fixed restart through the Linux agent, checks that unknown and duplicate actions are rejected, and prints a non-sensitive JSON result. It leaves the disposable service running and healthy. Container inspection and the test suite check the separate host boundary.

Do not copy Codex or account authentication files into this repository, Docker, Vercel, or Convex.

## Production configuration

Production deploys use the GitHub-connected Vercel project and the build command in `vercel.json`. That command deploys the Convex functions first, supplies the matching production Convex URL to the Next.js build, and then builds the web app.

Keep every value in only the places listed here:

| Variable | Convex production | Vercel production | `.env.runner.local` |
|---|---:|---:|---:|
| `DEMO_REQUEST_SECRET` | Yes | Yes | No |
| `RUNNER_TOKEN` | Yes | No | Yes |
| `RUNNER_PAIRING_REQUEST_SECRET` | Yes | Yes | No |
| `JWT_PRIVATE_KEY` | Yes | No | No |
| `JWKS` | Yes | No | No |
| `SITE_URL` | Yes | No | No |
| `CONVEX_DEPLOY_KEY` | No | Yes | No |
| `CONVEX_URL` | No | Yes | Yes |
| `PUBLIC_APP_URL` | No | Yes | Yes |
| `RUNNER_ID` | No | No | Yes |

- Generate different random values for `DEMO_REQUEST_SECRET`, `RUNNER_TOKEN`, and `RUNNER_PAIRING_REQUEST_SECRET`.
- `DEMO_REQUEST_SECRET` must be identical in Convex and Vercel.
- `RUNNER_TOKEN` must be identical in Convex and `.env.runner.local`.
- `RUNNER_PAIRING_REQUEST_SECRET` must be identical in Convex and Vercel.
- `JWT_PRIVATE_KEY`, `JWKS`, and `SITE_URL` belong only in Convex and support owner authentication.
- `CONVEX_DEPLOY_KEY` must be a production Convex deployment key with deployment permission.
- Never prefix a secret with `NEXT_PUBLIC_`; values with that prefix can be sent to the browser.
- Never commit `.env.runner.local`; `.env*` is ignored except for the empty `.env.example` template.

## Start the trusted local pieces

The public web app and Convex run in the cloud. The trusted coordinator, Codex authentication, Convex runner token, and Docker Desktop stay on Sanidhya's Mac. The fixed workload and narrow workload agent run inside the isolated Linux sandbox.

With Docker Desktop running:

```bash
# Terminal 1
npm run demo:start

# Terminal 2 — leave this running
npm run runner

# Back in Terminal 1
npm run demo:preflight
```

- `demo:start` creates or starts only the fixed, hardened Linux sandbox and checks both its agent and child-service health.
- Start `runner` in a separate terminal and leave it open; it coordinates Convex and Codex with the sandbox's fixed authenticated operations.
- Run `demo:preflight` in the original terminal after the runner connects. It reports status only and verifies the sandbox agent, child service, health response, ChatGPT-based Codex login, Convex production, a fresh coordinator heartbeat, and the public app.
- `eval` runs synthetic/control safety checks only; it never touches Docker or production.

Closing the coordinator makes the public page show `Runner offline`. If the sandbox disappears while the coordinator is still alive, a run fails visibly instead of being replaced with a fake recovery. The legacy direct-Docker scripts remain available under `demo:legacy:*` only as a temporary Build Week rollback path; production uses the Linux sandbox scripts.
