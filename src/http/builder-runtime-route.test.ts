import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { BuilderAdapterRegistry } from "../agents/builder-adapter.js";
import { DryRunBuilderAdapter } from "../agents/dry-run-builder-adapter.js";
import type { AppConfig } from "../config.js";
import { BuilderRuntimeService } from "../services/builder-runtime-service.js";
import type {
  BuilderRuntimeStore,
  CompleteBuilderInvocationInput,
  PrepareBuilderInvocationInput,
  StartBuilderInvocationInput,
} from "../store/builder-runtime-types.js";
import { attachBuilderRuntimeRoute } from "./builder-runtime-route.js";

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

class FakeBuilderRuntimeStore implements BuilderRuntimeStore {
  public prepared: PrepareBuilderInvocationInput[] = [];
  public started: StartBuilderInvocationInput[] = [];
  public completed: CompleteBuilderInvocationInput[] = [];

  public async prepareBuilderInvocation(
    input: PrepareBuilderInvocationInput,
  ): Promise<Record<string, unknown>> {
    this.prepared.push(input);
    return {
      plan: { id: "plan-1" },
      invocation: { id: "invocation-1", status: "PREPARED" },
    };
  }

  public async startBuilderInvocation(
    input: StartBuilderInvocationInput,
  ): Promise<Record<string, unknown>> {
    this.started.push(input);
    return {
      invocation: { id: input.builderInvocationId, status: "RUNNING" },
      plan: {
        adapter_key: "dry-run",
        side_effect_mode: "NONE",
        plan_hash: "a".repeat(64),
        task_context_pack_hash: "b".repeat(64),
        provider_key: "dry-run-builder",
        max_turns: 1,
        retry_budget: 0,
        command_budget: 0,
        timeout_seconds: 30,
      },
    };
  }

  public async completeBuilderInvocation(
    input: CompleteBuilderInvocationInput,
  ): Promise<Record<string, unknown>> {
    this.completed.push(input);
    return {
      invocation: { id: input.builderInvocationId, status: input.result.outcome },
      result: input.result,
    };
  }

  public async getBuilderInvocation(
    builderInvocationId: string,
  ): Promise<Record<string, unknown> | null> {
    return builderInvocationId === "missing"
      ? null
      : { id: builderInvocationId, status: "SUCCEEDED" };
  }

  public async getProjectBuilderRuntimeStatus(): Promise<Record<string, unknown>> {
    return {};
  }

  public async getPlatformBuilderRuntimeStatus(): Promise<Record<string, unknown>> {
    return {};
  }
}

async function withServer(
  operation: (baseUrl: string, store: FakeBuilderRuntimeStore) => Promise<void>,
): Promise<void> {
  const store = new FakeBuilderRuntimeStore();
  const service = new BuilderRuntimeService(
    store,
    new BuilderAdapterRegistry([new DryRunBuilderAdapter()]),
  );
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  attachBuilderRuntimeRoute(server, config, store, service);

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

test("founder credentials cannot operate the builder runtime", async () => {
  await withServer(async (baseUrl, store) => {
    const response = await fetch(
      `${baseUrl}/v1/execution-attempts/attempt-1/builder-invocations`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.founderApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          leaseToken: "lease-token",
          maxTurns: 1,
          retryBudget: 0,
          commandBudget: 0,
          timeoutSeconds: 30,
        }),
      },
    );
    assert.equal(response.status, 403);
    assert.equal(store.prepared.length, 0);
  });
});

test("internal service can prepare a bounded builder invocation", async () => {
  await withServer(async (baseUrl, store) => {
    const response = await fetch(
      `${baseUrl}/v1/execution-attempts/attempt-1/builder-invocations`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.internalApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          leaseToken: "lease-token",
          maxTurns: 2,
          retryBudget: 1,
          commandBudget: 10,
          timeoutSeconds: 60,
        }),
      },
    );
    assert.equal(response.status, 201);
    assert.equal(store.prepared.length, 1);
    assert.deepEqual(store.prepared[0]?.limits, {
      maxTurns: 2,
      retryBudget: 1,
      commandBudget: 10,
      timeoutSeconds: 60,
    });
  });
});

test("internal dry-run execution uses the adapter lifecycle without side effects", async () => {
  await withServer(async (baseUrl, store) => {
    const response = await fetch(
      `${baseUrl}/v1/builder-invocations/invocation-1/run-dry-run`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${config.internalApiToken}` },
      },
    );
    assert.equal(response.status, 200);
    assert.equal(store.started.length, 1);
    assert.equal(store.completed.length, 1);
    assert.equal(store.completed[0]?.result.outcome, "SUCCEEDED");
    assert.deepEqual(store.completed[0]?.result.evidence, {
      dryRun: true,
      externalProviderCalled: false,
      repositoryMutated: false,
      invocationId: "invocation-1",
      planHash: "a".repeat(64),
      taskContextPackHash: "b".repeat(64),
      providerKey: "dry-run-builder",
      limits: {
        maxTurns: 1,
        retryBudget: 0,
        commandBudget: 0,
        timeoutSeconds: 30,
      },
    });
  });
});
