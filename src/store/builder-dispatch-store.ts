import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  assertDispatchLeaseSeconds,
  builderDispatchIdempotencyKey,
  evaluateLatestBuilderProviderReadiness,
} from "../domain/builder-dispatch.js";
import type { ProviderCapacityStatus } from "../domain/provider-capacity.js";
import type { JsonValue } from "../domain/stable-json.js";
import type {
  AcquireBuilderDispatchClaimInput,
  BuilderDispatchStore,
  CompleteBuilderDispatchClaimInput,
  HeartbeatBuilderDispatchClaimInput,
  ReleaseBuilderDispatchClaimInput,
} from "./builder-runtime-types.js";
import type { Actor } from "./types.js";

interface DispatchContextRow extends QueryResultRow {
  readonly invocation_id: string;
  readonly project_id: string;
  readonly invocation_status: string;
  readonly builder_invocation_plan_id: string;
  readonly plan_hash: string;
  readonly provider_dispatch_decision_id: string;
  readonly provider_key: string;
  readonly execution_attempt_id: string;
  readonly attempt_status: string;
  readonly attempt_lease_active: boolean;
  readonly ai_dispatch_enabled: boolean;
}

interface CapacityObservationRow extends QueryResultRow {
  readonly id: string;
  readonly status: ProviderCapacityStatus;
  readonly fresh: boolean;
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

export class PostgresBuilderDispatchStore implements BuilderDispatchStore {
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

