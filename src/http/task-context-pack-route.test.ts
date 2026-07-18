import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AppConfig } from "../config.js";
import type {
  CreateTaskContextPackInput,
  TaskContextPackStore,
} from "../store/task-context-pack-types.js";
import { attachTaskContextPackRoute } from "./task-context-pack-route.js";

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

class FakeTaskContextPackStore implements TaskContextPackStore {
  public creates: CreateTaskContextPackInput[] = [];
  public reads: string[] = [];
  public existing: Record<string, unknown> | null = {
    id: "pack-1",
    content_hash: "a".repeat(64),
  };

  public async createTaskContextPack(
    input: CreateTaskContextPackInput,
  ): Promise<Record<string, unknown>> {
    this.creates.push(input);
    return this.existing ?? {};
  }

  public async getTaskContextPack(
    executionAttemptId: string,
  ): Promise<Record<string, unknown> | null> {
    this.reads.push(executionAttemptId);
    return this.existing;
  }

  public async getProjectTaskContextPackStatus(): Promise<
    Record<string, unknown>
  > {
    return {};
  }

  public async getPlatformTaskContextPackStatus(): Promise<
    Record<string, unknown>
  > {
    return {};
  }
}

async function withServer(
  operation: (baseUrl: string, store: FakeTaskContextPackStore) => Promise<void>,
): Promise<void> {
  const store = new FakeTaskContextPackStore();
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  attachTaskContextPackRoute(server, config, store);

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

test("founder and founder-interface credentials cannot access Task Context Packs", async () => {
  await withServer(async (baseUrl, store) => {
    for (const token of [config.founderApiToken, config.founderInterfaceApiToken]) {
      const response = await fetch(
        `${baseUrl}/v1/execution-attempts/attempt-1/task-context-pack`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      assert.equal(response.status, 403);
    }
    assert.equal(store.reads.length, 0);
  });
});

test("internal service can create a pack with explicit repository snapshot", async () => {
  await withServer(async (baseUrl, store) => {
    const response = await fetch(
      `${baseUrl}/v1/execution-attempts/attempt-1/task-context-pack`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.internalApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          leaseToken: "lease-token",
          baseBranch: "develop",
          baseCommitSha: "a".repeat(40),
          relevantPaths: ["src/b.ts", "src/a.ts"],
        }),
      },
    );

    assert.equal(response.status, 201);
    assert.equal(store.creates.length, 1);
    assert.equal(store.creates[0]?.actor.type, "SYSTEM");
    assert.deepEqual(store.creates[0]?.relevantPaths, ["src/b.ts", "src/a.ts"]);
  });
});

test("internal service can read an existing immutable pack", async () => {
  await withServer(async (baseUrl, store) => {
    const response = await fetch(
      `${baseUrl}/v1/execution-attempts/attempt-1/task-context-pack`,
      {
        headers: { authorization: `Bearer ${config.internalApiToken}` },
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), store.existing);
    assert.deepEqual(store.reads, ["attempt-1"]);
  });
});
