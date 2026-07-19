import type { BuilderProposalAction } from "./builder-proposal.js";
import { sha256Json, type JsonValue } from "./stable-json.js";

export const BUILDER_PROPOSAL_ACTION_RUN_STATUSES = [
  "PREPARED",
  "MATERIALIZED",
  "SATISFIED",
] as const;
export type BuilderProposalActionRunStatus =
  (typeof BUILDER_PROPOSAL_ACTION_RUN_STATUSES)[number];

export const BUILDER_PROPOSAL_ACTION_EVIDENCE_OUTCOMES = [
  "TERMINAL",
  "RESULT_READY",
] as const;
export type BuilderProposalActionEvidenceOutcome =
  (typeof BUILDER_PROPOSAL_ACTION_EVIDENCE_OUTCOMES)[number];

export type BuilderProposalActionEntityKind =
  | "WORKSPACE_READ_CONTEXT"
  | "WORKSPACE_COMMAND"
  | "WORKSPACE_MUTATION";

export interface BuilderProposalActionMaterializedEntity {
  readonly kind: BuilderProposalActionEntityKind;
  readonly ordinal: number;
  readonly recordId: string;
  readonly runId: string;
}

export interface BuilderProposalActionDecisionContentInput {
  readonly projectId: string;
  readonly builderInvocationId: string;
  readonly builderProposalRequestId: string;
  readonly builderProposalRunId: string;
  readonly builderProposalEvidenceId: string;
  readonly proposalHash: string;
  readonly action: BuilderProposalAction;
  readonly turnNumber: number;
  readonly repositoryWorkspaceId: string;
  readonly workspaceStateVersion: number;
  readonly taskContextPackId: string;
  readonly taskContextPackHash: string;
  readonly commandPolicyId: string | null;
  readonly commandPolicyHash: string | null;
}

export interface BuilderProposalActionResultContentInput {
  readonly action: BuilderProposalAction;
  readonly outcome: BuilderProposalActionEvidenceOutcome;
  readonly materializedEntities: readonly BuilderProposalActionMaterializedEntity[];
  readonly results: JsonValue;
}

function assertSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${field} must be a lowercase SHA-256 hash`);
  }
}

export function normalizeBuilderProposalActionEntities(
  entities: readonly BuilderProposalActionMaterializedEntity[],
): readonly BuilderProposalActionMaterializedEntity[] {
  const normalized = entities.map((entity) => {
    if (!Number.isInteger(entity.ordinal) || entity.ordinal < 0) {
      throw new Error("builder proposal action entity ordinal must be a non-negative integer");
    }
    if (!entity.recordId || !entity.runId) {
      throw new Error("builder proposal action entity ids must not be empty");
    }
    return { ...entity };
  });
  normalized.sort((left, right) => left.ordinal - right.ordinal);
  const ordinals = new Set(normalized.map((entity) => entity.ordinal));
  if (ordinals.size !== normalized.length) {
    throw new Error("builder proposal action entity ordinals must be unique");
  }
  return normalized;
}

export function buildBuilderProposalActionDecisionContent(
  input: BuilderProposalActionDecisionContentInput,
): JsonValue {
  assertSha256(input.proposalHash, "proposalHash");
  assertSha256(input.taskContextPackHash, "taskContextPackHash");
  if (!Number.isInteger(input.turnNumber) || input.turnNumber < 1) {
    throw new Error("turnNumber must be a positive integer");
  }
  if (!Number.isInteger(input.workspaceStateVersion) || input.workspaceStateVersion < 0) {
    throw new Error("workspaceStateVersion must be a non-negative integer");
  }
  if ((input.commandPolicyId === null) !== (input.commandPolicyHash === null)) {
    throw new Error("command policy id and hash must either both be present or both be null");
  }
  if (input.commandPolicyHash !== null) {
    assertSha256(input.commandPolicyHash, "commandPolicyHash");
  }
  return {
    projectId: input.projectId,
    builderInvocationId: input.builderInvocationId,
    builderProposalRequestId: input.builderProposalRequestId,
    builderProposalRunId: input.builderProposalRunId,
    builderProposalEvidenceId: input.builderProposalEvidenceId,
    proposalHash: input.proposalHash,
    action: input.action,
    turnNumber: input.turnNumber,
    repositoryWorkspaceId: input.repositoryWorkspaceId,
    workspaceStateVersion: input.workspaceStateVersion,
    taskContextPackId: input.taskContextPackId,
    taskContextPackHash: input.taskContextPackHash,
    commandPolicyId: input.commandPolicyId,
    commandPolicyHash: input.commandPolicyHash,
  };
}

export function hashBuilderProposalActionDecision(
  input: BuilderProposalActionDecisionContentInput,
): string {
  return sha256Json(buildBuilderProposalActionDecisionContent(input));
}

export function buildBuilderProposalActionResultContent(
  input: BuilderProposalActionResultContentInput,
): JsonValue {
  const entities = normalizeBuilderProposalActionEntities(input.materializedEntities);
  return {
    action: input.action,
    outcome: input.outcome,
    materializedEntities: entities.map((entity) => ({ ...entity })),
    results: input.results,
  };
}

export function hashBuilderProposalActionResult(
  input: BuilderProposalActionResultContentInput,
): string {
  return sha256Json(buildBuilderProposalActionResultContent(input));
}
