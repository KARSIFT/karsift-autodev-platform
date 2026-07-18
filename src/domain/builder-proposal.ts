import { WORKSPACE_COMMAND_PURPOSES, type WorkspaceCommandPurpose } from "./workspace-command.js";
import {
  assertWorkspaceMutationScope,
  normalizeWorkspaceMutationOperations,
  type WorkspaceMutationOperation,
} from "./workspace-mutation.js";
import { normalizeWorkspaceReadContextRequestedPaths } from "./workspace-read-context.js";
import { sha256Json, type JsonValue } from "./stable-json.js";

export const BUILDER_PROPOSAL_ACTIONS = [
  "COMPLETE",
  "REQUEST_CONTEXT",
  "REQUEST_COMMANDS",
  "PROPOSE_MUTATIONS",
  "BLOCKED",
] as const;
export type BuilderProposalAction = (typeof BUILDER_PROPOSAL_ACTIONS)[number];

export interface BuilderProposedCommand {
  readonly purpose: WorkspaceCommandPurpose;
  readonly executable: string;
  readonly arguments: readonly string[];
}

export interface BuilderProposal {
  readonly action: BuilderProposalAction;
  readonly summary: string;
  readonly requestedPaths: readonly string[];
  readonly commands: readonly BuilderProposedCommand[];
  readonly mutations: readonly WorkspaceMutationOperation[];
  readonly blockingReason: string | null;
}

export interface BuilderProposalRequestContentInput {
  readonly projectId: string;
  readonly builderInvocationId: string;
  readonly builderInvocationPlanId: string;
  readonly builderPlanHash: string;
  readonly executionAttemptId: string;
  readonly taskContextPackId: string;
  readonly taskContextPackHash: string;
  readonly providerDispatchDecisionId: string;
  readonly providerKey: string;
  readonly workspaceReadContextSnapshotId: string;
  readonly workspaceReadContextSnapshotHash: string;
  readonly relevantPaths: readonly string[];
  readonly taskContextPackContent: JsonValue;
  readonly sourceSnapshotContent: JsonValue;
}

const MAX_SUMMARY_CHARS = 4_000;
const MAX_BLOCKING_REASON_CHARS = 4_000;
const MAX_PROPOSED_COMMANDS = 20;
const MAX_COMMAND_ARGUMENTS = 50;
const MAX_COMMAND_ARGUMENT_CHARS = 2_000;

function boundedText(value: string, field: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxChars) {
    throw new Error(`${field} must contain 1-${maxChars} characters`);
  }
  return normalized;
}

function normalizeCommands(
  commands: readonly BuilderProposedCommand[],
): readonly BuilderProposedCommand[] {
  if (commands.length > MAX_PROPOSED_COMMANDS) {
    throw new Error(`builder proposal cannot exceed ${MAX_PROPOSED_COMMANDS} commands`);
  }
  return commands.map((command) => {
    if (!WORKSPACE_COMMAND_PURPOSES.includes(command.purpose)) {
      throw new Error(`unsupported proposed command purpose: ${command.purpose}`);
    }
    const executable = command.executable.trim();
    if (
      executable.length === 0 ||
      executable.length > 200 ||
      executable.includes("/") ||
      executable.includes("\\") ||
      executable.includes("\0")
    ) {
      throw new Error("proposed command executable must be a bounded bare command name");
    }
    if (command.arguments.length > MAX_COMMAND_ARGUMENTS) {
      throw new Error(`proposed command cannot exceed ${MAX_COMMAND_ARGUMENTS} arguments`);
    }
    const argumentsList = command.arguments.map((argument) => {
      if (
        argument.length > MAX_COMMAND_ARGUMENT_CHARS ||
        argument.includes("\0")
      ) {
        throw new Error("proposed command argument exceeds the bounded string contract");
      }
      return argument;
    });
    return { purpose: command.purpose, executable, arguments: argumentsList };
  });
}

