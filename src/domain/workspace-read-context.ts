import { createHash } from "node:crypto";

import { isPathWithinWorkspaceScope } from "./repository-workspace.js";
import { sha256Json, type JsonValue } from "./stable-json.js";
import { normalizeRelevantPaths } from "./task-context-pack.js";

export const MAX_READ_CONTEXT_REQUESTED_PATHS = 50;
export const MAX_READ_CONTEXT_FILES = 200;
export const MAX_READ_CONTEXT_FILE_BYTES = 256_000;
export const MAX_READ_CONTEXT_TOTAL_BYTES = 2_000_000;

export interface WorkspaceReadContextFile {
  readonly path: string;
  readonly content: string;
  readonly contentHash: string;
  readonly bytes: number;
}

export interface WorkspaceReadContextRequestInput {
  readonly projectId: string;
  readonly repositoryWorkspaceId: string;
  readonly repositoryWorkspacePlanId: string;
  readonly builderInvocationId: string;
  readonly taskContextPackId: string;
  readonly taskContextPackHash: string;
  readonly workspaceStateVersion: number;
  readonly workspacePath: string;
  readonly relevantPaths: readonly string[];
  readonly requestedPaths: readonly string[];
}

export interface WorkspaceReadContextSnapshotInput
  extends WorkspaceReadContextRequestInput {
  readonly requestHash: string;
  readonly files: readonly WorkspaceReadContextFile[];
}

const PROTECTED_BASENAMES = new Set([
  ".env",
  "credentials.json",
  "service-account.json",
  "id_rsa",
  "id_ed25519",
]);
const PROTECTED_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"]);

export function isProtectedReadContextPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".git")) {
    return true;
  }
  const basename = segments.at(-1) ?? "";
  if (PROTECTED_BASENAMES.has(basename) || basename.startsWith(".env.")) {
    return true;
  }
  return PROTECTED_EXTENSIONS.has(
    basename.includes(".") ? basename.slice(basename.lastIndexOf(".")) : "",
  );
}

export function normalizeWorkspaceReadContextRequestedPaths(
  requestedPaths: readonly string[],
  relevantPaths: readonly string[],
): readonly string[] {
  if (requestedPaths.length === 0) {
    throw new Error("workspace read context requires at least one requested path");
  }
  if (requestedPaths.length > MAX_READ_CONTEXT_REQUESTED_PATHS) {
    throw new Error(
      `workspace read context cannot exceed ${MAX_READ_CONTEXT_REQUESTED_PATHS} requested paths`,
    );
  }

  const normalizedRequested = normalizeRelevantPaths(requestedPaths);
  const normalizedRelevant = normalizeRelevantPaths(relevantPaths);
  for (const requestedPath of normalizedRequested) {
    if (isProtectedReadContextPath(requestedPath)) {
      throw new Error(`Workspace read context protected path: ${requestedPath}`);
    }
    if (!isPathWithinWorkspaceScope(requestedPath, normalizedRelevant)) {
      throw new Error(
        `Workspace read context scope conflict: requested path is outside relevant scope: ${requestedPath}`,
      );
    }
  }
  return normalizedRequested;
}

export function buildWorkspaceReadContextRequestContent(
  input: WorkspaceReadContextRequestInput,
): JsonValue {
  if (!/^[a-f0-9]{64}$/.test(input.taskContextPackHash)) {
    throw new Error("taskContextPackHash must be a lowercase SHA-256 hash");
  }
  if (!Number.isInteger(input.workspaceStateVersion) || input.workspaceStateVersion < 0) {
    throw new Error("workspaceStateVersion must be a non-negative integer");
  }
  const relevantPaths = normalizeRelevantPaths(input.relevantPaths);
  const requestedPaths = normalizeWorkspaceReadContextRequestedPaths(
    input.requestedPaths,
    relevantPaths,
  );
  return {
    projectId: input.projectId,
    repositoryWorkspaceId: input.repositoryWorkspaceId,
    repositoryWorkspacePlanId: input.repositoryWorkspacePlanId,
    builderInvocationId: input.builderInvocationId,
    taskContextPackId: input.taskContextPackId,
    taskContextPackHash: input.taskContextPackHash,
    workspaceStateVersion: input.workspaceStateVersion,
    workspacePath: input.workspacePath,
    relevantPaths: [...relevantPaths],
    requestedPaths: [...requestedPaths],
  };
}

export function hashWorkspaceReadContextRequest(
  input: WorkspaceReadContextRequestInput,
): string {
  return sha256Json(buildWorkspaceReadContextRequestContent(input));
}

export function normalizeWorkspaceReadContextFiles(
  files: readonly WorkspaceReadContextFile[],
): readonly WorkspaceReadContextFile[] {
  if (files.length === 0) {
    throw new Error("workspace read context snapshot must contain at least one file");
  }
  if (files.length > MAX_READ_CONTEXT_FILES) {
    throw new Error(`workspace read context cannot exceed ${MAX_READ_CONTEXT_FILES} files`);
  }

  const normalized = files.map((file) => {
    const normalizedPath = normalizeRelevantPaths([file.path])[0];
    if (!normalizedPath) {
      throw new Error("workspace read context file path must not be empty");
    }
    if (isProtectedReadContextPath(normalizedPath)) {
      throw new Error(`Workspace read context protected path: ${normalizedPath}`);
    }
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes !== file.bytes) {
      throw new Error(`workspace read context byte count mismatch: ${normalizedPath}`);
    }
    if (bytes > MAX_READ_CONTEXT_FILE_BYTES) {
      throw new Error(
        `workspace read context file exceeds ${MAX_READ_CONTEXT_FILE_BYTES} bytes: ${normalizedPath}`,
      );
    }
    const contentHash = createHash("sha256").update(file.content, "utf8").digest("hex");
    if (contentHash !== file.contentHash) {
      throw new Error(`workspace read context hash mismatch: ${normalizedPath}`);
    }
    return { path: normalizedPath, content: file.content, contentHash, bytes };
  });
  normalized.sort((left, right) => left.path.localeCompare(right.path));
  const paths = normalized.map((file) => file.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("workspace read context cannot contain duplicate file paths");
  }
  const totalBytes = normalized.reduce((sum, file) => sum + file.bytes, 0);
  if (totalBytes > MAX_READ_CONTEXT_TOTAL_BYTES) {
    throw new Error(
      `workspace read context cannot exceed ${MAX_READ_CONTEXT_TOTAL_BYTES} total bytes`,
    );
  }
  return normalized;
}

export function buildWorkspaceReadContextSnapshotContent(
  input: WorkspaceReadContextSnapshotInput,
): JsonValue {
  if (!/^[a-f0-9]{64}$/.test(input.requestHash)) {
    throw new Error("requestHash must be a lowercase SHA-256 hash");
  }
  const requestContent = buildWorkspaceReadContextRequestContent(input);
  const files = normalizeWorkspaceReadContextFiles(input.files);
  return {
    request: requestContent,
    requestHash: input.requestHash,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files: files.map((file) => ({ ...file })),
  };
}

export function hashWorkspaceReadContextSnapshot(
  input: WorkspaceReadContextSnapshotInput,
): string {
  return sha256Json(buildWorkspaceReadContextSnapshotContent(input));
}
