import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AppConfig } from "../config.js";
import type {
  Actor,
  AppendChangeContractVersionInput,
  ControlPlaneStore,
  CreateChangeContractInput,
  CreateDecisionInput,
  CreateFounderRequestInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateWorkflowRunInput,
  DisableCapabilityInput,
  TransitionWorkflowRunInput,
} from "../store/types.js";
import { createControlPlaneServer } from "./server.js";

class FakeStore implements ControlPlaneStore {
  public lastDecision: CreateDecisionInput | null = null;

  public async ping(): Promise<void> {}

  public async createProject(
    _input: CreateProjectInput,
    _actor: Actor,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async createFounderRequest(
    _input: CreateFounderRequestInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async createDecision(
    input: CreateDecisionInput,
  ): Promise<Record<string, unknown>> {
    this.lastDecision = input;
    return { id: "decision-1" };
  }

  public async createChangeContract(
    _input: CreateChangeContractInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async appendChangeContractVersion(
    _input: AppendChangeContractVersionInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async createTask(
    _input: CreateTaskInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async createWorkflowRun(
    _input: CreateWorkflowRunInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async transitionWorkflowRun(
    _input: TransitionWorkflowRunInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async listCapabilities(
    _projectId: string | null,
  ): Promise<readonly Record<string, unknown>[]> {
    return [];
  }

  public async disableCapability(
    _input: DisableCapabilityInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async getProjectStatus(
    _projectId: string,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async getPlatformStatus(): Promise<Record<string, unknown>> {
    return { activationLevel: "A1" };
  }
}

const config: AppConfig = {
  host: "127.0.0.1",
  port: 0,
  internalApiToken: "internal-token-that-is-at-least-32-characters",
  internalServiceId: "control-plane",
  founderApiToken: "founder-token-that-is-at-least-32-characters!",
  founderId: "founder-1",
  databaseUrl: "postgres://unused",
};

async function withServer(
  operation: (baseUrl: string, store: FakeStore) => Promise<void>,
): Promise<void> {
  const store = new FakeStore();
  const server = createControlPlaneServer(config, store);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  try {
    await operation(`http://127.0.0.1:${address.port}`, store);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

test("v1 routes reject missing authentication", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/status`);
    assert.equal(response.status, 401);
  });
});

test("internal service token cannot record R4 founder decisions", async () => {
  await withServer(async (baseUrl, store) => {
    const response = await fetch(
      `${baseUrl}/v1/projects/project-1/decisions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.internalApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          decisionType: "STRATEGY",
          summary: "Major strategic decision",
          authorityLevel: "R4",
        }),
      },
    );

    assert.equal(response.status, 403);
    assert.equal(store.lastDecision, null);
  });
});

test("founder token records R4 decisions with founder authority", async () => {
  await withServer(async (baseUrl, store) => {
    const response = await fetch(
      `${baseUrl}/v1/projects/project-1/decisions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.founderApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          decisionType: "STRATEGY",
          summary: "Major strategic decision",
          authorityLevel: "R4",
        }),
      },
    );

    assert.equal(response.status, 201);
    assert.equal(store.lastDecision?.actor.type, "FOUNDER");
    assert.equal(store.lastDecision?.actor.id, "founder-1");
  });
});
