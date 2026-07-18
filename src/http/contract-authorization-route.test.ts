import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AppConfig } from "../config.js";
import type {
  ContractAuthorizationResult,
  ContractAuthorizationStore,
  RecordChangeContractAuthorizationInput,
} from "../store/contract-authorization-types.js";
import { attachContractAuthorizationRoute } from "./contract-authorization-route.js";

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

class FakeAuthorizationStore implements ContractAuthorizationStore {
  public calls: RecordChangeContractAuthorizationInput[] = [];
  public nextResult: ContractAuthorizationResult = {
    authorized: true,
    decision: { decision: "AUTHORIZED" },
  };

  public async recordChangeContractAuthorization(
    input: RecordChangeContractAuthorizationInput,
  ): Promise<ContractAuthorizationResult> {
    this.calls.push(input);
    return this.nextResult;
  }

  public async getProjectAuthorizationStatus(): Promise<Record<string, unknown>> {
    return {};
  }

  public async getPlatformAuthorizationStatus(): Promise<Record<string, unknown>> {
    return {};
  }
}

async function withServer(
  operation: (baseUrl: string, store: FakeAuthorizationStore) => Promise<void>,
): Promise<void> {
  const store = new FakeAuthorizationStore();
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  attachContractAuthorizationRoute(server, config, store);

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

test("founder-interface credential cannot change Change Contract authority", async () => {
  await withServer(async (baseUrl, store) => {
    const response = await fetch(
      `${baseUrl}/v1/change-contracts/contract-1/authorization-decisions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.founderInterfaceApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "AUTHORIZE" }),
      },
    );

    assert.equal(response.status, 403);
    assert.equal(store.calls.length, 0);
  });
});

test("policy denial is returned as 403 after durable decision recording", async () => {
  await withServer(async (baseUrl, store) => {
    store.nextResult = {
      authorized: false,
      decision: {
        decision: "DENIED",
        reason_code: "FOUNDER_AUTHORITY_REQUIRED",
      },
    };

    const response = await fetch(
      `${baseUrl}/v1/change-contracts/contract-1/authorization-decisions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.internalApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "AUTHORIZE", rationale: "test" }),
      },
    );

    assert.equal(response.status, 403);
    assert.equal(store.calls.length, 1);
    assert.equal(store.calls[0]?.actor.type, "SYSTEM");
  });
});

test("founder credential can submit governed authorization decisions", async () => {
  await withServer(async (baseUrl, store) => {
    const response = await fetch(
      `${baseUrl}/v1/change-contracts/contract-1/authorization-decisions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.founderApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "AUTHORIZE" }),
      },
    );

    assert.equal(response.status, 201);
    assert.equal(store.calls[0]?.actor.type, "FOUNDER");
  });
});
