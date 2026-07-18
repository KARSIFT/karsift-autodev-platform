import { createHash } from "node:crypto";

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
