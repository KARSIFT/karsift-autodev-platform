# Development VPS Deployment

This package runs the A1 Control Plane behind automatic HTTPS on a generic Docker-capable VPS.

## External prerequisites

- a Linux VPS with Docker Engine and Docker Compose v2;
- a public DNS `A`/`AAAA` record pointing the chosen hostname to that VPS;
- inbound TCP ports 80 and 443, plus UDP 443 if HTTP/3 is desired;
- unique secrets for PostgreSQL and all three Control Plane bearer credentials.

## Prepare configuration

From the repository root on the VPS:

```bash
cp deploy/development/env.example deploy/development/.env
```

Replace every `CHANGEME` value. All three Control Plane bearer tokens must be different and at least 32 characters. The founder-interface token is the only token that may later be configured in ChatGPT.

The sample `DATABASE_URL` assumes a URL-safe PostgreSQL password. If the password contains URL-reserved characters, percent-encode them in `DATABASE_URL`.

## Start and migrate

```bash
docker compose \
  --env-file deploy/development/.env \
  -f deploy/development/compose.yaml \
  up -d postgres

docker compose \
  --env-file deploy/development/.env \
  -f deploy/development/compose.yaml \
  run --rm control-plane node dist/db/migrate.js

docker compose \
  --env-file deploy/development/.env \
  -f deploy/development/compose.yaml \
  up -d control-plane caddy
```

Caddy obtains and renews the public TLS certificate automatically after DNS resolves to the VPS and ports 80/443 are reachable.

## Verify

From a machine outside the VPS network:

```bash
curl -fsS https://YOUR_DOMAIN/health
curl -fsS https://YOUR_DOMAIN/openapi.json
```

Then verify authenticated boundaries:

- no token on `/v1/status` returns `401`;
- the founder-interface token can read `/v1/status`;
- the founder-interface token receives `403` for `POST /v1/projects`;
- a test founder request can be created for a registered project.

## Secret boundary

Do not commit `deploy/development/.env`. Do not configure ChatGPT with `CONTROL_PLANE_API_TOKEN` or `CONTROL_PLANE_FOUNDER_API_TOKEN`. Only `CONTROL_PLANE_FOUNDER_INTERFACE_API_TOKEN` belongs in the custom GPT Action configuration.

This deployment is development infrastructure only. It does not activate AI dispatch, automatic merge, autonomous deployment, production release, or incident repair.
