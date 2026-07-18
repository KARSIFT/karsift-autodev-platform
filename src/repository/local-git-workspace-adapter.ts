import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readlink, rm } from "node:fs/promises";
import path from "node:path";

import { normalizeRelevantPaths, assertRepositorySnapshot } from "../domain/task-context-pack.js";
import { sha256Bytes } from "../domain/repository-workspace.js";
import type { RepositoryWorkspaceConfig } from "./workspace-config.js";
import type {
  MaterializeRepositoryWorkspaceInput,
  MaterializedRepositoryWorkspace,
  RepositoryWorkspaceAdapter,
  RepositoryWorkspaceChange,
  RepositoryWorkspaceDiffEvidence,
} from "./repository-workspace-adapter.js";

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveRelativeSourcePath(root: string, value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    path.posix.isAbsolute(normalized) ||
    normalized.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw new Error("sourceRepositoryPath must be a normalized relative path inside the configured source root");
  }
  const resolved = path.resolve(root, normalized);
  if (!isWithinRoot(root, resolved)) {
    throw new Error("sourceRepositoryPath escapes the configured source root");
  }
  return resolved;
}

function resolveWorkspacePath(root: string, value: string): string {
  const resolved = path.resolve(value);
  if (!isWithinRoot(root, resolved) || resolved === root) {
    throw new Error("workspacePath must be a child of the configured workspace root");
  }
  return resolved;
}

async function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code !== 0) {
        reject(
          new Error(
            `Command failed (${command} ${args.join(" ")}): ${result.stderr.trim() || `exit ${code}`}`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

async function fileContentHash(workspacePath: string, relativePath: string): Promise<string | null> {
  const absolutePath = path.resolve(workspacePath, relativePath);
  if (!isWithinRoot(workspacePath, absolutePath) || absolutePath === workspacePath) {
    throw new Error(`Git reported a path outside the workspace: ${relativePath}`);
  }

  try {
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      return sha256Bytes(`symlink:${await readlink(absolutePath)}`);
    }
    if (stat.isFile()) {
      return sha256Bytes(await readFile(absolutePath));
    }
    return sha256Bytes(`other:${stat.mode}:${stat.size}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export class LocalGitWorkspaceAdapter implements RepositoryWorkspaceAdapter {
  public readonly key = "local-git";

  public constructor(private readonly config: RepositoryWorkspaceConfig) {}

  public async materialize(
    input: MaterializeRepositoryWorkspaceInput,
  ): Promise<MaterializedRepositoryWorkspace> {
    assertRepositorySnapshot(input.baseBranch, input.baseCommitSha);
    const sourcePath = resolveRelativeSourcePath(
      this.config.sourceRoot,
      input.sourceRepositoryPath,
    );
    const workspacePath = resolveWorkspacePath(
      this.config.workspaceRoot,
      input.workspacePath,
    );

    await mkdir(this.config.sourceRoot, { recursive: true });
    await mkdir(this.config.workspaceRoot, { recursive: true });

    await runCommand("git", ["-C", sourcePath, "rev-parse", "--is-inside-work-tree"]);
    await runCommand("git", ["-C", sourcePath, "cat-file", "-e", `${input.baseCommitSha}^{commit}`]);

    await rm(workspacePath, { recursive: true, force: false }).catch((error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    });
    await runCommand("git", [
      "clone",
      "--no-hardlinks",
      "--no-checkout",
      "--",
      sourcePath,
      workspacePath,
    ]);
    await runCommand("git", ["-C", workspacePath, "checkout", "--detach", input.baseCommitSha]);
    await runCommand("git", ["-C", workspacePath, "switch", "-c", input.branchName]);

    const head = (
      await runCommand("git", ["-C", workspacePath, "rev-parse", "HEAD"])
    ).stdout.trim();
    if (head !== input.baseCommitSha) {
      throw new Error(
        `Repository workspace conflict: expected base ${input.baseCommitSha}, materialized ${head}`,
      );
    }

    return { workspacePath, headCommitSha: head };
  }

  public async collectDiffEvidence(
    workspacePathInput: string,
  ): Promise<RepositoryWorkspaceDiffEvidence> {
    const workspacePath = resolveWorkspacePath(
      this.config.workspaceRoot,
      workspacePathInput,
    );
    const headCommitSha = (
      await runCommand("git", ["-C", workspacePath, "rev-parse", "HEAD"])
    ).stdout.trim();

    const statusOutput = (
      await runCommand("git", [
        "-C",
        workspacePath,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
      ])
    ).stdout;

    const entries = statusOutput.split("\0").filter((entry) => entry.length > 0);
    const changes: RepositoryWorkspaceChange[] = [];
    for (const entry of entries) {
      if (entry.length < 4 || entry[2] !== " ") {
        throw new Error(`Unexpected Git status entry: ${JSON.stringify(entry)}`);
      }
      const status = entry.slice(0, 2);
      const relativePath = normalizeRelevantPaths([entry.slice(3)])[0];
      if (!relativePath) {
        throw new Error("Git reported an empty changed path");
      }
      changes.push({
        path: relativePath,
        status,
        contentHash: await fileContentHash(workspacePath, relativePath),
      });
    }

    changes.sort((left, right) => left.path.localeCompare(right.path));
    return { headCommitSha, changes };
  }

  public async cleanup(workspacePathInput: string): Promise<void> {
    const workspacePath = resolveWorkspacePath(
      this.config.workspaceRoot,
      workspacePathInput,
    );
    await rm(workspacePath, { recursive: true, force: true });
  }
}
