import type { BuilderProposalActionMaterializedEntity } from "../domain/builder-proposal-action.js";
import type { BuilderProposal, BuilderProposedCommand } from "../domain/builder-proposal.js";
import type { BuilderProposalActionStore } from "../store/builder-proposal-action-types.js";
import type { WorkspaceCommandStore } from "../store/workspace-command-types.js";
import type { WorkspaceMutationStore } from "../store/workspace-mutation-types.js";
import type { WorkspaceReadContextStore } from "../store/workspace-read-context-types.js";
import type { Actor } from "../store/types.js";

function recordField(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Builder proposal action response ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Builder proposal action response ${field} must be a non-empty string`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Builder proposal action response ${field} must be a positive integer`);
  }
  return value;
}

export class BuilderProposalActionService {
  public constructor(
    private readonly actionStore: BuilderProposalActionStore,
    private readonly commandStore: WorkspaceCommandStore,
    private readonly mutationStore: WorkspaceMutationStore,
    private readonly readContextStore: WorkspaceReadContextStore,
  ) {}

  public async authorizeAndMaterialize(input: {
    readonly builderProposalRunId: string;
    readonly commandPolicyKey: string | null;
    readonly actor: Actor;
  }): Promise<Record<string, unknown>> {
    const prepared = await this.actionStore.prepareBuilderProposalAction(input);
    const actionRun = recordField(prepared.run, "run");
    if (actionRun.status === "SATISFIED") {
      return prepared;
    }
    if (actionRun.status === "MATERIALIZED") {
      return await this.actionStore.refreshBuilderProposalAction({
        builderProposalActionRunId: requiredString(actionRun.id, "run.id"),
        actor: input.actor,
      });
    }

    const decision = recordField(prepared.decision, "decision");
    const proposal = recordField(prepared.proposal, "proposal") as unknown as BuilderProposal;
    const actionRunId = requiredString(actionRun.id, "run.id");
    const repositoryWorkspaceId = requiredString(
      decision.repository_workspace_id,
      "decision.repository_workspace_id",
    );
    const entities: BuilderProposalActionMaterializedEntity[] = [];

    switch (proposal.action) {
      case "COMPLETE":
      case "BLOCKED":
        break;
      case "REQUEST_CONTEXT": {
        const preparedContext = await this.readContextStore.prepareWorkspaceReadContext({
          repositoryWorkspaceId,
          requestedPaths: proposal.requestedPaths,
          actor: input.actor,
        });
        const request = recordField(preparedContext.request, "readContext.request");
        const run = recordField(preparedContext.run, "readContext.run");
        entities.push({
          kind: "WORKSPACE_READ_CONTEXT",
          ordinal: 0,
          recordId: requiredString(request.id, "readContext.request.id"),
          runId: requiredString(run.id, "readContext.run.id"),
        });
        break;
      }
      case "REQUEST_COMMANDS": {
        if (!input.commandPolicyKey) {
          throw new Error("commandPolicyKey is required for REQUEST_COMMANDS proposals");
        }
        const policy = recordField(prepared.commandPolicy, "commandPolicy");
        const timeoutMs = requiredPositiveInteger(policy.max_timeout_ms, "commandPolicy.max_timeout_ms");
        const maxOutputBytes = requiredPositiveInteger(
          policy.max_output_bytes,
          "commandPolicy.max_output_bytes",
        );
        for (const [ordinal, command] of proposal.commands.entries()) {
          const preparedCommand = await this.prepareCommand({
            repositoryWorkspaceId,
            commandPolicyKey: input.commandPolicyKey,
            command,
            timeoutMs,
            maxOutputBytes,
            actor: input.actor,
          });
          const plan = recordField(preparedCommand.plan, "command.plan");
          const run = recordField(preparedCommand.run, "command.run");
          entities.push({
            kind: "WORKSPACE_COMMAND",
            ordinal,
            recordId: requiredString(plan.id, "command.plan.id"),
            runId: requiredString(run.id, "command.run.id"),
          });
        }
        break;
      }
      case "PROPOSE_MUTATIONS": {
        const preparedMutation = await this.mutationStore.prepareWorkspaceMutation({
          repositoryWorkspaceId,
          operations: proposal.mutations,
          actor: input.actor,
        });
        const plan = recordField(preparedMutation.plan, "mutation.plan");
        const run = recordField(preparedMutation.run, "mutation.run");
        entities.push({
          kind: "WORKSPACE_MUTATION",
          ordinal: 0,
          recordId: requiredString(plan.id, "mutation.plan.id"),
          runId: requiredString(run.id, "mutation.run.id"),
        });
        break;
      }
    }

    await this.actionStore.markBuilderProposalActionMaterialized({
      builderProposalActionRunId: actionRunId,
      materializedEntities: entities,
      actor: input.actor,
    });
    return await this.actionStore.refreshBuilderProposalAction({
      builderProposalActionRunId: actionRunId,
      actor: input.actor,
    });
  }

  private async prepareCommand(input: {
    readonly repositoryWorkspaceId: string;
    readonly commandPolicyKey: string;
    readonly command: BuilderProposedCommand;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly actor: Actor;
  }): Promise<Record<string, unknown>> {
    return await this.commandStore.prepareWorkspaceCommand({
      repositoryWorkspaceId: input.repositoryWorkspaceId,
      policyKey: input.commandPolicyKey,
      purpose: input.command.purpose,
      executable: input.command.executable,
      arguments: input.command.arguments,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      environment: {},
      actor: input.actor,
    });
  }

  public async reconcile(input: {
    readonly builderProposalActionRunId: string;
    readonly actor: Actor;
  }): Promise<Record<string, unknown>> {
    return await this.actionStore.refreshBuilderProposalAction(input);
  }
}
