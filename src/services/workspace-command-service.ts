import { createHash } from "node:crypto";

import type { BoundedWorkspaceCommandRunner } from "../commands/bounded-workspace-command-runner.js";
import type { WorkspaceCommandStore } from "../store/workspace-command-types.js";
import type { Actor } from "../store/types.js";

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Workspace command conflict: ${field} must be a string array`);
  }
  return value as string[];
}

function stringMap(value: unknown, field: string): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Workspace command conflict: ${field} must be an object`);
  }
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new Error(`Workspace command conflict: ${field} values must be strings`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Workspace command conflict: ${field} must be a positive integer`);
  }
  return value;
}

export class WorkspaceCommandService {
  public constructor(
    private readonly store: WorkspaceCommandStore,
    private readonly runner: BoundedWorkspaceCommandRunner,
  ) {}

  public async run(input: {
    readonly workspaceCommandRunId: string;
    readonly actor: Actor;
  }): Promise<Record<string, unknown>> {
    const claim = await this.store.claimWorkspaceCommandRun(
      input.workspaceCommandRunId,
      input.actor,
    );
    if (!claim.claimed) {
      const current = await this.store.getWorkspaceCommandRun(
        input.workspaceCommandRunId,
      );
      if (!current) {
        throw new Error(`Workspace command run not found: ${input.workspaceCommandRunId}`);
      }
      return current;
    }

    const plan = claim.plan;
    try {
      const runnerResult = await this.runner.execute({
        workspacePath: String(plan.workspace_path),
        executable: String(plan.executable),
        arguments: stringArray(plan.arguments, "arguments"),
        timeoutMs: positiveInteger(plan.timeout_ms, "timeout_ms"),
        maxOutputBytes: positiveInteger(plan.max_output_bytes, "max_output_bytes"),
        environment: stringMap(plan.environment, "environment"),
      });
      return await this.store.completeWorkspaceCommandRun({
        workspaceCommandRunId: input.workspaceCommandRunId,
        runnerResult,
        actor: input.actor,
      });
    } catch {
      const emptyHash = createHash("sha256").update("").digest("hex");
      return await this.store.completeWorkspaceCommandRun({
        workspaceCommandRunId: input.workspaceCommandRunId,
        runnerResult: {
          exitCode: null,
          signal: null,
          timedOut: false,
          durationMs: 0,
          stdoutSha256: emptyHash,
          stderrSha256: emptyHash,
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          errorCode: "RUNNER_ERROR",
        },
        actor: input.actor,
      });
    }
  }
}
