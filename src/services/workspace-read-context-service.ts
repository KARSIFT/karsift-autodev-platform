import type { WorkspaceReadContextCapturer } from "../repository/workspace-read-context-capturer.js";
import type { WorkspaceReadContextStore } from "../store/workspace-read-context-types.js";
import type { Actor } from "../store/types.js";

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Workspace read context conflict: ${field} must be a string array`);
  }
  return value as string[];
}

export class WorkspaceReadContextService {
  public constructor(
    private readonly store: WorkspaceReadContextStore,
    private readonly capturer: WorkspaceReadContextCapturer,
  ) {}

  public async capture(input: {
    readonly workspaceReadContextRunId: string;
    readonly actor: Actor;
  }): Promise<Record<string, unknown>> {
    const claim = await this.store.claimWorkspaceReadContextRun(
      input.workspaceReadContextRunId,
      input.actor,
    );
    if (!claim.claimed) {
      const current = await this.store.getWorkspaceReadContextRun(
        input.workspaceReadContextRunId,
      );
      if (!current) {
        throw new Error(
          `Workspace read context run not found: ${input.workspaceReadContextRunId}`,
        );
      }
      return current;
    }

    const request = claim.request;
    try {
      const files = await this.capturer.capture({
        workspacePath: String(request.workspace_path),
        relevantPaths: stringArray(request.relevant_paths, "relevant paths"),
        requestedPaths: stringArray(request.requested_paths, "requested paths"),
      });
      return await this.store.completeWorkspaceReadContext({
        workspaceReadContextRunId: input.workspaceReadContextRunId,
        files,
        actor: input.actor,
      });
    } catch (error) {
      await this.store
        .failWorkspaceReadContext({
          workspaceReadContextRunId: input.workspaceReadContextRunId,
          actor: input.actor,
        })
        .catch(() => undefined);
      throw error;
    }
  }
}
