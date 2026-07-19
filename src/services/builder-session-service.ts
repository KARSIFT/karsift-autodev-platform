import type { BuilderProposalActionService } from "./builder-proposal-action-service.js";
import type { BuilderSessionProposalService } from "./builder-session-proposal-service.js";
import type { WorkspaceCommandService } from "./workspace-command-service.js";
import type { WorkspaceMutationService } from "./workspace-mutation-service.js";
import type { WorkspaceReadContextService } from "./workspace-read-context-service.js";
import type { BuilderSessionStepOperation } from "../domain/builder-session.js";
import type { BuilderProposalStore } from "../store/builder-proposal-types.js";
import type { BuilderSessionStore } from "../store/builder-session-types.js";
import type { WorkspaceCommandStore } from "../store/workspace-command-types.js";
import type { WorkspaceMutationStore } from "../store/workspace-mutation-types.js";
import type { WorkspaceReadContextStore } from "../store/workspace-read-context-types.js";
import type { Actor } from "../store/types.js";

function recordField(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Builder session response ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Builder session response ${field} must be a non-empty string`);
  }
  return value;
}

function numberField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Builder session response ${field} must be a non-negative integer`);
  }
  return value;
}

function materializedEntities(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error("Builder session action materialized entities must be an array");
  }
  return value.map((item) => recordField(item, "materialized entity"));
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Builder session response ${field} must be a string array`);
  }
  return value as string[];
}

export interface BuilderSessionStepResult {
  readonly acquired: boolean;
  readonly advanced: boolean;
  readonly operation: BuilderSessionStepOperation | null;
  readonly reason: string;
  readonly session: Record<string, unknown>;
}

export class BuilderSessionService {
  public constructor(
    private readonly sessionStore: BuilderSessionStore,
    private readonly proposalStore: BuilderProposalStore,
    private readonly proposalService: BuilderSessionProposalService,
    private readonly actionService: BuilderProposalActionService,
    private readonly commandStore: WorkspaceCommandStore,
    private readonly commandService: WorkspaceCommandService,
    private readonly mutationStore: WorkspaceMutationStore,
    private readonly mutationService: WorkspaceMutationService,
    private readonly readContextStore: WorkspaceReadContextStore,
    private readonly readContextService: WorkspaceReadContextService,
  ) {}

  public async prepare(input: {
    readonly builderInvocationId: string;
    readonly actor: Actor;
  }): Promise<Record<string, unknown>> {
    return await this.sessionStore.prepareBuilderSession(input);
  }

  public async step(input: {
    readonly builderSessionId: string;
    readonly claimOwner: string;
    readonly stepLeaseSeconds: number;
    readonly executionLeaseSeconds: number;
    readonly dispatchLeaseSeconds: number;
    readonly commandPolicyKey: string | null;
    readonly actor: Actor;
  }): Promise<BuilderSessionStepResult> {
    const acquired = await this.sessionStore.acquireBuilderSessionStepClaim({
      builderSessionId: input.builderSessionId,
      claimOwner: input.claimOwner,
      leaseSeconds: input.stepLeaseSeconds,
      actor: input.actor,
    });
    const session = recordField(acquired.session, "session");
    if (acquired.acquired !== true) {
      return {
        acquired: false,
        advanced: false,
        operation: null,
        reason: String(acquired.reason ?? "ALREADY_CLAIMED"),
        session,
      };
    }

    const claim = recordField(acquired.claim, "step claim");
    const stepClaimId = requiredString(claim.id, "step claim id");
    const stepClaimToken = requiredString(claim.claim_token, "step claim token");

    try {
      await this.sessionStore.heartbeatBuilderSessionExecutionLease({
        builderSessionId: input.builderSessionId,
        stepClaimId,
        stepClaimToken,
        leaseSeconds: input.executionLeaseSeconds,
        actor: input.actor,
      });
      const result = await this.advanceOne({
        ...input,
        stepClaimId,
        stepClaimToken,
      });
      await this.sessionStore.completeBuilderSessionStepClaim({
        builderSessionStepClaimId: stepClaimId,
        claimToken: stepClaimToken,
        operation: result.operation,
        actor: input.actor,
      });
      return result;
    } catch (error) {
      await this.sessionStore
        .releaseBuilderSessionStepClaim({
          builderSessionStepClaimId: stepClaimId,
          claimToken: stepClaimToken,
          actor: input.actor,
        })
        .catch(() => undefined);
      throw error;
    }
  }

  private async advanceOne(input: {
    readonly builderSessionId: string;
    readonly claimOwner: string;
    readonly dispatchLeaseSeconds: number;
    readonly commandPolicyKey: string | null;
    readonly actor: Actor;
    readonly stepClaimId: string;
    readonly stepClaimToken: string;
  }): Promise<BuilderSessionStepResult & { readonly operation: BuilderSessionStepOperation }> {
    const context = await this.sessionStore.getBuilderSessionStepContext(
      input.builderSessionId,
    );
    if (!context) {
      throw new Error(`Builder session not found: ${input.builderSessionId}`);
    }
    const status = String(context.status);

    if (status === "PREPARED") {
      const next = await this.sessionStore.transitionBuilderSession({
        builderSessionId: input.builderSessionId,
        stepClaimId: input.stepClaimId,
        stepClaimToken: input.stepClaimToken,
        expectedStatus: "PREPARED",
        nextStatus: "READY_FOR_TURN",
        actor: input.actor,
      });
      return this.result("START_SESSION", next);
    }

    if (status === "READY_FOR_TURN") {
      return await this.advanceReadyForTurn(input, context);
    }

    if (status === "WAITING_ACTION") {
      return await this.advanceWaitingAction(input, context);
    }

    if (status === "REFRESH_CONTEXT") {
      return await this.prepareRefreshContext(input, context);
    }

    if (status === "WAITING_REFRESH_CONTEXT") {
      return await this.advanceRefreshContext(input, context);
    }

    throw new Error(`Builder session cannot advance from terminal status ${status}`);
  }

  private async advanceReadyForTurn(
    input: {
      readonly builderSessionId: string;
      readonly claimOwner: string;
      readonly dispatchLeaseSeconds: number;
      readonly commandPolicyKey: string | null;
      readonly actor: Actor;
      readonly stepClaimId: string;
      readonly stepClaimToken: string;
    },
    context: Record<string, unknown>,
  ): Promise<BuilderSessionStepResult & { readonly operation: BuilderSessionStepOperation }> {
    if (context.current_proposal_run_id === null) {
      const plan = recordField(context.plan, "plan");
      const prepared = await this.proposalStore.prepareBuilderProposal({
        builderInvocationId: requiredString(
          plan.builder_invocation_id,
          "plan.builder_invocation_id",
        ),
        workspaceReadContextRunId: requiredString(
          context.current_read_context_run_id,
          "session.current_read_context_run_id",
        ),
        actor: input.actor,
      });
      const proposalRun = recordField(prepared.run, "proposal run");
      const next = await this.sessionStore.transitionBuilderSession({
        builderSessionId: input.builderSessionId,
        stepClaimId: input.stepClaimId,
        stepClaimToken: input.stepClaimToken,
        expectedStatus: "READY_FOR_TURN",
        nextStatus: "READY_FOR_TURN",
        currentProposalRunId: requiredString(proposalRun.id, "proposal run id"),
        turnCount: numberField(context.turn_count, "session.turn_count") + 1,
        actor: input.actor,
      });
      return this.result("PREPARE_PROPOSAL", next);
    }

    const proposalRun = await this.proposalStore.getBuilderProposalRun(
      requiredString(context.current_proposal_run_id, "session.current_proposal_run_id"),
    );
    if (!proposalRun) {
      throw new Error("Builder session current proposal run was not found");
    }

    if (proposalRun.status === "PREPARED" || proposalRun.status === "GENERATING") {
      const generated = await this.proposalService.generate({
        builderSessionId: input.builderSessionId,
        builderProposalRunId: requiredString(proposalRun.id, "proposal run id"),
        stepClaimId: input.stepClaimId,
        stepClaimToken: input.stepClaimToken,
        claimLeaseSeconds: input.dispatchLeaseSeconds,
        actor: input.actor,
      });
      return this.result(
        "GENERATE_PROPOSAL",
        (await this.sessionStore.getBuilderSession(input.builderSessionId)) ?? context,
        generated.status === "GENERATED" ? "PROPOSAL_GENERATED" : "PROPOSAL_NOT_READY",
      );
    }

    if (proposalRun.status === "GENERATED") {
      const action = await this.actionService.authorizeAndMaterialize({
        builderProposalRunId: requiredString(proposalRun.id, "proposal run id"),
        commandPolicyKey: input.commandPolicyKey,
        actor: input.actor,
      });
      const actionRunId = requiredString(action.id, "proposal action run id");
      const next = await this.sessionStore.transitionBuilderSession({
        builderSessionId: input.builderSessionId,
        stepClaimId: input.stepClaimId,
        stepClaimToken: input.stepClaimToken,
        expectedStatus: "READY_FOR_TURN",
        nextStatus: "WAITING_ACTION",
        currentActionRunId: actionRunId,
        actor: input.actor,
      });
      return this.result("MATERIALIZE_ACTION", next);
    }

    throw new Error(`Builder session proposal failed with status ${String(proposalRun.status)}`);
  }

  private async advanceWaitingAction(
    input: {
      readonly builderSessionId: string;
      readonly actor: Actor;
      readonly stepClaimId: string;
      readonly stepClaimToken: string;
    },
    context: Record<string, unknown>,
  ): Promise<BuilderSessionStepResult & { readonly operation: BuilderSessionStepOperation }> {
    const actionRun = recordField(context.action_run, "action run");
    const actionDecision = recordField(context.action_decision, "action decision");
    const action = String(actionDecision.action);

    if (actionRun.status === "SATISFIED") {
      const actionEvidence = recordField(context.action_evidence, "action evidence");
      if (action === "COMPLETE" || action === "BLOCKED") {
        const outcome = action === "COMPLETE" ? "COMPLETED" : "BLOCKED";
        const proposalEvidence = recordField(context.proposal_evidence, "proposal evidence");
        const proposalContent = recordField(
          proposalEvidence.proposal_content,
          "proposal content",
        );
        const terminal = await this.sessionStore.recordBuilderSessionTerminalEvidence({
          builderSessionId: input.builderSessionId,
          stepClaimId: input.stepClaimId,
          stepClaimToken: input.stepClaimToken,
          outcome,
          finalActionEvidenceId: requiredString(actionEvidence.id, "action evidence id"),
          finalActionEvidenceHash: requiredString(
            actionEvidence.result_hash,
            "action evidence result hash",
          ),
          summary: String(proposalContent.summary ?? `${outcome} builder session`),
          actor: input.actor,
        });
        await this.proposalService.finishDispatch({
          builderSessionId: input.builderSessionId,
          outcome: "COMPLETED",
          actor: input.actor,
        });
        return this.result(
          action === "COMPLETE" ? "FINALIZE_COMPLETE" : "FINALIZE_BLOCKED",
          terminal,
        );
      }

      if (action === "REQUEST_CONTEXT") {
        const entity = materializedEntities(actionRun.materialized_entities)[0];
        if (!entity) {
          throw new Error("Builder session context action has no materialized entity");
        }
        const next = await this.sessionStore.transitionBuilderSession({
          builderSessionId: input.builderSessionId,
          stepClaimId: input.stepClaimId,
          stepClaimToken: input.stepClaimToken,
          expectedStatus: "WAITING_ACTION",
          nextStatus: "READY_FOR_TURN",
          currentReadContextRunId: requiredString(entity.runId, "context run id"),
          currentProposalRunId: null,
          currentActionRunId: null,
          actor: input.actor,
        });
        return this.result("ADVANCE_AFTER_ACTION", next);
      }

      if (action === "REQUEST_COMMANDS") {
        const next = await this.sessionStore.transitionBuilderSession({
          builderSessionId: input.builderSessionId,
          stepClaimId: input.stepClaimId,
          stepClaimToken: input.stepClaimToken,
          expectedStatus: "WAITING_ACTION",
          nextStatus: "READY_FOR_TURN",
          currentProposalRunId: null,
          currentActionRunId: null,
          actor: input.actor,
        });
        return this.result("ADVANCE_AFTER_ACTION", next);
      }

      if (action === "PROPOSE_MUTATIONS") {
        const next = await this.sessionStore.transitionBuilderSession({
          builderSessionId: input.builderSessionId,
          stepClaimId: input.stepClaimId,
          stepClaimToken: input.stepClaimToken,
          expectedStatus: "WAITING_ACTION",
          nextStatus: "REFRESH_CONTEXT",
          currentProposalRunId: null,
          currentActionRunId: null,
          actor: input.actor,
        });
        return this.result("ADVANCE_AFTER_ACTION", next);
      }
    }

    if (actionRun.status !== "MATERIALIZED") {
      const reconciled = await this.actionService.reconcile({
        builderProposalActionRunId: requiredString(actionRun.id, "action run id"),
        actor: input.actor,
      });
      return this.result("RECONCILE_ACTION", context, `ACTION_${String(reconciled.status)}`);
    }

    const entities = materializedEntities(actionRun.materialized_entities);
    if (action === "REQUEST_CONTEXT") {
      const entity = entities[0];
      if (!entity) {
        throw new Error("Builder session context action has no materialized entity");
      }
      const run = await this.readContextStore.getWorkspaceReadContextRun(
        requiredString(entity.runId, "context run id"),
      );
      if (!run) {
        throw new Error("Builder session materialized context run was not found");
      }
      if (run.status === "PREPARED" || run.status === "CAPTURING") {
        await this.readContextService.capture({
          workspaceReadContextRunId: requiredString(run.id, "context run id"),
          actor: input.actor,
        });
        return this.result("EXECUTE_CONTEXT_CAPTURE", context);
      }
      await this.actionService.reconcile({
        builderProposalActionRunId: requiredString(actionRun.id, "action run id"),
        actor: input.actor,
      });
      return this.result("RECONCILE_ACTION", context);
    }

    if (action === "REQUEST_COMMANDS") {
      for (const entity of entities.sort(
        (left, right) => Number(left.ordinal) - Number(right.ordinal),
      )) {
        const run = await this.commandStore.getWorkspaceCommandRun(
          requiredString(entity.runId, "command run id"),
        );
        if (!run) {
          throw new Error("Builder session materialized command run was not found");
        }
        if (run.status === "PREPARED" || run.status === "RUNNING") {
          await this.commandService.run({
            workspaceCommandRunId: requiredString(run.id, "command run id"),
            actor: input.actor,
          });
          return this.result("EXECUTE_COMMAND", context);
        }
      }
      await this.actionService.reconcile({
        builderProposalActionRunId: requiredString(actionRun.id, "action run id"),
        actor: input.actor,
      });
      return this.result("RECONCILE_ACTION", context);
    }

    if (action === "PROPOSE_MUTATIONS") {
      const entity = entities[0];
      if (!entity) {
        throw new Error("Builder session mutation action has no materialized entity");
      }
      const run = await this.mutationStore.getWorkspaceMutationRun(
        requiredString(entity.runId, "mutation run id"),
      );
      if (!run) {
        throw new Error("Builder session materialized mutation run was not found");
      }
      if (run.status === "PREPARED" || run.status === "APPLYING") {
        await this.mutationService.apply({
          workspaceMutationRunId: requiredString(run.id, "mutation run id"),
          actor: input.actor,
        });
        return this.result("EXECUTE_MUTATION", context);
      }
      await this.actionService.reconcile({
        builderProposalActionRunId: requiredString(actionRun.id, "action run id"),
        actor: input.actor,
      });
      return this.result("RECONCILE_ACTION", context);
    }

    throw new Error(`Unsupported builder session action: ${action}`);
  }

  private async prepareRefreshContext(
    input: {
      readonly builderSessionId: string;
      readonly actor: Actor;
      readonly stepClaimId: string;
      readonly stepClaimToken: string;
    },
    context: Record<string, unknown>,
  ): Promise<BuilderSessionStepResult & { readonly operation: BuilderSessionStepOperation }> {
    const currentRead = await this.readContextStore.getWorkspaceReadContextRun(
      requiredString(context.current_read_context_run_id, "session.current_read_context_run_id"),
    );
    if (!currentRead) {
      throw new Error("Builder session current read context was not found");
    }
    const request = recordField(currentRead.request, "read context request");
    const plan = recordField(context.plan, "plan");
    const prepared = await this.readContextStore.prepareWorkspaceReadContext({
      repositoryWorkspaceId: requiredString(
        plan.repository_workspace_id,
        "plan.repository_workspace_id",
      ),
      requestedPaths: stringArray(request.relevant_paths, "read context relevant_paths"),
      actor: input.actor,
    });
    const run = recordField(prepared.run, "refresh read context run");
    const next = await this.sessionStore.transitionBuilderSession({
      builderSessionId: input.builderSessionId,
      stepClaimId: input.stepClaimId,
      stepClaimToken: input.stepClaimToken,
      expectedStatus: "REFRESH_CONTEXT",
      nextStatus: "WAITING_REFRESH_CONTEXT",
      currentReadContextRunId: requiredString(run.id, "refresh read context run id"),
      actor: input.actor,
    });
    return this.result("PREPARE_REFRESH_CONTEXT", next);
  }

  private async advanceRefreshContext(
    input: {
      readonly builderSessionId: string;
      readonly actor: Actor;
      readonly stepClaimId: string;
      readonly stepClaimToken: string;
    },
    context: Record<string, unknown>,
  ): Promise<BuilderSessionStepResult & { readonly operation: BuilderSessionStepOperation }> {
    const run = await this.readContextStore.getWorkspaceReadContextRun(
      requiredString(context.current_read_context_run_id, "session.current_read_context_run_id"),
    );
    if (!run) {
      throw new Error("Builder session refresh context run was not found");
    }
    if (run.status === "PREPARED" || run.status === "CAPTURING") {
      await this.readContextService.capture({
        workspaceReadContextRunId: requiredString(run.id, "refresh context run id"),
        actor: input.actor,
      });
      return this.result("CAPTURE_REFRESH_CONTEXT", context);
    }
    if (run.status === "CAPTURED") {
      const next = await this.sessionStore.transitionBuilderSession({
        builderSessionId: input.builderSessionId,
        stepClaimId: input.stepClaimId,
        stepClaimToken: input.stepClaimToken,
        expectedStatus: "WAITING_REFRESH_CONTEXT",
        nextStatus: "READY_FOR_TURN",
        actor: input.actor,
      });
      return this.result("ADVANCE_AFTER_ACTION", next);
    }
    throw new Error(`Builder session refresh context failed with status ${String(run.status)}`);
  }

  private result(
    operation: BuilderSessionStepOperation,
    session: Record<string, unknown>,
    reason = "ADVANCED",
  ): BuilderSessionStepResult & { readonly operation: BuilderSessionStepOperation } {
    return {
      acquired: true,
      advanced: true,
      operation,
      reason,
      session,
    };
  }
}
