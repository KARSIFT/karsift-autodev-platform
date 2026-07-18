import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AppConfig } from "../config.js";
import type {
  AiBudgetStore,
  AuthorizeWorkBudgetInput,
  SettleAiBudgetReservationInput,
  UpsertAiBudgetPolicyInput,
} from "../store/ai-budget-types.js";
import { attachAiBudgetRoute } from "./ai-budget-route.js";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 0,
  publicBaseUrl: "http://127.0.0.1",
  internalApiToken: "internal-token-that-is-at-least-32-characters",
  internalServiceId: "control-plane",
  founderApiToken: "founder-token-that-is-at-least-32-characters!",
  founderInterfaceApiToken:
    "founder-interface-token-that-is-at-least-32-characters",
  founderId: "founder-1",
  databaseUrl: "postgres://unused",
};

class FakeAiBudgetStore implements AiBudgetStore {
  public policies: UpsertAiBudgetPolicyInput[] = [];
  public decisions: AuthorizeWorkBudgetInput[] = [];
  public settlements: SettleAiBudgetReservationInput[] = [];

  public async upsertAiBudgetPolicy(
    input: UpsertAiBudgetPolicyInput,
  ): Promise<Record<string, unknown>> {
    this.policies.push(input);
    return { project_id: input.projectId };
  }

  public async authorizeWorkBudget(
    input: AuthorizeWorkBudgetInput,
  ): Promise<Record<string, unknown>> {
    this.decisions.push(input);
    return { decision: { decision: "APPROVED" }, reservation: null };
  }

  public async settleAiBudgetReservation(
    input: SettleAiBudgetReservationInput,
  ): Promise<Record<string, unknown>> {
    this.settlements.push(input);
    return { status: "SETTLED" };
  }

  public async getProjectAiBudgetStatus(): Promise<Record<string, unknown>> {
    return {};
  }

  public async getPlatformAiBudgetStatus(): Promise<Record<string, unknown>> {
    return {};
  }
}

async function withServer(
  operation: (baseUrl: string, store: FakeAiBudgetStore) => Promise<void>,
): Promise<void> {
  const store = new FakeAiBudgetStore();
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  attachAiBudgetRoute(server, config, store);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    await operation(`http://127.0.0.1:${address.port}`, store);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("founder-interface credential cannot manage AI budget gates", async () => {
  await withServer(async (baseUrl, store) => {
    const response = await fetch(`${baseUrl}/v1/projects/project-1/ai-budget-policy`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${config.founderInterfaceApiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        monthlyLimitMicrousd: 1_000_000,
        perWorkLimitMicrousd: 500_000,
        maxAiTier: 2,
        enabled: true,
      }),
    });

    assert.equal(response.status, 403);
    assert.equal(store.policies.length, 0);
  });
});

test("founder may set policy but may not authorize execution budget", async () => {
  await withServer(async (baseUrl, store) => {
    const policyResponse = await fetch(
      `${baseUrl}/v1/projects/project-1/ai-budget-policy`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${config.founderApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          monthlyLimitMicrousd: 1_000_000,
          perWorkLimitMicrousd: 500_000,
          maxAiTier: 2,
          enabled: true,
        }),
      },
    );
    assert.equal(policyResponse.status, 200);
    assert.equal(store.policies[0]?.actor.type, "FOUNDER");

    const decisionResponse = await fetch(
      `${baseUrl}/v1/work-queue/work-1/budget-decisions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.founderApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          executionClass: "DETERMINISTIC",
          estimatedMaxCostMicrousd: 0,
        }),
      },
    );
    assert.equal(decisionResponse.status, 403);
    assert.equal(store.decisions.length, 0);
  });
});

test("internal service may authorize exact-state work budget and settle cost", async () => {
  await withServer(async (baseUrl, store) => {
    const decisionResponse = await fetch(
      `${baseUrl}/v1/work-queue/work-1/budget-decisions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.internalApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          executionClass: "AI_TIER_2",
          estimatedMaxCostMicrousd: 250_000,
        }),
      },
    );
    assert.equal(decisionResponse.status, 201);
    assert.equal(store.decisions[0]?.actor.type, "SYSTEM");

    const settlementResponse = await fetch(
      `${baseUrl}/v1/execution-attempts/attempt-1/budget-settlement`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.internalApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ actualCostMicrousd: 100_000 }),
      },
    );
    assert.equal(settlementResponse.status, 200);
    assert.equal(store.settlements[0]?.actualCostMicrousd, 100_000);
  });
});
