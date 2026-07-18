# KARSIFT Autodev Platform

Reusable autonomous-development infrastructure for KARSIFT projects.

## Current activation level

**A1 — Coordinate**

The current Control Plane foundation can record and report governed work. Autonomous AI dispatch, automatic merge, deployment, production release, and incident repair are disabled.

## Local Control Plane

Requirements:

- Node.js 24.18.0 LTS
- PostgreSQL 18.4

Start PostgreSQL:

```bash
docker compose up -d postgres
```

Configure the service:

```bash
cp .env.example .env
```

Export the variables from `.env`, then install, build, migrate, test, and run:

```bash
npm install
npm run build
npm run migrate
npm test
npm start
```

Health:

```text
GET /health
```

Authenticated API uses separate non-interchangeable credentials:

```text
Authorization: Bearer <CONTROL_PLANE_API_TOKEN>
Authorization: Bearer <CONTROL_PLANE_FOUNDER_API_TOKEN>
```

The internal service token is identified as `SYSTEM`; only the founder token can record an `R4` decision. Caller-supplied headers cannot impersonate founder authority.

Key status endpoints:

```text
GET /v1/status
GET /v1/projects/:projectId/status
```

The A1 API can record projects, founder requests, decisions, immutable Change Contract versions, tasks, and workflow runs. It can disable capability switches, but it cannot enable autonomous capabilities.

See `docs/architecture/01-control-plane-foundation.md` and the governed change packages under `specs/changes/`.