  public async acquireBuilderDispatchClaim(
    input: AcquireBuilderDispatchClaimInput,
  ): Promise<Record<string, unknown>> {
    assertDispatchLeaseSeconds(input.leaseSeconds);
    if (input.claimOwner.trim().length === 0) {
      throw new Error("claimOwner must not be empty");
    }

    return this.transaction(async (client) => {
      const contextResult = await client.query<DispatchContextRow>(
        `SELECT
           invocation.id AS invocation_id,
           invocation.project_id,
           invocation.status AS invocation_status,
           plan.id AS builder_invocation_plan_id,
           plan.plan_hash,
           plan.provider_dispatch_decision_id,
           plan.provider_key,
           attempt.id AS execution_attempt_id,
           attempt.status AS attempt_status,
           attempt.lease_expires_at > now() AS attempt_lease_active,
           is_effective_capability_enabled(invocation.project_id, 'AI_DISPATCH')
             AS ai_dispatch_enabled
         FROM builder_invocations invocation
         JOIN builder_invocation_plans plan
           ON plan.id = invocation.builder_invocation_plan_id
          AND plan.project_id = invocation.project_id
         JOIN execution_attempts attempt
           ON attempt.id = invocation.execution_attempt_id
          AND attempt.project_id = invocation.project_id
         WHERE invocation.id = $1
         FOR UPDATE OF invocation`,
        [input.builderInvocationId],
      );
      const context = contextResult.rows[0];
      if (!context) {
        throw new Error(`Builder invocation not found: ${input.builderInvocationId}`);
      }

      const expiredResult = await client.query(
        `UPDATE builder_dispatch_claims
            SET status = 'EXPIRED',
                completed_at = now()
          WHERE builder_invocation_id = $1
            AND project_id = $2
            AND status = 'ACTIVE'
            AND lease_expires_at <= now()
          RETURNING id`,
        [context.invocation_id, context.project_id],
      );
      for (const expired of expiredResult.rows) {
        await appendAudit(client, {
          projectId: context.project_id,
          actor: input.actor,
          action: "BUILDER_DISPATCH_CLAIM_EXPIRED",
          entityType: "BUILDER_DISPATCH_CLAIM",
          entityId: String(expired.id),
          data: { builderInvocationId: context.invocation_id },
        });
      }

      const activeResult = await client.query(
        `SELECT claim.*,
                row_to_json(revalidation) AS revalidation
           FROM builder_dispatch_claims claim
           LEFT JOIN builder_dispatch_revalidations revalidation
             ON revalidation.builder_dispatch_claim_id = claim.id
            AND revalidation.project_id = claim.project_id
          WHERE claim.builder_invocation_id = $1
            AND claim.project_id = $2
            AND claim.status = 'ACTIVE'
            AND claim.lease_expires_at > now()
          LIMIT 1`,
        [context.invocation_id, context.project_id],
      );
      const activeClaim = activeResult.rows[0] as Record<string, unknown> | undefined;
      if (activeClaim) {
        return {
          acquired: false,
          reason: "ALREADY_CLAIMED",
          claim: activeClaim,
          revalidation: activeClaim.revalidation ?? null,
        };
      }

      if (!context.ai_dispatch_enabled) {
        throw new Error(
          "Builder dispatch claim conflict: AI_DISPATCH capability is not enabled",
        );
      }
      if (
        !["PREPARED", "RUNNING"].includes(context.invocation_status) ||
        context.attempt_status !== "ACTIVE" ||
        !context.attempt_lease_active
      ) {
        return {
          acquired: false,
          reason: "INVOCATION_NOT_DISPATCHABLE",
          claim: null,
          revalidation: null,
        };
      }

      const idempotencyKey = builderDispatchIdempotencyKey(context.plan_hash);
      const claimResult = await client.query(
        `INSERT INTO builder_dispatch_claims(
           project_id,
           builder_invocation_id,
           builder_invocation_plan_id,
           plan_hash,
           idempotency_key,
           claim_owner,
           lease_expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 * interval '1 second'))
         RETURNING *`,
        [
          context.project_id,
          context.invocation_id,
          context.builder_invocation_plan_id,
          context.plan_hash,
          idempotencyKey,
          input.claimOwner,
          input.leaseSeconds,
        ],
      );
      let claim = claimResult.rows[0] as Record<string, unknown>;

      const observationResult = await client.query<CapacityObservationRow>(
        `SELECT observation.id,
                observation.status,
                observation.expires_at > now() AS fresh
           FROM ai_provider_capacity_observations observation
          WHERE observation.project_id = $1
            AND observation.provider_key = $2
            AND observation.capability = 'CODE_BUILDER'
          ORDER BY observation.observed_at DESC, observation.id DESC
          LIMIT 1`,
        [context.project_id, context.provider_key],
      );
      const observation = observationResult.rows[0] ?? null;
      const readiness = evaluateLatestBuilderProviderReadiness(
        observation
          ? { status: observation.status, fresh: observation.fresh }
          : null,
      );

      const revalidationResult = await client.query(
        `INSERT INTO builder_dispatch_revalidations(
           project_id,
           builder_dispatch_claim_id,
           builder_invocation_id,
           provider_dispatch_decision_id,
           provider_key,
           capability,
           capacity_observation_id,
           outcome,
           waiting_reason,
           reason_code,
           created_by
         ) VALUES ($1, $2, $3, $4, $5, 'CODE_BUILDER', $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          context.project_id,
          claim.id,
          context.invocation_id,
          context.provider_dispatch_decision_id,
          context.provider_key,
          observation?.id ?? null,
          readiness.outcome,
          readiness.waitingReason,
          readiness.reason,
          input.actor.id,
        ],
      );
      const revalidation = revalidationResult.rows[0] as Record<string, unknown>;

      if (readiness.outcome !== "READY") {
        const releasedResult = await client.query(
          `UPDATE builder_dispatch_claims
              SET status = 'RELEASED', completed_at = now()
            WHERE id = $1
            RETURNING *`,
          [claim.id],
        );
        claim = releasedResult.rows[0] as Record<string, unknown>;
      }

      await appendAudit(client, {
        projectId: context.project_id,
        actor: input.actor,
        action:
          readiness.outcome === "READY"
            ? "BUILDER_DISPATCH_CLAIM_ACQUIRED"
            : "BUILDER_DISPATCH_REVALIDATION_WAIT",
        entityType: "BUILDER_DISPATCH_CLAIM",
        entityId: String(claim.id),
        data: {
          builderInvocationId: context.invocation_id,
          idempotencyKey,
          providerKey: context.provider_key,
          capacityObservationId: observation?.id ?? null,
          outcome: readiness.outcome,
          waitingReason: readiness.waitingReason,
          reason: readiness.reason,
        },
      });

      return {
        acquired: readiness.outcome === "READY",
        reason:
          readiness.outcome === "READY"
            ? "CLAIM_ACQUIRED"
            : readiness.reason,
        claim,
        revalidation,
      };
    });
  }

  public async heartbeatBuilderDispatchClaim(
    input: HeartbeatBuilderDispatchClaimInput,
  ): Promise<Record<string, unknown>> {
    assertDispatchLeaseSeconds(input.leaseSeconds);
    const result = await this.pool.query(
      `UPDATE builder_dispatch_claims
          SET heartbeat_at = now(),
              lease_expires_at = now() + ($3 * interval '1 second')
        WHERE id = $1
          AND claim_token = $2::uuid
          AND status = 'ACTIVE'
          AND lease_expires_at > now()
        RETURNING *`,
      [input.builderDispatchClaimId, input.claimToken, input.leaseSeconds],
    );
    const claim = result.rows[0] as Record<string, unknown> | undefined;
    if (!claim) {
      throw new Error(
        "Builder dispatch claim conflict: claim is missing, expired, or no longer active",
      );
    }
    return claim;
  }

  public async releaseBuilderDispatchClaim(
    input: ReleaseBuilderDispatchClaimInput,
  ): Promise<Record<string, unknown>> {
    return this.finishClaim(input.builderDispatchClaimId, input.claimToken, "RELEASED", input.actor);
  }

  public async completeBuilderDispatchClaim(
    input: CompleteBuilderDispatchClaimInput,
  ): Promise<Record<string, unknown>> {
    return this.finishClaim(input.builderDispatchClaimId, input.claimToken, "COMPLETED", input.actor);
  }

  private async finishClaim(
    claimId: string,
    claimToken: string,
    status: "RELEASED" | "COMPLETED",
    actor: Actor,
  ): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE builder_dispatch_claims
            SET status = $3,
                completed_at = now()
          WHERE id = $1
            AND claim_token = $2::uuid
            AND status = 'ACTIVE'
          RETURNING *`,
        [claimId, claimToken, status],
      );
      const claim = result.rows[0] as Record<string, unknown> | undefined;
      if (!claim) {
        throw new Error(
          "Builder dispatch claim conflict: claim is missing or no longer active",
        );
      }

      await appendAudit(client, {
        projectId: String(claim.project_id),
        actor,
        action: `BUILDER_DISPATCH_CLAIM_${status}`,
        entityType: "BUILDER_DISPATCH_CLAIM",
        entityId: claimId,
        data: { builderInvocationId: String(claim.builder_invocation_id) },
      });
      return claim;
    });
  }

