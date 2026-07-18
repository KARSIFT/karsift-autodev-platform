import type { WorkspaceMutationOperation } from "../domain/workspace-mutation.js";
import type { AtomicWorkspaceMutationApplier } from "../repository/atomic-workspace-mutation-applier.js";
import type { WorkspaceMutationStore } from "../store/workspace-mutation-types.js";
import type { Actor } from "../store/types.js";

function parseOperations(value: unknown): WorkspaceMutationOperation[] {
  if (!Array.isArray(value)) {
    throw new Error("Workspace mutation conflict: immutable plan operations are invalid");
  }
  return value.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Workspace mutation conflict: immutable plan operation is invalid");
    }
    const record = item as Record<string, unknown>;
    if (
      !["CREATE", "UPDATE", "DELETE"].includes(String(record.type)) ||
      typeof record.path !== "string" ||
      (record.expectedBeforeHash !== null &&
        typeof record.expectedBeforeHash !== "string") ||
      (record.content !== null && typeof record.content !== "string")
    ) {
      throw new Error("Workspace mutation conflict: immutable plan operation shape is invalid");
    }
    return {
      type: record.type as "CREATE" | "UPDATE" | "DELETE",
      path: record.path,
      expectedBeforeHash: record.expectedBeforeHash as string | null,
      content: record.content as string | null,
    };
  });
}

function stableErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("rollback failed")) {
    return "ROLLBACK_FAILED";
  }
  if (
    message.includes("before hash") ||
    message.includes("target already exists") ||
    message.includes("target does not exist")
  ) {
    return "PRECONDITION_FAILED";
  }
  if (
    message.includes("symlink") ||
    message.includes("escapes workspace") ||
    message.includes("workspace root") ||
    message.includes("valid UTF-8") ||
    message.includes("non-file")
  ) {
    return "PATH_SAFETY_ERROR";
  }
  return "APPLY_ERROR";
}

export class WorkspaceMutationService {
  public constructor(
    private readonly store: WorkspaceMutationStore,
    private readonly applier: AtomicWorkspaceMutationApplier,
  ) {}

  public async apply(input: {
    readonly workspaceMutationRunId: string;
    readonly actor: Actor;
  }): Promise<Record<string, unknown>> {
    const claim = await this.store.claimWorkspaceMutationRun(
      input.workspaceMutationRunId,
      input.actor,
    );
    if (!claim.claimed) {
      const current = await this.store.getWorkspaceMutationRun(
        input.workspaceMutationRunId,
      );
      if (!current) {
        throw new Error(`Workspace mutation run not found: ${input.workspaceMutationRunId}`);
      }
      return current;
    }

    const startedAt = Date.now();
    const plan = claim.plan;
    try {
      const result = await this.applier.apply({
        workspacePath: String(plan.workspace_path),
        operations: parseOperations(plan.operations),
      });
      return await this.store.completeWorkspaceMutationRun({
        workspaceMutationRunId: input.workspaceMutationRunId,
        outcome: "APPLIED",
        durationMs: result.durationMs,
        pathEvidence: result.pathEvidence,
        errorCode: null,
        actor: input.actor,
      });
    } catch (error) {
      return await this.store.completeWorkspaceMutationRun({
        workspaceMutationRunId: input.workspaceMutationRunId,
        outcome: "FAILED",
        durationMs: Math.max(0, Date.now() - startedAt),
        pathEvidence: [],
        errorCode: stableErrorCode(error),
        actor: input.actor,
      });
    }
  }
}
