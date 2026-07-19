import assert from "node:assert/strict";
import test from "node:test";

import { BuilderProposalActionService } from "./builder-proposal-action-service.js";
import type { BuilderProposal } from "../domain/builder-proposal.js";
import type { BuilderProposalActionStore } from "../store/builder-proposal-action-types.js";
import type { WorkspaceCommandStore } from "../store/workspace-command-types.js";
import type { WorkspaceMutationStore } from "../store/workspace-mutation-types.js";
import type { WorkspaceReadContextStore } from "../store/workspace-read-context-types.js";

const actor = {
  type: "SYSTEM" as const,
  id: "test",
  credentialKind: "INTERNAL" as const,
};

function proposal(action: BuilderProposal["action"]): BuilderProposal {
  return {
    action,
    summary: "fixture",
    requestedPaths: action === "REQUEST_CONTEXT" ? ["src/index.ts"] : [],
    commands:
      action === "REQUEST_COMMANDS"
        ? [{ purpose: "TEST", executable: "npm", arguments: ["test"] }]
        : [],
    mutations:
      action === "PROPOSE_MUTATIONS"
        ? [
            {
              type: "UPDATE",
              path: "src/index.ts",
              expectedBeforeHash: "a".repeat(64),
              content: "next",
            },
          ]
        : [],
    blockingReason: action === "BLOCKED" ? "blocked" : null,
  };
}

function harness(action: BuilderProposal["action"]) {
  const commandCalls: unknown[] = [];
  const mutationCalls: unknown[] = [];
  const contextCalls: unknown[] = [];
  let materializedEntities: unknown[] = [];
  const actionStore = {
    async prepareBuilderProposalAction() {
      return {
        decision: { repository_workspace_id: "workspace-1" },
        run: { id: "action-run-1", status: "PREPARED" },
        proposal: proposal(action),
        commandPolicy:
          action === "REQUEST_COMMANDS"
            ? { max_timeout_ms: 10_000, max_output_bytes: 20_000 }
            : null,
      };
    },
    async markBuilderProposalActionMaterialized(input: { materializedEntities: unknown[] }) {
      materializedEntities = input.materializedEntities;
      return { id: "action-run-1", status: "MATERIALIZED" };
    },
    async refreshBuilderProposalAction() {
      return {
        id: "action-run-1",
        status: action === "COMPLETE" || action === "BLOCKED" ? "SATISFIED" : "MATERIALIZED",
        materialized_entities: materializedEntities,
      };
    },
  } as unknown as BuilderProposalActionStore;
  const commandStore = {
    async prepareWorkspaceCommand(input: unknown) {
      commandCalls.push(input);
      return { plan: { id: "command-plan-1" }, run: { id: "command-run-1" } };
    },
  } as unknown as WorkspaceCommandStore;
  const mutationStore = {
    async prepareWorkspaceMutation(input: unknown) {
      mutationCalls.push(input);
      return { plan: { id: "mutation-plan-1" }, run: { id: "mutation-run-1" } };
    },
  } as unknown as WorkspaceMutationStore;
  const readContextStore = {
    async prepareWorkspaceReadContext(input: unknown) {
      contextCalls.push(input);
      return { request: { id: "context-request-1" }, run: { id: "context-run-1" } };
    },
  } as unknown as WorkspaceReadContextStore;
  return {
    service: new BuilderProposalActionService(
      actionStore,
      commandStore,
      mutationStore,
      readContextStore,
    ),
    commandCalls,
    mutationCalls,
    contextCalls,
  };
}

for (const action of ["COMPLETE", "BLOCKED"] as const) {
  test(`${action} creates no destination subsystem work`, async () => {
    const state = harness(action);
    const result = await state.service.authorizeAndMaterialize({
      builderProposalRunId: "proposal-run-1",
      commandPolicyKey: null,
      actor,
    });
    assert.equal(result.status, "SATISFIED");
    assert.equal(state.commandCalls.length, 0);
    assert.equal(state.mutationCalls.length, 0);
    assert.equal(state.contextCalls.length, 0);
  });
}

test("REQUEST_CONTEXT materializes only a read-context request", async () => {
  const state = harness("REQUEST_CONTEXT");
  await state.service.authorizeAndMaterialize({
    builderProposalRunId: "proposal-run-1",
    commandPolicyKey: null,
    actor,
  });
  assert.equal(state.contextCalls.length, 1);
  assert.equal(state.commandCalls.length, 0);
  assert.equal(state.mutationCalls.length, 0);
});

test("REQUEST_COMMANDS materializes policy-bounded command plans without running them", async () => {
  const state = harness("REQUEST_COMMANDS");
  await state.service.authorizeAndMaterialize({
    builderProposalRunId: "proposal-run-1",
    commandPolicyKey: "default",
    actor,
  });
  assert.equal(state.commandCalls.length, 1);
  assert.equal(state.contextCalls.length, 0);
  assert.equal(state.mutationCalls.length, 0);
  const call = state.commandCalls[0] as Record<string, unknown>;
  assert.equal(call.timeoutMs, 10_000);
  assert.equal(call.maxOutputBytes, 20_000);
  assert.deepEqual(call.environment, {});
});

test("PROPOSE_MUTATIONS materializes only a structured mutation plan", async () => {
  const state = harness("PROPOSE_MUTATIONS");
  await state.service.authorizeAndMaterialize({
    builderProposalRunId: "proposal-run-1",
    commandPolicyKey: null,
    actor,
  });
  assert.equal(state.mutationCalls.length, 1);
  assert.equal(state.contextCalls.length, 0);
  assert.equal(state.commandCalls.length, 0);
});
