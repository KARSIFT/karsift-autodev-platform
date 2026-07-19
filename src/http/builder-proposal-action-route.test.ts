import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AppConfig } from "../config.js";
import type { BuilderProposalActionService } from "../services/builder-proposal-action-service.js";
import type {
  BuilderProposalActionStore,
  MarkBuilderProposalActionMaterializedInput,
  PrepareBuilderProposalActionInput,
  RefreshBuilderProposalActionInput,
} from "../store/builder-proposal-action-types.js";
import { attachBuilderProposalActionRoute } from "./builder-proposal-action-route.js";

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

class FakeStore implements BuilderProposalActionStore {
  public async prepareBuilderProposalAction(_input: PrepareBuilderProposalActionInput) {
    return {};
  }
  public async markBuilderProposalActionMaterialized(
    _input: MarkBuilderProposalActionMaterializedInput,
  ) {
    return {};
  }
  public async refreshBuilderProposalAction(_input: RefreshBuilderProposalActionInput) {
    return {};
  }
  public async getBuilderProposalActionRun(id: string) {
    return id === "missing" ? null : { id, status: "MATERIALIZED" };
  }
  public async getProjectBuilderProposalActionStatus(projectId: string) {
    return { projectId, states: [] };
  }
  public async getPlatformBuilderProposalActionStatus() {
    return { states: [] };
  }
}

class FakeService {
  public materialized: Array<{ builderProposalRunId: string; commandPolicyKey: string | null }> = [];
  public reconciled: string[] = [];

  public async authorizeAndMaterialize(input: {
    builderProposalRunId: string;
    commandPolicyKey: string | null;
  }) {
    this.materialized.push(input);
    return { id: "action-run-1", status: "MATERIALIZED" };
  }

  public async reconcile(input: { builderProposalActionRunId: string }) {
    this.reconciled.push(input.builderProposalActionRunId);
    return { id: input.builderProposalActionRunId, status: "SATISFIED" };
  }
}

async function withServer(
  operation: (baseUrl: string, service: FakeService) => Promise<void>,
) {
  const store = new FakeStore();
  const service = new FakeService();
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  attachBuilderProposalActionRoute(
    server,
    config,
    store,
    service as unknown as BuilderProposalActionService,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await operation(`http://127.0.0.1:${address.port}`, service);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("founder credentials cannot orchestrate proposal actions", async () => {
  await withServer(async (baseUrl, service) => {
    const response = await fetch(`${baseUrl}/v1/builder-proposal-runs/proposal-run-1/actions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.founderApiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ commandPolicyKey: "default" }),
    });
    assert.equal(response.status, 403);
    assert.equal(service.materialized.length, 0);
  });
});

test("internal service can materialize and reconcile proposal actions", async () => {
  await withServer(async (baseUrl, service) => {
    const materialize = await fetch(
      `${baseUrl}/v1/builder-proposal-runs/proposal-run-1/actions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.internalApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ commandPolicyKey: "default" }),
      },
    );
    assert.equal(materialize.status, 201);
    assert.deepEqual(service.materialized, [
      { builderProposalRunId: "proposal-run-1", commandPolicyKey: "default" },
    ]);

    const reconcile = await fetch(
      `${baseUrl}/v1/builder-proposal-action-runs/action-run-1/reconcile`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${config.internalApiToken}` },
      },
    );
    assert.equal(reconcile.status, 200);
    assert.deepEqual(service.reconciled, ["action-run-1"]);
  });
});
