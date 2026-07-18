import type { BuilderProposal } from "../domain/builder-proposal.js";
import type { JsonValue } from "../domain/stable-json.js";
import type { Actor } from "./types.js";

export interface PrepareBuilderProposalInput {
  readonly builderInvocationId: string;
  readonly workspaceReadContextRunId: string;
  readonly actor: Actor;
}

export interface ClaimBuilderProposalRunInput {
  readonly builderProposalRunId: string;
  readonly builderDispatchClaimId: string;
  readonly builderDispatchRevalidationId: string;
  readonly actor: Actor;
}

export interface ClaimBuilderProposalRunResult {
  readonly claimed: boolean;
  readonly run: Record<string, unknown>;
  readonly request: Record<string, unknown>;
}

export interface CompleteBuilderProposalRunInput {
  readonly builderProposalRunId: string;
  readonly proposal: BuilderProposal;
  readonly externalProviderCalled: boolean;
  readonly providerRequestId: string | null;
  readonly usage: JsonValue;
  readonly actor: Actor;
}

export interface FailBuilderProposalRunInput {
  readonly builderProposalRunId: string;
  readonly errorCode: string;
  readonly usage: JsonValue;
  readonly actor: Actor;
}

export interface BuilderProposalStore {
  prepareBuilderProposal(
    input: PrepareBuilderProposalInput,
  ): Promise<Record<string, unknown>>;
  claimBuilderProposalRun(
    input: ClaimBuilderProposalRunInput,
  ): Promise<ClaimBuilderProposalRunResult>;
  completeBuilderProposalRun(
    input: CompleteBuilderProposalRunInput,
  ): Promise<Record<string, unknown>>;
  failBuilderProposalRun(
    input: FailBuilderProposalRunInput,
  ): Promise<Record<string, unknown>>;
  getBuilderProposalRun(
    builderProposalRunId: string,
  ): Promise<Record<string, unknown> | null>;
  getProjectBuilderProposalStatus(projectId: string): Promise<Record<string, unknown>>;
  getPlatformBuilderProposalStatus(): Promise<Record<string, unknown>>;
}