export function normalizeBuilderProposal(
  proposal: BuilderProposal,
  relevantPaths: readonly string[],
): BuilderProposal {
  if (!BUILDER_PROPOSAL_ACTIONS.includes(proposal.action)) {
    throw new Error(`unsupported builder proposal action: ${proposal.action}`);
  }
  const summary = boundedText(proposal.summary, "summary", MAX_SUMMARY_CHARS);
  const requestedPaths = proposal.requestedPaths.length === 0
    ? []
    : [...normalizeWorkspaceReadContextRequestedPaths(proposal.requestedPaths, relevantPaths)];
  const commands = [...normalizeCommands(proposal.commands)];
  const mutations = proposal.mutations.length === 0
    ? []
    : [...normalizeWorkspaceMutationOperations(proposal.mutations)];
  if (mutations.length > 0) {
    assertWorkspaceMutationScope(relevantPaths, mutations);
  }
  const blockingReason = proposal.blockingReason === null
    ? null
    : boundedText(
        proposal.blockingReason,
        "blockingReason",
        MAX_BLOCKING_REASON_CHARS,
      );

  const populated = {
    requestedPaths: requestedPaths.length > 0,
    commands: commands.length > 0,
    mutations: mutations.length > 0,
    blockingReason: blockingReason !== null,
  };

  switch (proposal.action) {
    case "COMPLETE":
      if (Object.values(populated).some(Boolean)) {
        throw new Error("COMPLETE proposal must not include requested actions or blocking reason");
      }
      break;
    case "REQUEST_CONTEXT":
      if (!populated.requestedPaths || populated.commands || populated.mutations || populated.blockingReason) {
        throw new Error("REQUEST_CONTEXT proposal must contain only requestedPaths");
      }
      break;
    case "REQUEST_COMMANDS":
      if (populated.requestedPaths || !populated.commands || populated.mutations || populated.blockingReason) {
        throw new Error("REQUEST_COMMANDS proposal must contain only commands");
      }
      break;
    case "PROPOSE_MUTATIONS":
      if (populated.requestedPaths || populated.commands || !populated.mutations || populated.blockingReason) {
        throw new Error("PROPOSE_MUTATIONS proposal must contain only mutations");
      }
      break;
    case "BLOCKED":
      if (populated.requestedPaths || populated.commands || populated.mutations || !populated.blockingReason) {
        throw new Error("BLOCKED proposal must contain only blockingReason");
      }
      break;
  }

  return {
    action: proposal.action,
    summary,
    requestedPaths,
    commands,
    mutations,
    blockingReason,
  };
}

export function buildBuilderProposalRequestContent(
  input: BuilderProposalRequestContentInput,
): JsonValue {
  for (const [field, hash] of [
    ["builderPlanHash", input.builderPlanHash],
    ["taskContextPackHash", input.taskContextPackHash],
    ["workspaceReadContextSnapshotHash", input.workspaceReadContextSnapshotHash],
  ] as const) {
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`${field} must be a lowercase SHA-256 hash`);
    }
  }
  return {
    projectId: input.projectId,
    builderInvocationId: input.builderInvocationId,
    builderInvocationPlanId: input.builderInvocationPlanId,
    builderPlanHash: input.builderPlanHash,
    executionAttemptId: input.executionAttemptId,
    taskContextPackId: input.taskContextPackId,
    taskContextPackHash: input.taskContextPackHash,
    providerDispatchDecisionId: input.providerDispatchDecisionId,
    providerKey: input.providerKey,
    workspaceReadContextSnapshotId: input.workspaceReadContextSnapshotId,
    workspaceReadContextSnapshotHash: input.workspaceReadContextSnapshotHash,
    relevantPaths: [...input.relevantPaths],
    taskContextPackContent: input.taskContextPackContent,
    sourceSnapshotContent: input.sourceSnapshotContent,
  };
}

export function hashBuilderProposalRequest(
  input: BuilderProposalRequestContentInput,
): string {
  return sha256Json(buildBuilderProposalRequestContent(input));
}

export function builderProposalContent(
  proposal: BuilderProposal,
  relevantPaths: readonly string[],
): JsonValue {
  const normalized = normalizeBuilderProposal(proposal, relevantPaths);
  return {
    action: normalized.action,
    summary: normalized.summary,
    requestedPaths: [...normalized.requestedPaths],
    commands: normalized.commands.map((command) => ({
      purpose: command.purpose,
      executable: command.executable,
      arguments: [...command.arguments],
    })),
    mutations: normalized.mutations.map((mutation) => ({ ...mutation })),
    blockingReason: normalized.blockingReason,
  };
}

export function hashBuilderProposal(
  proposal: BuilderProposal,
  relevantPaths: readonly string[],
): string {
  return sha256Json(builderProposalContent(proposal, relevantPaths));
}
