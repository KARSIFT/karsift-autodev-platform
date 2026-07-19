import type { Pool } from "pg";

import type { WorkQueueStore } from "../store/work-queue-types.js";
import type { Actor } from "../store/types.js";

export class BuilderSessionExecutionService {
  public constructor(
    private readonly pool: Pool,
    private readonly workQueueStore: WorkQueueStore,
  ) {}

  private async executionContext(
    builderSessionId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT attempt.id AS execution_attempt_id,
              attempt.lease_token,
              attempt.status AS execution_attempt_status
         FROM builder_sessions session
         JOIN builder_session_plans session_plan
           ON session_plan.id = session.builder_session_plan_id
          AND session_plan.project_id = session.project_id
         JOIN execution_attempts attempt
           ON attempt.id = session_plan.execution_attempt_id
          AND attempt.project_id = session_plan.project_id
        WHERE session.id = $1`,
      [builderSessionId],
    );
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  public async settleTerminalSession(input: {
    readonly builderSessionId: string;
    readonly outcome: "COMPLETED" | "BLOCKED" | "FAILED";
    readonly actor: Actor;
  }): Promise<void> {
    const context = await this.executionContext(input.builderSessionId);
    if (!context || context.execution_attempt_status !== "ACTIVE") {
      return;
    }
    await this.workQueueStore.completeExecutionLease({
      executionAttemptId: String(context.execution_attempt_id),
      leaseToken: String(context.lease_token),
      outcome: input.outcome === "COMPLETED" ? "SUCCEEDED" : "FAILED",
      details: {
        source: "BUILDER_SESSION",
        builderSessionId: input.builderSessionId,
        sessionOutcome: input.outcome,
      },
      actor: input.actor,
    });
  }

  public async releaseCancelledSession(input: {
    readonly builderSessionId: string;
    readonly actor: Actor;
  }): Promise<void> {
    const context = await this.executionContext(input.builderSessionId);
    if (!context || context.execution_attempt_status !== "ACTIVE") {
      return;
    }
    await this.workQueueStore.releaseExecutionLease({
      executionAttemptId: String(context.execution_attempt_id),
      leaseToken: String(context.lease_token),
      waitingReason: "POLICY",
      actor: input.actor,
    });
  }
}
