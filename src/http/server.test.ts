import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AppConfig } from "../config.js";
import type {
  FreshnessValidationStore,
  ValidateWorkQueueItemInput,
} from "../store/freshness-validation-types.js";
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
import type {
  ClaimExecutionLeaseInput,
  CompleteExecutionLeaseInput,
  CreateWorkQueueItemInput,
  HeartbeatExecutionLeaseInput,
  ReleaseExecutionLeaseInput,
  SetWorkQueueEligibilityInput,
  WorkQueueStore,
} from "../store/work-queue-types.js";
import { createControlPlaneServer } from "./server.js";

class FakeStore implements ControlPlaneStore, WorkQueueStore, FreshnessValidationStore {
  public lastDecision: CreateDecisionInput | null = null;
  public lastWorkQueueItem: CreateWorkQueueItemInput | null = null;
  public lastLeaseClaim: ClaimExecutionLeaseInput | null = null;
  public lastValidation: ValidateWorkQueueItemInput | null = null;

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

  public async createWorkQueueItem(
    input: CreateWorkQueueItemInput,
  ): Promise<Record<string, unknown>> {
    this.lastWorkQueueItem = input;
    return { id: "work-item-1", status: "QUEUED" };
  }

  public async setWorkQueueEligibility(
    _input: SetWorkQueueEligibilityInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async claimExecutionLease(
    input: ClaimExecutionLeaseInput,
  ): Promise<Record<string, unknown> | null> {
    this.lastLeaseClaim = input;
    return { executionAttempt: { id: "attempt-1" } };
  }

  public async heartbeatExecutionLease(
    _input: HeartbeatExecutionLeaseInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async completeExecutionLease(
    _input: CompleteExecutionLeaseInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async releaseExecutionLease(
    _input: ReleaseExecutionLeaseInput,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async getProjectQueueStatus(
    _projectId: string,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async getPlatformQueueStatus(): Promise<Record<string, unknown>> {
    return {};
  }

  public async validateWorkQueueItem(
    input: ValidateWorkQueueItemInput,
  ): Promise<Record<string, unknown>> {
    this.lastValidation = input;
    return { validation: { outcome: "VALID" }, workItem: { status: "ELIGIBLE" } };
  }

  public async getProjectValidationStatus(
    _projectId: string,
  ): Promise<Record<string, unknown>> {
    return {};
  }

  public async getPlatformValidationStatus(): Promise<Record<string, unknown>> {
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
  publicBaseUrl: "https://control.example.com",
  internalApiToken: "internal-token-that-is-at-least-32-characters",
  internalServiceId: "control-plane",
  founderApiToken: "founder-token-that-is-at-least-32-characters!",
  founderInterfaceApiToken:
    "founder-interface-token-that-is-at-least-32-characters",
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

test("OpenAPI document is self-describing and does not require authentication", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/openapi.json`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      servers: Array<{ url: string }>;
      paths: Record<string, unknown>;
    };
    assert.deepEqual(body.servers, [{ url: config.publicBaseUrl }]);
    assert.deepEqual(Object.keys(body.paths).sort(), [
      "/v1/projects/{projectId}/requests",
      "/v1/projects/{projectId}/status",
      "/v1/status",
    ]);
  });
});

test("founder interface token can read platform and project status", async () => {
  await withServer(async (baseUrl) => {
    const headers = {
      authorization: `Bearer ${config.founderInterfaceApiToken}`,
    };

    const platformResponse = await fetch(`${baseUrl}/v1/status`, { headers });
    assert.equal(platformResponse.status, 200);

    const projectResponse = await fetch(
      `${baseUrl}/v1/projects/project-1/status`,
      { headers },
    );
    assert.equal(projectResponse.status, 200);
  });
});

test("founder interface token can create a durable founder request", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/v1/projects/project-1/requests`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.founderInterfaceApiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Build the next governed slice",
          body: "Please record this request without executing it.",
        }),
      },
    );

    assert.equal(response.status, 201);
  });
});

test("founder interface token is blocked from execution and governance routes", async () => {
  await withServer(async (baseUrl, store) => {
    const headers = {
      authorization: `Bearer ${config.founderInterfaceApiToken}`,
      "content-type": "application/json",
    };

    const attempts = [
      ["/v1/projects", { slug: "x", name: "x", repositoryFullName: "KARSIFT/x" }],
      [
        "/v1/projects/project-1/decisions",
        { decisionType: "STRATEGY", summary: "No", authorityLevel: "R4" },
      ],
      [
        "/v1/projects/project-1/change-contracts",
        { stableId: "ADP-X", content: {} },
      ],
      [
        "/v1/change-contracts/contract-1/versions",
        { content: {} },
      ],
      [
        "/v1/projects/project-1/tasks",
        {
          changeContractVersionId: "version-1",
          title: "Task",
          description: "Task",
        },
      ],
      [
        "/v1/projects/project-1/workflow-runs",
        { workflowType: "BUILD" },
      ],
      [
        "/v1/projects/project-1/work-queue",
        { taskId: "task-1", idempotencyKey: "project-1:task-1" },
      ],
      [
        "/v1/work-queue/work-item-1/validate",
        {},
      ],
      [
        "/v1/workflow-runs/run-1/transition",
        { expectedStateVersion: 0, targetStatus: "RUNNING" },
      ],
      [
        "/v1/capabilities/AI_DISPATCH/disable",
        { reason: "Not allowed through founder interface" },
      ],
    ] as const;

    for (const [path, body] of attempts) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 403, path);
    }

    assert.equal(store.lastDecision, null);
  });
});

test("internal service can queue work and claim a lease without AI dispatch", async () => {
  await withServer(async (baseUrl, store) => {
    const headers = {
      authorization: `Bearer ${config.internalApiToken}`,
      "content-type": "application/json",
    };

    const queueResponse = await fetch(
      `${baseUrl}/v1/projects/project-1/work-queue`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          taskId: "task-1",
          priority: "P1",
          executionPolicy: "IMMEDIATE",
          idempotencyKey: "project-1:task-1",
        }),
      },
    );
    assert.equal(queueResponse.status, 201);
    assert.equal(store.lastWorkQueueItem?.executionPolicy, "IMMEDIATE");

    const validationResponse = await fetch(
      `${baseUrl}/v1/work-queue/work-item-1/validate`,
      { method: "POST", headers, body: JSON.stringify({}) },
    );
    assert.equal(validationResponse.status, 200);
    assert.equal(store.lastValidation?.workQueueItemId, "work-item-1");

    const claimResponse = await fetch(`${baseUrl}/v1/execution-leases/claim`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectId: "project-1",
        leaseOwner: "ci-worker",
        leaseSeconds: 300,
      }),
    });
    assert.equal(claimResponse.status, 200);
    assert.equal(store.lastLeaseClaim?.leaseOwner, "ci-worker");
  });
});
