import type { Pool } from "pg";

import {
  buildBuilderSessionTerminalEvidenceContent,
  hashBuilderSessionTerminalEvidence,
} from "../domain/builder-session.js";
import type { Actor } from "../store/types.js";
import type { BuilderSessionExecutionService } from "./builder-session-execution-service.js";
import type { BuilderSessionProposalService } from "./builder-session-proposal-service.js";

export class BuilderSessionTerminationService {
  public constructor(
    private readonly pool: Pool,
    private readonly proposalService: BuilderSessionProposalService,
    private readonly executionService: BuilderSessionExecutionService,
  ) {}

  public async terminate(input: {
    readonly builderSessionId: string;
    readonly outcome: "FAILED" | "CANCELLED";
    readonly summary: string;
    readonly actor: Actor;
  }): Promise<Record<string, unknown>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sessionResult = await client.query(
        `SELECT session.*,
                row_to_json(evidence) AS evidence
           FROM builder_sessions session
           LEFT JOIN builder_session_evidence evidence
             ON evidence.builder_session_id = session.id
            AND evidence.project_id = session.project_id
          WHERE session.id = $1
          FOR UPDATE OF session`,
        [input.builderSessionId],
      );
      const session = sessionResult.rows[0] as Record<string, unknown> | undefined;
      if (!session) {
        throw new Error(`Builder session not found: ${input.builderSessionId}`);
      }
      if (["COMPLETED", "BLOCKED", "FAILED", "CANCELLED"].includes(String(session.status))) {
        await client.query("COMMIT");
        return session;
      }

      const evidenceInput = {
        outcome: input.outcome,
        turnCount: Number(session.turn_count),
        finalActionEvidenceId: null,
        finalActionEvidenceHash: null,
        summary: input.summary,
      } as const;
      const evidenceContent = buildBuilderSessionTerminalEvidenceContent(evidenceInput);
      const evidenceHash = hashBuilderSessionTerminalEvidence(evidenceInput);
      const evidenceResult = await client.query(
        `INSERT INTO builder_session_evidence(
           project_id, builder_session_id, outcome, turn_count,
           final_action_evidence_id, final_action_evidence_hash,
           summary, evidence_content, evidence_hash, created_by
         ) VALUES ($1, $2, $3, $4, NULL, NULL, $5, $6::jsonb, $7, $8)
         RETURNING *`,
        [
          session.project_id,
          input.builderSessionId,
          input.outcome,
          session.turn_count,
          input.summary,
          JSON.stringify(evidenceContent),
          evidenceHash,
          input.actor.id,
        ],
      );
      const evidence = evidenceResult.rows[0] as Record<string, unknown>;
      const updatedResult = await client.query(
        `UPDATE builder_sessions
            SET status = $2,
                state_version = state_version + 1,
                completed_at = now(),
                updated_at = now()
          WHERE id = $1
            AND status NOT IN ('COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED')
          RETURNING *`,
        [input.builderSessionId, input.outcome],
      );
      const updated = updatedResult.rows[0] as Record<string, unknown> | undefined;
      if (!updated) {
        throw new Error("Builder session conflict: terminal transition was not applied");
      }
      await client.query(
        `INSERT INTO audit_events(
           project_id, actor_type, actor_id, action, entity_type, entity_id, data
         ) VALUES ($1, $2, $3, 'BUILDER_SESSION_TERMINATED',
                   'BUILDER_SESSION', $4, $5::jsonb)`,
        [
          session.project_id,
          input.actor.type,
          input.actor.id,
          input.builderSessionId,
          JSON.stringify({ outcome: input.outcome, evidenceHash }),
        ],
      );
      await client.query("COMMIT");

      await this.proposalService
        .finishDispatch({
          builderSessionId: input.builderSessionId,
          outcome: "RELEASED",
          actor: input.actor,
        })
        .catch(() => undefined);
      if (input.outcome === "CANCELLED") {
        await this.executionService
          .releaseCancelledSession({
            builderSessionId: input.builderSessionId,
            actor: input.actor,
          })
          .catch(() => undefined);
      } else {
        await this.executionService
          .settleTerminalSession({
            builderSessionId: input.builderSessionId,
            outcome: "FAILED",
            actor: input.actor,
          })
          .catch(() => undefined);
      }
      return { ...updated, evidence };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
