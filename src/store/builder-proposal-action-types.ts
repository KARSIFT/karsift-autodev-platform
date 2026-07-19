import type { BuilderProposalActionMaterializedEntity } from "../domain/builder-proposal-action.js";
import type { Actor } from "./types.js";

export interface PrepareBuilderProposalActionInput {
  readonly builderProposalRunId: string;
  readonly commandPolicyKey: string | null;
  readonly actor: Actor;
}

export interface MarkBuilderProposalActionMaterializedInput {
  readonly builderProposalActionRunId: string;
  readonly materializedEntities: readonly BuilderProposalActionMaterializedEntity[];
  readonly actor: Actor;
}

export interface RefreshBuilderProposalActionInput {
  readonly builderProposalActionRunId: string;
  readonly actor: Actor;
}

export interface BuilderProposalActionStore {
  prepareBuilderProposalAction(
    input: PrepareBuilderProposalActionInput,
  ): Promise<Record<string, unknown>>;
  markBuilderProposalActionMaterialized(
    input: MarkBuilderProposalActionMaterializedInput,
  ): Promise<Record<string, unknown>>;
  refreshBuilderProposalAction(
    input: RefreshBuilderProposalActionInput,
  ): Promise<Record<string, unknown>>;
  getBuilderProposalActionRun(
    builderProposalActionRunId: string,
  ): Promise<Record<string, unknown> | null>;
  getProjectBuilderProposalActionStatus(
    projectId: string,
  ): Promise<Record<string, unknown>>;
  getPlatformBuilderProposalActionStatus(): Promise<Record<string, unknown>>;
}
