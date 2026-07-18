import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AppConfig } from "../config.js";
import type { WorkspaceCommandService } from "../services/workspace-command-service.js";
import type {
  ClaimWorkspaceCommandRunResult,
  CompleteWorkspaceCommandRunInput,
  CreateWorkspaceCommandPolicyInput,
  PrepareWorkspaceCommandInput,
  WorkspaceCommandStore,
} from "../store/workspace-command-types.js";
import type { Actor } from "../store/types.js";
import { attachWorkspaceCommandRoute } from "./workspace-command-route.js";

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

class FakeWorkspaceCommandStore implements WorkspaceCommandStore {
  public policies: CreateWorkspaceCommandPolicyInput[] = [];
  public prepared: PrepareWorkspaceCommandInput[] = [];

  public async createWorkspaceCommandPolicy(
    input: CreateWorkspaceCommandPolicyInput,
  ): Promise<Record<string, unknown>> {
    this.policies.push(input);
    return { id: "policy-1", policy_hash: "a".repeat(64) };
  }

  public async prepareWorkspaceCommand(
    input: PrepareWorkspaceCommandInput,
  ): Promise<Record<string, unknown>> {
    this.prepared.push(input);
    return { run: { id: "run-1", status: "PREPARED" } };
  }

  public async claimWorkspaceCommandRun(
    _workspaceCommandRunId: string,
    _actor: Actor,
  ): Promise<ClaimWorkspaceCommandRunResult> {
    return { claimed: false, run: {}, plan: {} };
  }

  public async completeWorkspaceCommandRun(
    _input: CompleteWorkspaceCommandRunInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async getWorkspaceCommandRun(
    workspaceCommandRunId: string,
  ): Promise<Record<string, unknown> | null> {
    return workspaceCommandRunId === "missing"
      ? null
      : { id: workspaceCommandRunId, status: "SUCCEEDED" };
  }

  public async getProjectWorkspaceCommandStatus(): Promise<Record<string, unknown>> {
    return { workspaceCommandCounts: [] };
  }

  public async getPlatformWorkspaceCommandStatus(): Promise<Record<string, unknown>> {
    return { workspaceCommandCounts: [] };
  }
}

class FakeWorkspaceCommandService {
  public runIds: string[] = [];

  public async run(input: {
    workspaceCommandRunId: string;
  }): Promise<Record<string, unknown>> {
    this.runIds.push(input.workspaceCommandRunId);
    return { id: input.workspaceCommandRunId, status: "SUCCEEDED" };
  }
}

async function withServer(
  operation: (
    baseUrl: string,
    store: FakeWorkspaceCommandStore,
    service: FakeWorkspaceCommandService,
  ) => Promise<void>,
): Promise<void> {
  const store = new FakeWorkspaceCommandStore();
  const service = new FakeWorkspaceCommandService();
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  attachWorkspaceCommandRoute(
    server,
    config,
    store,
    service as unknown as WorkspaceCommandService,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await operation(`http://127.0.0.1:${address.port}`, store, service);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("founder credentials cannot create workspace command policies", async () => {
  await withServer(async (baseUrl, store) => {
    const response = await fetch(
      `${baseUrl}/v1/projects/project-1/workspace-command-policies`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.founderApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    assert.equal(response.status, 403);
    assert.equal(store.policies.length, 0);
  });
});

test("internal service can create a strict command policy", async () => {
  await withServer(async (baseUrl, store) => {
    const response = await fetch(
      `${baseUrl}/v1/projects/project-1/workspace-command-policies`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.internalApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          policyKey: "ci-safe",
          version: 1,
          enabled: true,
          purposes: ["INSPECT"],
          rules: [{ executable: "node", allowedArguments: [["--version"]] }],
          environmentAllowlist: [],
          maxTimeoutMs: 5000,
          maxOutputBytes: 4096,
          maxCommandsPerWorkspace: 3,
        }),
      },
    );
    assert.equal(response.status, 201);
    assert.equal(store.policies[0]?.policyKey, "ci-safe");
    assert.equal(store.policies[0]?.actor.type, "SYSTEM");
  });
});

test("internal service can prepare and run an approved workspace command", async () => {
  await withServer(async (baseUrl, store, service) => {
    const prepareResponse = await fetch(
      `${baseUrl}/v1/repository-workspaces/workspace-1/commands`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.internalApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          policyKey: "ci-safe",
          purpose: "INSPECT",
          executable: "node",
          arguments: ["--version"],
          timeoutMs: 5000,
          maxOutputBytes: 4096,
          environment: {},
        }),
      },
    );
    assert.equal(prepareResponse.status, 201);
    assert.equal(store.prepared[0]?.repositoryWorkspaceId, "workspace-1");

    const runResponse = await fetch(`${baseUrl}/v1/workspace-command-runs/run-1/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.internalApiToken}` },
    });
    assert.equal(runResponse.status, 200);
    assert.deepEqual(service.runIds, ["run-1"]);
  });
});