  public async getProjectBuilderDispatchStatus(
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const [counts, recent] = await Promise.all([
      this.pool.query(
        `SELECT status, count(*)::text AS count
           FROM builder_dispatch_claims
          WHERE project_id = $1
          GROUP BY status
          ORDER BY status`,
        [projectId],
      ),
      this.pool.query(
        `SELECT claim.id,
                claim.builder_invocation_id,
                claim.status,
                claim.idempotency_key,
                claim.claim_owner,
                claim.lease_expires_at,
                revalidation.outcome,
                revalidation.waiting_reason,
                revalidation.reason_code,
                revalidation.capacity_observation_id,
                claim.created_at,
                claim.completed_at
           FROM builder_dispatch_claims claim
           LEFT JOIN builder_dispatch_revalidations revalidation
             ON revalidation.builder_dispatch_claim_id = claim.id
            AND revalidation.project_id = claim.project_id
          WHERE claim.project_id = $1
          ORDER BY claim.created_at DESC, claim.id DESC
          LIMIT 20`,
        [projectId],
      ),
    ]);
    return {
      builderDispatchClaimCounts: counts.rows,
      recentBuilderDispatchClaims: recent.rows,
    };
  }

  public async getPlatformBuilderDispatchStatus(): Promise<
    Record<string, unknown>
  > {
    const counts = await this.pool.query(
      `SELECT status, count(*)::text AS count
         FROM builder_dispatch_claims
        GROUP BY status
        ORDER BY status`,
    );
    return { builderDispatchClaimCounts: counts.rows };
  }
}
