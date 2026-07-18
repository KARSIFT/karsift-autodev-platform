# Development Deployment Contract

## Purpose

ADP-003 requires a remotely reachable HTTPS endpoint before ChatGPT can use the Founder Interface as a GPT Action. This document defines that deployment boundary without granting the repository or any AI worker deployment credentials.

## Required topology

```text
Internet
  |
  | HTTPS only
  v
TLS reverse proxy / ingress
  |
  | private service network
  v
KARSIFT Control Plane :8080
  |
  v
PostgreSQL 18
```

The Control Plane process must not be exposed directly on a public plaintext HTTP port.

## Required environment

The deployed service must receive secrets from the deployment environment, not from Git:

- `DATABASE_URL`
- `CONTROL_PLANE_API_TOKEN`
- `CONTROL_PLANE_FOUNDER_API_TOKEN`
- `CONTROL_PLANE_FOUNDER_INTERFACE_API_TOKEN`

It must also receive:

- `CONTROL_PLANE_HOST=0.0.0.0`
- `CONTROL_PLANE_PORT=8080`
- `CONTROL_PLANE_PUBLIC_BASE_URL=https://<development-control-plane-host>`
- `CONTROL_PLANE_SERVICE_ID=karsift-control-plane`
- `CONTROL_PLANE_FOUNDER_ID=<founder-identity>`

All three bearer tokens must be unique and independently rotatable.

## Network requirements

- Public ingress permits HTTPS only.
- PostgreSQL is not publicly reachable.
- Port 8080 is reachable only from the local reverse proxy or private network.
- The public hostname has a valid publicly trusted TLS certificate.
- `/health` may be used by infrastructure health checks.
- `/openapi.json` is intentionally public and contains no credentials.
- `/v1/*` requires bearer authentication.

## Founder Interface credential

The token configured as `CONTROL_PLANE_FOUNDER_INTERFACE_API_TOKEN` is the only credential that should be placed in a custom GPT Action configuration.

Its server-side authorization is restricted to:

- `GET /v1/status`
- `GET /v1/projects/{projectId}/status`
- `POST /v1/projects/{projectId}/requests`

It cannot create projects, record decisions, create or version Change Contracts, create tasks, create or transition workflow runs, or change capability switches.

The internal Control Plane token and high-authority founder token must never be configured in ChatGPT.

## Deployment readiness checks

Before connecting ChatGPT, verify from outside the host:

1. `GET /health` succeeds over HTTPS.
2. `GET /openapi.json` returns the expected three-operation schema.
3. `/v1/status` without a token returns `401`.
4. `/v1/status` with the founder-interface token returns `200`.
5. A prohibited route such as `POST /v1/projects` with the founder-interface token returns `403`.
6. A test founder request can be created and appears in Control Plane project status/audit evidence.

## ChatGPT connection

Use `openapi/founder-actions.json` as the action schema after replacing its placeholder server URL with the deployed HTTPS origin. Configure API-key authentication as a bearer token using only the founder-interface token.

The initial action surface is deliberately narrow. Higher-authority decisions and any autonomous execution remain outside the ChatGPT action boundary until separately specified, implemented, verified, and activated.
