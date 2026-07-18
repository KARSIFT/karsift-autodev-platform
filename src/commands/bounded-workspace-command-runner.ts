import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export interface WorkspaceCommandRunnerInput {
  readonly workspacePath: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly environment: Readonly<Record<string, string>>;
}

export interface WorkspaceCommandRunnerResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly errorCode: string | null;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sanitizeErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) {
    return code;
  }
  return "SPAWN_ERROR";
}

export class BoundedWorkspaceCommandRunner {
  public constructor(private readonly workspaceRoot: string) {}

  public async execute(
    input: WorkspaceCommandRunnerInput,
  ): Promise<WorkspaceCommandRunnerResult> {
    const root = path.resolve(this.workspaceRoot);
    const workspacePath = path.resolve(input.workspacePath);
    if (!isWithinRoot(root, workspacePath)) {
      throw new Error("workspace command path must be a child of the configured workspace root");
    }
    const stat = await lstat(workspacePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("workspace command path must be a real directory");
    }
    if (
      !Number.isInteger(input.timeoutMs) ||
      input.timeoutMs <= 0 ||
      !Number.isInteger(input.maxOutputBytes) ||
      input.maxOutputBytes <= 0
    ) {
      throw new Error("workspace command limits must be positive integers");
    }

    const safeEnvironment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: "/tmp",
      CI: "true",
      LANG: "C.UTF-8",
    };
    for (const [key, value] of Object.entries(input.environment)) {
      safeEnvironment[key] = value;
    }

    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let capturedBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    const startedAt = Date.now();

    return await new Promise<WorkspaceCommandRunnerResult>((resolve) => {
      let timeoutHandle: NodeJS.Timeout | undefined;
      let killHandle: NodeJS.Timeout | undefined;
      const child = spawn(input.executable, [...input.arguments], {
        cwd: workspacePath,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: safeEnvironment,
      });

      const finish = (params: {
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        errorCode: string | null;
      }): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (killHandle) {
          clearTimeout(killHandle);
        }
        resolve({
          exitCode: params.exitCode,
          signal: params.signal,
          timedOut,
          durationMs: Math.max(0, Date.now() - startedAt),
          stdoutSha256: stdoutHash.digest("hex"),
          stderrSha256: stderrHash.digest("hex"),
          stdoutBytes,
          stderrBytes,
          stdoutTruncated,
          stderrTruncated,
          errorCode: params.errorCode,
        });
      };

      const recordOutput = (
        stream: "stdout" | "stderr",
        chunk: Buffer,
      ): void => {
        const hash = stream === "stdout" ? stdoutHash : stderrHash;
        hash.update(chunk);
        if (stream === "stdout") {
          stdoutBytes += chunk.length;
        } else {
          stderrBytes += chunk.length;
        }

        const remaining = Math.max(0, input.maxOutputBytes - capturedBytes);
        const accepted = Math.min(remaining, chunk.length);
        capturedBytes += accepted;
        if (accepted < chunk.length) {
          if (stream === "stdout") {
            stdoutTruncated = true;
          } else {
            stderrTruncated = true;
          }
        }
      };

      child.stdout.on("data", (chunk: Buffer) => recordOutput("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => recordOutput("stderr", chunk));
      child.on("error", (error) => {
        finish({ exitCode: null, signal: null, errorCode: sanitizeErrorCode(error) });
      });
      child.on("close", (exitCode, signal) => {
        finish({ exitCode, signal, errorCode: null });
      });

      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killHandle = setTimeout(() => child.kill("SIGKILL"), 1_000);
        killHandle.unref();
      }, input.timeoutMs);
      timeoutHandle.unref();
    });
  }
}
