import { createHash } from "node:crypto";

import { sha256Json, type JsonValue } from "./stable-json.js";
import { normalizeRelevantPaths } from "./task-context-pack.js";

export const REPOSITORY_WORKSPACE_MODES = ["READ_ONLY", "WRITE"] as const;
export type RepositoryWorkspaceMode = (typeof REPOSITORY_WORKSPACE_MODES)[number];

export const REPOSITORY_WORKSPACE_STATUSES = [
  "PREPARED",
  "MATERIALIZED",
  "FINALIZED",
  "SCOPE_VIOLATION",
  "ABANDONED",
  "FAILED",
] as const;
export type RepositoryWorkspaceStatus =
  (typeof REPOSITORY_WORKSPACE_STATUSES)[number];

export interface RepositoryWorkspaceScopeResult {
  readonly valid: boolean;
  readonly violations: readonly string[];
}

export interface RepositoryWorkspacePlanIdentity {
  readonly workspaceKey: string;
  readonly branchName: string;
}

export interface RepositoryWorkspacePlanContent {
  readonly schemaVersion: "karsift-repository-workspace-plan-v1";
  readonly builderInvocationId: string;
  readonly executionAttemptId: string;
  readonly taskContextPackId: string;
  readonly taskContextPackHash: string;
  readonly repositoryFullName: string;
  readonly baseBranch: string;
  readonly baseCommitSha: string;
  readonly relevantPaths: readonly string[];
  readonly mode: RepositoryWorkspaceMode;
  readonly adapterKey: string;
}

export function normalizeWorkspaceScope(
  paths: readonly string[],
): readonly string[] {
  return normalizeRelevantPaths(paths);
}

export function isPathWithinWorkspaceScope(
  path: string,
  allowedPaths: readonly string[],
): boolean {
  return allowedPaths.some(
    (allowedPath) => path === allowedPath || path.startsWith(`${allowedPath}/`),
  );
}

export function evaluateWorkspaceScope(input: {
  readonly mode: RepositoryWorkspaceMode;
  readonly allowedPaths: readonly string[];
  readonly changedPaths: readonly string[];
}): RepositoryWorkspaceScopeResult {
  const changedPaths = normalizeRelevantPaths(input.changedPaths);
  const allowedPaths = normalizeWorkspaceScope(input.allowedPaths);

  if (input.mode === "READ_ONLY") {
    return {
      valid: changedPaths.length === 0,
      violations: changedPaths,
    };
  }

  if (allowedPaths.length === 0) {
    return {
      valid: changedPaths.length === 0,
      violations: changedPaths,
    };
  }

  const violations = changedPaths.filter(
    (path) => !isPathWithinWorkspaceScope(path, allowedPaths),
  );
  return { valid: violations.length === 0, violations };
}

export function buildRepositoryWorkspacePlanContent(input: {
  readonly builderInvocationId: string;
  readonly executionAttemptId: string;
  readonly taskContextPackId: string;
  readonly taskContextPackHash: string;
  readonly repositoryFullName: string;
  readonly baseBranch: string;
  readonly baseCommitSha: string;
  readonly relevantPaths: readonly string[];
  readonly mode: RepositoryWorkspaceMode;
  readonly adapterKey: string;
}): RepositoryWorkspacePlanContent {
  return {
    schemaVersion: "karsift-repository-workspace-plan-v1",
    builderInvocationId: input.builderInvocationId,
    executionAttemptId: input.executionAttemptId,
    taskContextPackId: input.taskContextPackId,
    taskContextPackHash: input.taskContextPackHash,
    repositoryFullName: input.repositoryFullName,
    baseBranch: input.baseBranch,
    baseCommitSha: input.baseCommitSha,
    relevantPaths: normalizeWorkspaceScope(input.relevantPaths),
    mode: input.mode,
    adapterKey: input.adapterKey,
  };
}

export function hashRepositoryWorkspacePlan(
  content: RepositoryWorkspacePlanContent,
): string {
  return sha256Json(content as unknown as JsonValue);
}

export function repositoryWorkspaceIdentity(planHash: string): RepositoryWorkspacePlanIdentity {
  if (!/^[a-f0-9]{64}$/.test(planHash)) {
    throw new Error("planHash must be a lowercase 64-character SHA-256 hash");
  }
  return {
    workspaceKey: `ws-${planHash.slice(0, 20)}`,
    branchName: `karsift/${planHash.slice(0, 20)}`,
  };
}

export function sha256Bytes(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
