import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AppConfig } from "../config.js";
import type {
  EvaluateProviderDispatchInput,
  ProviderDispatchStore,
  RecordProviderCapacityObservationInput,
  UpsertProviderRoutingPolicyInput,
} from "../store/provider-dispatch-types.js";
import { attachProviderDispatchRoute } from "./provider-dispatch-route.js";

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

class FakeProviderDispatchStore implements ProviderDispatchStore {
  public policies: UpsertProviderRoutingPolicyInput[] = [];
  public observations: RecordProviderCapacityObservationInput[] = [];
  public decisions: EvaluateProviderDispatchInput[] = [];

  public async upsertProviderRoutingPolicy(
    input: UpsertProviderRoutingPolicyInput,
  ): Promise<Record<string, unknown>> {
    this.policies.push(input);
    return { project_id: input.projectId, version: 1 };
  }

  public async recordProviderCapacityObservation(
    input: RecordProviderCapacityObservationInput,
  ): Promise<Record<string, unknown>> {
    this.observations.push(input);
    return { project_id: input.projectId, status: input.status };
  }

  public async evaluateProviderDispatch(
    input: EvaluateProviderDispatchInput,
  ): Promise<Record<string, unknown>> {
    this.decisions.push(input);
    return { outcome: "READY", waiting_reason: "NONE" };
  }

  public async getProjectProviderDispatchStatus(): Promise<Record<string, unknown>> {
    return {};
  }

  public async getPlatformProviderDispatchStatus(): Promise<Record<string, unknown>> {
    return {};
  }
}

async function withServer(
  operation: (baseUrl: string, store: FakeProviderDispatchStore) => Promise<void>,
): Promise<void> {
  const store = new FakeProviderDispatchStore();
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  attachProviderDispatchRoute(server, config, store);

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

test("founder-interface credential cannot manage provider dispatch gates", async () => {
  await withServer(async (baseUrl, store) => {
    const response = await fetch(
      `${baseUrl}/v1/projects/project-1/provider-routing-policies`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${config.founderInterfaceApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          executionClass: "AI_TIER_2",
          capability: "CODE_BUILDER",
          providerKeys: ["primary-builder"],
          enabled: true,
        }),
      },
    );

    assert.equal(response.status, 403);
    assert.equal(store.policies.length, 0);
  });
});

test("founder may configure routing but may not record capacity", async () => {
  await withServer(async (baseUrl, store) => {
    const policyResponse = await fetch(
      `${baseUrl}/v1/projects/project-1/provider-routing-policies`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${config.founderApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          executionClass: "AI_TIER_2",
          capability: "CODE_BUILDER",
          providerKeys: ["primary-builder", "fallback-builder"],
          enabled: true,
        }),
      },
    );
    assert.equal(policyResponse.status, 200);
    assert.equal(store.policies[0]?.actor.type, "FOUNDER");
    assert.deepEqual(store.policies[0]?.providerKeys, [
      "primary-builder",
      "fallback-builder",
    ]);

    const observationResponse = await fetch(
      `${baseUrl}/v1/projects/project-1/provider-capacity-observations`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.founderApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providerKey: "primary-builder",
          capability: "CODE_BUILDER",
          status: "HEALTHY",
          ttlSeconds: 300,
        }),
      },
    );
    assert.equal(observationResponse.status, 403);
    assert.equal(store.observations.length, 0);
  });
});

test("internal service may record capacity and evaluate dispatch readiness", async () => {
  await withServer(async (baseUrl, store) => {
    const observationResponse = await fetch(
      `${baseUrl}/v1/projects/project-1/provider-capacity-observations`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.internalApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providerKey: "primary-builder",
          capability: "CODE_BUILDER",
          status: "QUOTA_EXHAUSTED",
          ttlSeconds: 300,
          quotaResetAt: "2026-07-19T00:00:00.000Z",
          details: { source: "ci" },
        }),
      },
    );
    assert.equal(observationResponse.status, 201);
    assert.equal(store.observations[0]?.actor.type, "SYSTEM");
    assert.equal(store.observations[0]?.status, "QUOTA_EXHAUSTED");

    const decisionResponse = await fetch(
      `${baseUrl}/v1/work-queue/work-1/provider-dispatch-decisions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.internalApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ capability: "CODE_BUILDER" }),
      },
    );
    assert.equal(decisionResponse.status, 201);
    assert.equal(store.decisions[0]?.workQueueItemId, "work-1");
    assert.equal(store.decisions[0]?.actor.type, "SYSTEM");
  });
});

test("routing policy rejects deterministic execution class at the HTTP boundary", async () => {
  await withServer(async (baseUrl, store) => {
    const response = await fetch(
      `${baseUrl}/v1/projects/project-1/provider-routing-policies`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${config.internalApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          executionClass: "DETERMINISTIC",
          capability: "CODE_BUILDER",
          providerKeys: ["primary-builder"],
          enabled: true,
        }),
      },
    );

    assert.equal(response.status, 400);
    assert.equal(store.policies.length, 0);
  });
});
