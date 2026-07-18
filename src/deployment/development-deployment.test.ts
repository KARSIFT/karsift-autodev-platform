import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function serviceBlock(compose: string, service: string, nextService: string): string {
  const start = compose.indexOf(`  ${service}:`);
  const end = compose.indexOf(`\n  ${nextService}:`, start + 1);
  assert.notEqual(start, -1, `${service} service must exist`);
  assert.notEqual(end, -1, `${nextService} service must follow ${service}`);
  return compose.slice(start, end);
}

test("development deployment keeps state private and exposes only HTTPS ingress", async () => {
  const compose = await readFile("deploy/development/compose.yaml", "utf8");
  const caddy = await readFile("deploy/development/Caddyfile", "utf8");
  const dockerfile = await readFile("Dockerfile", "utf8");

  const postgres = serviceBlock(compose, "postgres", "control-plane");
  const controlPlane = serviceBlock(compose, "control-plane", "caddy");

  assert.match(postgres, /image: postgres:18\.4-alpine/);
  assert.doesNotMatch(postgres, /^\s+ports:/m);
  assert.doesNotMatch(controlPlane, /^\s+ports:/m);
  assert.match(compose, /image: caddy:2\.11\.4-alpine/);
  assert.match(compose, /"80:80"/);
  assert.match(compose, /"443:443"/);
  assert.match(compose, /backend:\n    internal: true/);
  assert.match(compose, /CONTROL_PLANE_FOUNDER_INTERFACE_API_TOKEN/);

  assert.match(caddy, /\{\$CONTROL_PLANE_DOMAIN\}/);
  assert.match(caddy, /reverse_proxy control-plane:8080/);

  assert.match(dockerfile, /COPY package\.json package-lock\.json \.\//);
  assert.match(dockerfile, /npm ci --ignore-scripts/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /HEALTHCHECK/);
});
