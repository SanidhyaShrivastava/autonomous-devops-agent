# Autonomous DevOps Agent

A GrowthX Build Week project proving a bounded operational recovery loop: detect a failed Linux workload, investigate it, execute one permitted recovery action, and independently verify health.

- Public app: https://autonomous-devops-agent.vercel.app
- Status: the complete M1 recovery loop is live and verified by three logged-out public runs, including one fresh independent review.
- Surface: Sanidhya-owned disposable Docker container only. Current evidence is controlled/staged and cannot support an L4 or L5 real-output claim.

## Verified M1 evidence

On Sun 30 Aug 2026, three separate public `Reset demo` runs completed without terminal assistance after the click:

| Run | Result | Steps | Recovery time | Model usage | Human action |
|---|---|---:|---:|---|---|
| 1 | `FAILED → HEALTHY` | 9 | 12.7s | 7,980 input / 93 output tokens | None |
| 2 | `FAILED → HEALTHY` | 9 | 11.6s | 8,146 input / 97 output tokens | None |
| 3 — independent review | `FAILED → HEALTHY` | 9 | 11.8s | 8,201 input / 92 output tokens | None |

- `OUTPUT-L3`: the controlled Docker service was really stopped, failed its health check, received only the fixed allowlisted restart, and passed a fresh independent HTTP health check. Evidence: [resolution card](output/playwright/output-l3-resolution.png). This is explicitly staged/test output, so the honest rubric level is **Working product shipping real output L3**.
- `OBS-L3`: incident `jd7bxw8ahczeaj9cxx548cpaz18denet` restored after a full page reload with nine ordered steps across Incident Manager, Investigator, Policy Gate, Executor, and Verifier. Each step shows status, sanitized output, and latency; the Investigator step also shows tokens. Evidence: [persisted timeline](output/playwright/observability-l3-timeline.png). Cost is unavailable under ChatGPT subscription login and there are no run filters, so the honest rubric level is **Observability L3**, not L4.
- Phone check: the deployed page rendered at 390×844 with no horizontal overflow and zero browser errors. Evidence: [phone viewport](output/playwright/recovery-loop-phone.png).
- Synthetic/control evaluation: `npm run eval` reports **7 PASS, 3 SKIPPED_M1, 0 FAIL** for `recovery-loop-v1`. The skipped scheduled-job and cross-run-memory cases are not presented as implemented.
- Fresh independent review: **PASS, no blockers**. It separately verified one empty-body public request, duplicate/offline/failed-verification controls, reload persistence, desktop and phone widths, 257/257 tests, and zero browser errors or warnings. Three non-blocking UI nits are parked for user evidence: a brief early outcome placeholder, the long phone trace, and no visible stable incident ID.

## Current safety boundary

- Fixed container: `gx-autodevops-demo-service`
- Required label: `com.growthx.demo=autonomous-devops-agent`
- Fixed workload: `demo-service`
- Only recovery action: `restart_demo_service`
- Fixed health check: `http://127.0.0.1:3400/health`
- Docker is invoked without a shell.
- Unknown actions, extra parameters, wrong labels, and duplicate execution IDs are rejected.
- A successful Docker command never proves recovery; a fresh HTTP 200 response with the expected service identity and `status: healthy` is required.
- No employer systems, customer systems, production data, host mounts, credentials, or arbitrary shell commands are used.
- Any future real-user environment remains approval-first until action-level trust is validated.

## Local verification

Docker Desktop must be running. These commands build and exercise only the fixed disposable container:

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run demo:build
npm run demo:proof
npm run eval
npm run build
```

`npm run demo:proof` performs one controlled stop and one fixed restart, checks that unknown and duplicate actions are rejected, and prints a non-sensitive JSON result. It leaves the disposable service running and healthy.

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

The public web app and Convex run in the cloud. Docker, Codex authentication, and the privileged runner stay on Sanidhya's Mac.

With Docker Desktop running:

```bash
# Terminal 1
npm run demo:start

# Terminal 2 — leave this running
npm run runner

# Back in Terminal 1
npm run demo:preflight
```

- `demo:start` creates or starts only the fixed, labelled disposable container and checks its health.
- Start `runner` in a separate terminal and leave it open; it connects the fixed local workload to Convex and waits for one bounded reset request.
- Run `demo:preflight` in the original terminal after the runner connects. It reports status only and verifies Docker, the exact container and health response, ChatGPT-based Codex login, Convex production, a fresh runner heartbeat, and the public app.
- `eval` runs synthetic/control safety checks only; it never touches Docker or production.

Closing the runner or Docker correctly makes the public page show `Runner offline`; the page never substitutes a fake recovery run.
