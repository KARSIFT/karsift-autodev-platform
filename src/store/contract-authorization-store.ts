import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  CONTRACT_AUTHORIZATION_POLICY_VERSION,
  evaluateContractAuthorization,
  extractContractGovernanceFacts,
  type ContractGovernanceFacts,
} from "../domain/contract-authorization.js";
import type { JsonValue } from "../domain/stable-json.js";
import type {
  ContractAuthorizationResult,
  ContractAuthorizationStore,
  RecordChangeContractAuthorizationInput,
} from "./contract-authorization-types.js";
import type { Actor } from "./types.js";

interface ContractAuthorizationContextRow extends QueryResultRow {
  readonly change_contract_id: string;
  readonly project_id: string;
  readonly contract_status: "DRAFT" | "AUTHORIZED" | "SUPERSEDED" | "CANCELLED";
  readonly current_version: number;
  readonly change_contract_version_id: string;
  readonly content: JsonValue;
  readonly content_hash: string;
}

async function appendAudit(
  client: PoolClient,
  params: {
    projectId: string;
    actor: Actor;
    action: string;
    entityType: string;
    entityId: string;
    data?: JsonValue;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events(
      project_id, actor_type, actor_id, action, entity_type, entity_id, data
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      params.projectId,
      params.actor.type,
      params.actor.id,
      params.action,
      params.entityType,
      params.entityId,
      JSON.stringify(params.data ?? {}),
    ],
  );
}

function assertAuthorizationActor(actor: Actor): asserts actor is Actor & {
  readonly type: "FOUNDER" | "SYSTEM";
} {
  if (actor.type !== "FOUNDER" && actor.type !== "SYSTEM") {
    throw new Error("Change Contract authorization requires founder or system authority");
  }
}

function requiredAuthorityForFacts(
  facts: ContractGovernanceFacts,
): "SYSTEM_OR_FOUNDER" | "FOUNDER" {
  return evaluateContractAuthorization(facts, "FOUNDER").requiredAuthority;
}

export class PostgresContractAuthorizationStore
  implements ContractAuthorizationStore
{
  public constructor(private readonly pool: Pool) {}

  private async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async recordChangeContractAuthorization(
    input: RecordChangeContractAuthorizationInput,
  ): Promise<ContractAuthorizationResult> {
    assertAuthorizationActor(input.actor);

    return this.transaction(async (client) => {
      const contextResult = await client.query<ContractAuthorizationContextRow>(
        `SELECT
           c.id AS change_contract_id,
           c.project_id,
           c.status AS contract_status,
           c.current_version,
           v.id AS change_contract_version_id,
           v.content,
           v.content_hash
         FROM change_contracts c
         JOIN change_contract_versions v
           ON v.contract_id = c.id
          AND v.project_id = c.project_id
          AND v.version = c.current_version
         WHERE c.id = $1
         FOR UPDATE OF c`,
        [input.changeContractId],
      );

      const context = contextResult.rows[0];
      if (!context) {
        throw new Error(`Change contract not found: ${input.changeContractId}`);
      }

      const facts = extractContractGovernanceFacts(context.content);
      const policyDecision = evaluateContractAuthorization(facts, input.actor.type);

      let decision: "AUTHORIZED" | "DENIED" | "REVOKED";
      let reasonCode:
        | "AUTHORIZED_BY_POLICY"
        | "FOUNDER_AUTHORITY_REQUIRED"
        | "R3_STRENGTHENED_GATES_REQUIRED"
        | "AUTHORIZATION_REVOKED";
      let authorized: boolean;

      if (input.action === "REVOKE") {
        decision = "REVOKED";
        reasonCode = "AUTHORIZATION_REVOKED";
        authorized = false;
      } else {
        if (
          context.contract_status === "SUPERSEDED" ||
          context.contract_status === "CANCELLED"
        ) {
          throw new Error(
            `Change Contract authorization conflict: status ${context.contract_status} cannot be authorized`,
          );
        }
        decision = policyDecision.authorized ? "AUTHORIZED" : "DENIED";
        reasonCode = policyDecision.reason;
        authorized = policyDecision.authorized;
      }

      const decisionResult = await client.query(
        `INSERT INTO change_contract_authorization_decisions(
           project_id,
           change_contract_id,
           change_contract_version_id,
           change_contract_version,
           contract_content_hash,
           policy_version,
           risk_level,
           decision,
           reason_code,
           required_authority,
           policy_facts,
           rationale,
           actor_type,
           actor_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14
         )
         RETURNING *`,
        [
          context.project_id,
          context.change_contract_id,
          context.change_contract_version_id,
          context.current_version,
          context.content_hash,
          CONTRACT_AUTHORIZATION_POLICY_VERSION,
          facts.riskLevel,
          decision,
          reasonCode,
          requiredAuthorityForFacts(facts),
          JSON.stringify(facts),
          input.rationale,
          input.actor.type,
          input.actor.id,
        ],
      );

      if (decision === "AUTHORIZED") {
        await client.query(
          `UPDATE change_contracts
              SET status = 'AUTHORIZED', updated_at = now()
            WHERE id = $1`,
          [context.change_contract_id],
        );
      } else if (decision === "REVOKED") {
        await client.query(
          `UPDATE change_contracts
              SET status = CASE
                    WHEN status IN ('SUPERSEDED', 'CANCELLED') THEN status
                    ELSE 'DRAFT'
                  END,
                  updated_at = now()
            WHERE id = $1`,
          [context.change_contract_id],
        );
      }

      const record = decisionResult.rows[0] as Record<string, unknown>;
      await appendAudit(client, {
        projectId: context.project_id,
        actor: input.actor,
        action: `CHANGE_CONTRACT_AUTHORIZATION_${decision}`,
        entityType: "CHANGE_CONTRACT_AUTHORIZATION_DECISION",
        entityId: String(record.id),
        data: {
          changeContractId: context.change_contract_id,
          changeContractVersionId: context.change_contract_version_id,
          changeContractVersion: context.current_version,
          contractContentHash: context.content_hash,
          policyVersion: CONTRACT_AUTHORIZATION_POLICY_VERSION,
          riskLevel: facts.riskLevel,
          decision,
          reasonCode,
        },
      });

      return { decision: record, authorized };
    });
  }

  public async getProjectAuthorizationStatus(
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const [counts, recent] = await Promise.all([
      this.pool.query(
        `SELECT decision, count(*)::text AS count
           FROM change_contract_authorization_decisions
          WHERE project_id = $1
          GROUP BY decision
          ORDER BY decision`,
        [projectId],
      ),
      this.pool.query(
        `SELECT *
           FROM change_contract_authorization_decisions
          WHERE project_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 20`,
        [projectId],
      ),
    ]);

    return {
      authorizationDecisionCounts: counts.rows,
      recentAuthorizationDecisions: recent.rows,
    };
  }

  public async getPlatformAuthorizationStatus(): Promise<Record<string, unknown>> {
    const counts = await this.pool.query(
      `SELECT decision, count(*)::text AS count
         FROM change_contract_authorization_decisions
        GROUP BY decision
        ORDER BY decision`,
    );

    return { authorizationDecisionCounts: counts.rows };
  }
}
