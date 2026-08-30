# Autonomous DevOps Agent

A GrowthX Build Week project proving a bounded operational recovery loop: detect a failed Linux workload, investigate it, execute one permitted recovery action, and independently verify health.

- Public setup page: https://autonomous-devops-agent.vercel.app
- Status: M0 runner feasibility is verified locally; the complete public recovery loop is not built yet.
- Surface: Sanidhya-owned disposable Docker container only. Current evidence is controlled/staged and cannot support an L4 or L5 real-output claim.

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

## Verify the M0 runner proof

Docker Desktop must be running. These commands build and exercise only the fixed disposable container:

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run demo:build
npm run demo:proof
npm run build
```

`npm run demo:proof` performs one controlled stop and one fixed restart, checks that unknown and duplicate actions are rejected, and prints a non-sensitive JSON result. It leaves the disposable service running and healthy.

Do not copy Codex or account authentication files into this repository, Docker, Vercel, or Convex.
