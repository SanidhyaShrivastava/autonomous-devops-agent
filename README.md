# Autonomous DevOps Agent

A GrowthX Build Week project proving a bounded operational recovery loop: detect a failed Linux workload, investigate it, execute one permitted recovery action, and independently verify health.

- Public app: https://autonomous-devops-agent.vercel.app
- Status: the complete M1 recovery loop is live. Fresh post-cutover public runs now pass through an authenticated Linux sandbox agent instead of direct host-side Docker control.
- Surface: Sanidhya-owned disposable Linux sandbox in Docker only. Current evidence is controlled/staged and cannot support an L4 or L5 real-output claim.

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
- The staged public demo has no human approval step; its single restart is allowlisted and policy-checked automatically.

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
| `CONVEX_DEPLOY_KEY` | No | Yes | No |
| `CONVEX_URL` | No | Yes | Yes |
| `PUBLIC_APP_URL` | No | Yes | Yes |
| `RUNNER_ID` | No | No | Yes |

- Generate different random 32-byte values for `DEMO_REQUEST_SECRET` and `RUNNER_TOKEN`.
- `DEMO_REQUEST_SECRET` must be identical in Convex and Vercel.
- `RUNNER_TOKEN` must be identical in Convex and `.env.runner.local`.
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
