import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  normalizeWorkspaceMutationOperations,
  type WorkspaceMutationOperation,
} from "../domain/workspace-mutation.js";

export interface WorkspaceMutationPathEvidence {
  readonly type: "CREATE" | "UPDATE" | "DELETE";
  readonly path: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly beforeBytes: number;
  readonly afterBytes: number;
}

export interface WorkspaceMutationApplyResult {
  readonly durationMs: number;
  readonly pathEvidence: readonly WorkspaceMutationPathEvidence[];
}

interface PreflightEntry {
  readonly operation: WorkspaceMutationOperation;
  readonly targetPath: string;
  readonly originalBytes: Buffer | null;
  readonly originalMode: number;
  readonly beforeHash: string | null;
}

type FaultInjector = (
  operationIndex: number,
  operation: WorkspaceMutationOperation,
) => void | Promise<void>;

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertStrictUtf8(bytes: Buffer, relativePath: string): void {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Workspace mutation conflict: existing file is not valid UTF-8 text: ${relativePath}`);
  }
}

export class AtomicWorkspaceMutationApplier {
  public constructor(
    private readonly workspaceRoot: string,
    private readonly faultInjector?: FaultInjector,
  ) {}

  private async resolveWorkspacePath(workspacePathInput: string): Promise<string> {
    const configuredRoot = await realpath(path.resolve(this.workspaceRoot));
    const workspacePath = await realpath(path.resolve(workspacePathInput));
    if (workspacePath === configuredRoot || !isWithinRoot(configuredRoot, workspacePath)) {
      throw new Error("Workspace mutation path must be a child of the configured workspace root");
    }
    const stat = await lstat(workspacePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Workspace mutation path must be a real directory");
    }
    return workspacePath;
  }

  private async assertSafeParent(
    workspacePath: string,
    relativePath: string,
  ): Promise<string> {
    const segments = relativePath.split("/");
    let current = workspacePath;
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment);
      let stat;
      try {
        stat = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(
            `Workspace mutation conflict: parent directory does not exist: ${relativePath}`,
          );
        }
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(
          `Workspace mutation conflict: path traverses a symlink or non-directory: ${relativePath}`,
        );
      }
    }
    return current;
  }

  private async preflight(
    workspacePath: string,
    operations: readonly WorkspaceMutationOperation[],
  ): Promise<readonly PreflightEntry[]> {
    const entries: PreflightEntry[] = [];
    for (const operation of operations) {
      await this.assertSafeParent(workspacePath, operation.path);
      const targetPath = path.resolve(workspacePath, operation.path);
      if (!isWithinRoot(workspacePath, targetPath) || targetPath === workspacePath) {
        throw new Error(`Workspace mutation conflict: path escapes workspace: ${operation.path}`);
      }

      let originalBytes: Buffer | null = null;
      let originalMode = 0o644;
      let exists = false;
      try {
        const stat = await lstat(targetPath);
        exists = true;
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error(
            `Workspace mutation conflict: target is a symlink or non-file: ${operation.path}`,
          );
        }
        originalMode = stat.mode & 0o777;
        originalBytes = await readFile(targetPath);
        assertStrictUtf8(originalBytes, operation.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      const beforeHash = originalBytes === null ? null : sha256Bytes(originalBytes);
      if (operation.type === "CREATE") {
        if (exists || beforeHash !== null) {
          throw new Error(
            `Workspace mutation conflict: CREATE target already exists: ${operation.path}`,
          );
        }
      } else {
        if (!exists || beforeHash === null) {
          throw new Error(
            `Workspace mutation conflict: ${operation.type} target does not exist: ${operation.path}`,
          );
        }
        if (beforeHash !== operation.expectedBeforeHash) {
          throw new Error(
            `Workspace mutation conflict: before hash does not match: ${operation.path}`,
          );
        }
      }

      entries.push({
        operation,
        targetPath,
        originalBytes,
        originalMode,
        beforeHash,
      });
    }
    return entries;
  }

  private async atomicWrite(targetPath: string, bytes: Buffer, mode: number): Promise<void> {
    const temporaryPath = path.join(
      path.dirname(targetPath),
      `.karsift-mutation-${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, bytes, { flag: "wx", mode });
      await rename(temporaryPath, targetPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async restore(entries: readonly PreflightEntry[]): Promise<void> {
    for (const entry of [...entries].reverse()) {
      if (entry.originalBytes === null) {
        await rm(entry.targetPath, { force: true });
      } else {
        await this.atomicWrite(entry.targetPath, entry.originalBytes, entry.originalMode);
      }
    }
  }

  public async apply(input: {
    readonly workspacePath: string;
    readonly operations: readonly WorkspaceMutationOperation[];
  }): Promise<WorkspaceMutationApplyResult> {
    const startedAt = Date.now();
    const workspacePath = await this.resolveWorkspacePath(input.workspacePath);
    const operations = normalizeWorkspaceMutationOperations(input.operations);
    const entries = await this.preflight(workspacePath, operations);

    try {
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (!entry) {
          continue;
        }
        await this.faultInjector?.(index, entry.operation);
        if (entry.operation.type === "DELETE") {
          await rm(entry.targetPath);
        } else {
          const content = entry.operation.content;
          if (content === null) {
            throw new Error("Workspace mutation conflict: text content unexpectedly missing");
          }
          await this.atomicWrite(
            entry.targetPath,
            Buffer.from(content, "utf8"),
            entry.originalBytes === null ? 0o644 : entry.originalMode,
          );
        }
      }
    } catch (error) {
      try {
        await this.restore(entries);
      } catch (rollbackError) {
        const message = rollbackError instanceof Error ? rollbackError.message : "unknown rollback error";
        throw new Error(`Workspace mutation rollback failed: ${message}`);
      }
      throw error;
    }

    const pathEvidence: WorkspaceMutationPathEvidence[] = [];
    for (const entry of entries) {
      if (entry.operation.type === "DELETE") {
        let stillExists = false;
        try {
          await lstat(entry.targetPath);
          stillExists = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        if (stillExists) {
          throw new Error(
            `Workspace mutation conflict: DELETE target still exists: ${entry.operation.path}`,
          );
        }
        pathEvidence.push({
          type: entry.operation.type,
          path: entry.operation.path,
          beforeHash: entry.beforeHash,
          afterHash: null,
          beforeBytes: entry.originalBytes?.length ?? 0,
          afterBytes: 0,
        });
        continue;
      }

      const afterBytes = await readFile(entry.targetPath);
      assertStrictUtf8(afterBytes, entry.operation.path);
      const expectedBytes = Buffer.from(entry.operation.content ?? "", "utf8");
      const afterHash = sha256Bytes(afterBytes);
      if (afterHash !== sha256Bytes(expectedBytes)) {
        throw new Error(
          `Workspace mutation conflict: post-apply content does not match plan: ${entry.operation.path}`,
        );
      }
      pathEvidence.push({
        type: entry.operation.type,
        path: entry.operation.path,
        beforeHash: entry.beforeHash,
        afterHash,
        beforeBytes: entry.originalBytes?.length ?? 0,
        afterBytes: afterBytes.length,
      });
    }

    return {
      durationMs: Math.max(0, Date.now() - startedAt),
      pathEvidence,
    };
  }
}
