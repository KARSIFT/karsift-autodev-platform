import type { Actor } from "../store/types.js";
import type {
  BuilderSessionService,
  BuilderSessionStepResult,
} from "./builder-session-service.js";
import type { BuilderSessionExecutionService } from "./builder-session-execution-service.js";
import type { BuilderSessionTerminationService } from "./builder-session-termination-service.js";

export class GovernedBuilderSessionService {
  public constructor(
    private readonly sessionService: BuilderSessionService,
    private readonly terminationService: BuilderSessionTerminationService,
    private readonly executionService: BuilderSessionExecutionService,
  ) {}

  public async prepare(input: {
    readonly builderInvocationId: string;
    readonly actor: Actor;
  }): Promise<Record<string, unknown>> {
    return await this.sessionService.prepare(input);
  }

  public async step(input: {
    readonly builderSessionId: string;
    readonly claimOwner: string;
    readonly stepLeaseSeconds: number;
    readonly executionLeaseSeconds: number;
    readonly dispatchLeaseSeconds: number;
    readonly commandPolicyKey: string | null;
    readonly actor: Actor;
  }): Promise<BuilderSessionStepResult> {
    try {
      const result = await this.sessionService.step(input);
      const status = String(result.session.status);
      if (status === "COMPLETED" || status === "BLOCKED") {
        await this.executionService.settleTerminalSession({
          builderSessionId: input.builderSessionId,
          outcome: status,
          actor: input.actor,
        });
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown builder session error";
      if (
        message.includes("execution authority") ||
        message.includes("session execution authority is not active")
      ) {
        const failed = await this.terminationService.terminate({
          builderSessionId: input.builderSessionId,
          outcome: "FAILED",
          summary: "Builder session stopped because execution authority became stale or inactive.",
          actor: input.actor,
        });
        return {
          acquired: false,
          advanced: true,
          operation: "FAIL_STALE_AUTHORITY",
          reason: "STALE_EXECUTION_AUTHORITY",
          session: failed,
        };
      }
      throw error;
    }
  }

  public async cancel(input: {
    readonly builderSessionId: string;
    readonly summary: string;
    readonly actor: Actor;
  }): Promise<Record<string, unknown>> {
    return await this.terminationService.terminate({
      builderSessionId: input.builderSessionId,
      outcome: "CANCELLED",
      summary: input.summary,
      actor: input.actor,
    });
  }
}
