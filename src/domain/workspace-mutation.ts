import { evaluateWorkspaceScope } from "./repository-workspace.js";
import { sha256Json, type JsonValue } from "./stable-json.js";
import { normalizeRelevantPaths } from "./task-context-pack.js";

export const WORKSPACE_MUTATION_OPERATION_TYPES = ["CREATE", "UPDATE", "DELETE"] as const;
export type WorkspaceMutationOperationType =
  (typeof WORKSPACE_MUTATION_OPERATION_TYPES)[number];

export const MAX_WORKSPACE_MUTATION_OPERATIONS = 50;
export const MAX_WORKSPACE_MUTATION_FILE_BYTES = 1_000_000;
export const MAX_WORKSPACE_MUTATION_TOTAL_BYTES = 5_000_000;

export interface WorkspaceMutationOperation {
  readonly type: WorkspaceMutationOperationType;
  readonly path: string;
  readonly expectedBeforeHash: string | null;
  readonly content: string | null;
}

export interface WorkspaceMutationPlanContentInput {
  readonly projectId: string;
  readonly repositoryWorkspaceId: string;
  readonly repositoryWorkspacePlanId: string;
  readonly builderInvocationId: string;
  readonly workspaceStateVersion: number;
  readonly workspacePath: string;
  readonly relevantPaths: readonly string[];
  readonly operations: readonly WorkspaceMutationOperation[];
}

function assertSha256OrNull(value: string | null, field: string): void {
  if (value !== null && !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${field} must be null or a lowercase SHA-256 hash`);
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function normalizeWorkspaceMutationOperations(
  operations: readonly WorkspaceMutationOperation[],
): readonly WorkspaceMutationOperation[] {
  if (operations.length === 0) {
    throw new Error("workspace mutation must contain at least one operation");
  }
  if (operations.length > MAX_WORKSPACE_MUTATION_OPERATIONS) {
    throw new Error(
      `workspace mutation cannot exceed ${MAX_WORKSPACE_MUTATION_OPERATIONS} operations`,
    );
  }

  const normalized = operations.map((operation) => {
    if (!WORKSPACE_MUTATION_OPERATION_TYPES.includes(operation.type)) {
      throw new Error(`unsupported workspace mutation operation: ${operation.type}`);
    }
    const normalizedPath = normalizeRelevantPaths([operation.path])[0];
    if (!normalizedPath) {
      throw new Error("workspace mutation path must not be empty");
    }
    assertSha256OrNull(operation.expectedBeforeHash, "expectedBeforeHash");

    if (operation.type === "CREATE") {
      if (operation.expectedBeforeHash !== null) {
        throw new Error("CREATE requires expectedBeforeHash to be null");
      }
      if (operation.content === null) {
        throw new Error("CREATE requires UTF-8 text content");
      }
    } else if (operation.type === "UPDATE") {
      if (operation.expectedBeforeHash === null) {
        throw new Error("UPDATE requires an expectedBeforeHash");
      }
      if (operation.content === null) {
        throw new Error("UPDATE requires UTF-8 text content");
      }
    } else {
      if (operation.expectedBeforeHash === null) {
        throw new Error("DELETE requires an expectedBeforeHash");
      }
      if (operation.content !== null) {
        throw new Error("DELETE must not include content");
      }
    }

    if (operation.content !== null) {
      const bytes = utf8Bytes(operation.content);
      if (bytes > MAX_WORKSPACE_MUTATION_FILE_BYTES) {
        throw new Error(
          `workspace mutation file content cannot exceed ${MAX_WORKSPACE_MUTATION_FILE_BYTES} bytes`,
        );
      }
    }

    return {
      type: operation.type,
      path: normalizedPath,
      expectedBeforeHash: operation.expectedBeforeHash,
      content: operation.content,
    };
  });

  const paths = normalized.map((operation) => operation.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("workspace mutation cannot contain multiple operations for the same path");
  }

  const totalBytes = normalized.reduce(
    (sum, operation) => sum + (operation.content === null ? 0 : utf8Bytes(operation.content)),
    0,
  );
  if (totalBytes > MAX_WORKSPACE_MUTATION_TOTAL_BYTES) {
    throw new Error(
      `workspace mutation content cannot exceed ${MAX_WORKSPACE_MUTATION_TOTAL_BYTES} total bytes`,
    );
  }

  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

export function assertWorkspaceMutationScope(
  relevantPaths: readonly string[],
  operations: readonly WorkspaceMutationOperation[],
): void {
  const normalizedOperations = normalizeWorkspaceMutationOperations(operations);
  const scope = evaluateWorkspaceScope({
    mode: "WRITE",
    allowedPaths: normalizeRelevantPaths(relevantPaths),
    changedPaths: normalizedOperations.map((operation) => operation.path),
  });
  if (!scope.valid) {
    throw new Error(
      `Workspace mutation scope conflict: out-of-scope paths: ${scope.violations.join(", ")}`,
    );
  }
}

export function workspaceMutationTotalContentBytes(
  operations: readonly WorkspaceMutationOperation[],
): number {
  return normalizeWorkspaceMutationOperations(operations).reduce(
    (sum, operation) => sum + (operation.content === null ? 0 : utf8Bytes(operation.content)),
    0,
  );
}

export function buildWorkspaceMutationPlanContent(
  input: WorkspaceMutationPlanContentInput,
): JsonValue {
  if (!Number.isInteger(input.workspaceStateVersion) || input.workspaceStateVersion < 0) {
    throw new Error("workspaceStateVersion must be a non-negative integer");
  }
  const relevantPaths = normalizeRelevantPaths(input.relevantPaths);
  const operations = normalizeWorkspaceMutationOperations(input.operations);
  assertWorkspaceMutationScope(relevantPaths, operations);

  return {
    projectId: input.projectId,
    repositoryWorkspaceId: input.repositoryWorkspaceId,
    repositoryWorkspacePlanId: input.repositoryWorkspacePlanId,
    builderInvocationId: input.builderInvocationId,
    workspaceStateVersion: input.workspaceStateVersion,
    workspacePath: input.workspacePath,
    relevantPaths,
    operations: operations.map((operation) => ({
      type: operation.type,
      path: operation.path,
      expectedBeforeHash: operation.expectedBeforeHash,
      content: operation.content,
    })),
    totalContentBytes: workspaceMutationTotalContentBytes(operations),
  };
}

export function hashWorkspaceMutationPlan(input: WorkspaceMutationPlanContentInput): string {
  return sha256Json(buildWorkspaceMutationPlanContent(input));
}
