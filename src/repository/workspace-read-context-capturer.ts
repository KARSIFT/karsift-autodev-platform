import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  MAX_READ_CONTEXT_FILE_BYTES,
  MAX_READ_CONTEXT_FILES,
  MAX_READ_CONTEXT_TOTAL_BYTES,
  isProtectedReadContextPath,
  normalizeWorkspaceReadContextRequestedPaths,
  type WorkspaceReadContextFile,
} from "../domain/workspace-read-context.js";

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeUtf8(bytes: Buffer, relativePath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Workspace read context conflict: file is not valid UTF-8 text: ${relativePath}`);
  }
}

export class WorkspaceReadContextCapturer {
  public constructor(private readonly workspaceRoot: string) {}

  private async resolveWorkspacePath(workspacePathInput: string): Promise<string> {
    const configuredRoot = await realpath(path.resolve(this.workspaceRoot));
    const workspacePath = await realpath(path.resolve(workspacePathInput));
    if (workspacePath === configuredRoot || !isWithinRoot(configuredRoot, workspacePath)) {
      throw new Error("Workspace read context path must be a child of the configured workspace root");
    }
    const stat = await lstat(workspacePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Workspace read context path must be a real directory");
    }
    return workspacePath;
  }

  private async expandOne(
    workspacePath: string,
    relativePath: string,
    files: Set<string>,
  ): Promise<void> {
    if (isProtectedReadContextPath(relativePath)) {
      throw new Error(`Workspace read context protected path: ${relativePath}`);
    }
    const absolutePath = path.resolve(workspacePath, relativePath);
    if (!isWithinRoot(workspacePath, absolutePath) || absolutePath === workspacePath) {
      throw new Error(`Workspace read context conflict: path escapes workspace: ${relativePath}`);
    }

    let stat;
    try {
      stat = await lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Workspace read context conflict: requested path does not exist: ${relativePath}`);
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Workspace read context conflict: symlink is not allowed: ${relativePath}`);
    }
    if (stat.isFile()) {
      files.add(relativePath);
      if (files.size > MAX_READ_CONTEXT_FILES) {
        throw new Error(`Workspace read context cannot exceed ${MAX_READ_CONTEXT_FILES} files`);
      }
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Workspace read context conflict: special file is not allowed: ${relativePath}`);
    }

    const entries = await readdir(absolutePath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childPath = `${relativePath}/${entry.name}`;
      if (isProtectedReadContextPath(childPath)) {
        throw new Error(`Workspace read context protected path: ${childPath}`);
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Workspace read context conflict: symlink is not allowed: ${childPath}`);
      }
      if (entry.isDirectory() || entry.isFile()) {
        await this.expandOne(workspacePath, childPath, files);
        continue;
      }
      throw new Error(`Workspace read context conflict: special file is not allowed: ${childPath}`);
    }
  }

  private async expandRequestedPaths(
    workspacePath: string,
    requestedPaths: readonly string[],
  ): Promise<readonly string[]> {
    const files = new Set<string>();
    for (const requestedPath of requestedPaths) {
      await this.expandOne(workspacePath, requestedPath, files);
    }
    return [...files].sort((left, right) => left.localeCompare(right));
  }

  private async readStableFiles(
    workspacePath: string,
    filePaths: readonly string[],
  ): Promise<readonly WorkspaceReadContextFile[]> {
    const files: WorkspaceReadContextFile[] = [];
    let totalBytes = 0;
    for (const relativePath of filePaths) {
      const absolutePath = path.resolve(workspacePath, relativePath);
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Workspace read context conflict: file type changed during capture: ${relativePath}`);
      }
      const bytes = await readFile(absolutePath);
      if (bytes.length > MAX_READ_CONTEXT_FILE_BYTES) {
        throw new Error(
          `Workspace read context file exceeds ${MAX_READ_CONTEXT_FILE_BYTES} bytes: ${relativePath}`,
        );
      }
      totalBytes += bytes.length;
      if (totalBytes > MAX_READ_CONTEXT_TOTAL_BYTES) {
        throw new Error(
          `Workspace read context cannot exceed ${MAX_READ_CONTEXT_TOTAL_BYTES} total bytes`,
        );
      }
      const content = decodeUtf8(bytes, relativePath);
      files.push({
        path: relativePath,
        content,
        contentHash: sha256(bytes),
        bytes: bytes.length,
      });
    }
    return files;
  }

  public async capture(input: {
    readonly workspacePath: string;
    readonly relevantPaths: readonly string[];
    readonly requestedPaths: readonly string[];
  }): Promise<readonly WorkspaceReadContextFile[]> {
    const workspacePath = await this.resolveWorkspacePath(input.workspacePath);
    const requestedPaths = normalizeWorkspaceReadContextRequestedPaths(
      input.requestedPaths,
      input.relevantPaths,
    );
    const firstExpansion = await this.expandRequestedPaths(workspacePath, requestedPaths);
    if (firstExpansion.length === 0) {
      throw new Error("Workspace read context snapshot must contain at least one file");
    }
    const files = await this.readStableFiles(workspacePath, firstExpansion);

    const secondExpansion = await this.expandRequestedPaths(workspacePath, requestedPaths);
    if (
      secondExpansion.length !== firstExpansion.length ||
      secondExpansion.some((filePath, index) => filePath !== firstExpansion[index])
    ) {
      throw new Error("Workspace read context conflict: file set changed during capture");
    }
    for (const file of files) {
      const bytes = await readFile(path.resolve(workspacePath, file.path));
      if (bytes.length !== file.bytes || sha256(bytes) !== file.contentHash) {
        throw new Error(`Workspace read context conflict: file changed during capture: ${file.path}`);
      }
    }
    return files;
  }
}
