import type { JsonValue } from "./stable-json.js";

export const TASK_CONTEXT_PACK_SCHEMA_VERSION = "task-context-pack-v1";

function isObject(
  value: JsonValue | undefined,
): value is { [key: string]: JsonValue } {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

export function contractSection(
  content: JsonValue,
  key: string,
  fallback: JsonValue,
): JsonValue {
  if (!isObject(content)) {
    return fallback;
  }
  return content[key] ?? fallback;
}

export function normalizeRelevantPaths(
  paths: readonly string[],
): readonly string[] {
  const normalized = new Set<string>();

  for (const rawPath of paths) {
    const value = rawPath.trim().replaceAll("\\", "/");
    if (value.length === 0) {
      continue;
    }
    if (value.startsWith("/")) {
      throw new Error("relevantPaths must contain repository-relative paths");
    }

    const segments = value.split("/");
    if (segments.some((segment) => segment === "..")) {
      throw new Error("relevantPaths must not contain parent-directory traversal");
    }
    if (segments.some((segment) => segment.length === 0 || segment === ".")) {
      throw new Error("relevantPaths must use normalized repository-relative paths");
    }

    normalized.add(value);
  }

  return [...normalized].sort();
}

export function assertRepositorySnapshot(
  baseBranch: string,
  baseCommitSha: string,
): void {
  if (baseBranch.trim().length === 0) {
    throw new Error("baseBranch must not be empty");
  }
  if (baseBranch !== baseBranch.trim()) {
    throw new Error("baseBranch must not contain surrounding whitespace");
  }
  if (!/^[a-f0-9]{40,64}$/.test(baseCommitSha)) {
    throw new Error("baseCommitSha must be a lowercase 40-64 character hexadecimal SHA");
  }
}
