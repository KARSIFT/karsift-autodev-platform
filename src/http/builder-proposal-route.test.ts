import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AppConfig } from "../config.js";
import type { BuilderProposalService } from "../services/builder-proposal-service.js";
import type {
  BuilderProposalStore,
  ClaimBuilderProposalRunInput,
  ClaimBuilderProposalRunResult,
  CompleteBuilderProposalRunInput,
  FailBuilderProposalRunInput,
  PrepareBuilderProposalInput,
} from "../store/builder-proposal-types.js";
import { attachBuilderProposalRoute } from "./builder-proposal-route.js";

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

class FakeStore implements BuilderProposalStore {
  public prepared: PrepareBuilderProposalInput[] = [];
  public async prepareBuilderProposal(input: PrepareBuilderProposalInput) {
    this.prepared.push(input);
    return { run: { id: "proposal-run-1", status: "PREPARED" } };
  }
  public async claimBuilderProposalRun(
    _input: ClaimBuilderProposalRunInput,
  ): Promise<ClaimBuilderProposalRunResult> {
    return { claimed: false, run: {}, request: {} };
  }
  public async completeBuilderProposalRun(
    _input: CompleteBuilderProposalRunInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }
  public async failBuilderProposalRun(
    _input: FailBuilderProposalRunInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }
  public async getBuilderProposalRun(id: string) {
    return id === "missing" ? null : { id, status: "GENERATED" };
  }
  public async getProjectBuilderProposalStatus() {
    return { builderProposalCounts: [] };
  }
  public async getPlatformBuilderProposalStatus() {
    return { builderProposalCounts: [] };
  }
}

class FakeService {
  public generated: string[] = [];
  public async generate(input: { builderProposalRunId: string }) {
    this.generated.push(input.builderProposalRunId);
    return { id: input.builderProposalRunId, status: "GENERATED" };
  }
}

async function withServer(
  operation: (baseUrl: string, store: FakeStore, service: FakeService) => Promise<void>,
) {
  const store = new FakeStore();
  const service = new FakeService();
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  attachBuilderProposalRoute(
    server,
    config,
    store,
    service as unknown as BuilderProposalService,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await operation(`http://127.0.0.1:${address.port}`, store, service);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("founder credentials cannot prepare builder proposals", async () => {
  await withServer(async (baseUrl, store) => {
    const response = await fetch(`${baseUrl}/v1/builder-invocations/builder-1/proposals`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.founderApiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceReadContextRunId: "read-run-1" }),
    });
    assert.equal(response.status, 403);
    assert.equal(store.prepared.length, 0);
  });
});

test("internal service can prepare and generate a proposal", async () => {
  await withServer(async (baseUrl, store, service) => {
    const prepare = await fetch(`${baseUrl}/v1/builder-invocations/builder-1/proposals`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.internalApiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceReadContextRunId: "read-run-1" }),
    });
    assert.equal(prepare.status, 201);
    assert.equal(store.prepared[0]?.workspaceReadContextRunId, "read-run-1");

    const generate = await fetch(`${baseUrl}/v1/builder-proposal-runs/proposal-run-1/generate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.internalApiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ claimOwner: "ci", claimLeaseSeconds: 300 }),
    });
    assert.equal(generate.status, 200);
    assert.deepEqual(service.generated, ["proposal-run-1"]);
  });
});
