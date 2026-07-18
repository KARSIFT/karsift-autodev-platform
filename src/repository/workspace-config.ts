import path from "node:path";

export interface RepositoryWorkspaceConfig {
  readonly sourceRoot: string;
  readonly workspaceRoot: string;
}

function absoluteRoot(value: string | undefined, fallback: string, name: string): string {
  const resolved = path.resolve(value?.trim() || fallback);
  if (!path.isAbsolute(resolved)) {
    throw new Error(`${name} must resolve to an absolute path`);
  }
  return resolved;
}

export function loadRepositoryWorkspaceConfig(
  env: NodeJS.ProcessEnv = process.env,
): RepositoryWorkspaceConfig {
  const sourceRoot = absoluteRoot(
    env.REPOSITORY_SOURCE_ROOT,
    "/var/lib/karsift/repositories",
    "REPOSITORY_SOURCE_ROOT",
  );
  const workspaceRoot = absoluteRoot(
    env.REPOSITORY_WORKSPACE_ROOT,
    "/var/lib/karsift/workspaces",
    "REPOSITORY_WORKSPACE_ROOT",
  );

  if (sourceRoot === workspaceRoot) {
    throw new Error("Repository source and workspace roots must be different");
  }

  return { sourceRoot, workspaceRoot };
}
