import type { Pool } from "pg";

import type { BuilderProposalAdapterRegistry } from "../agents/builder-proposal-adapter.js";
import type { BuilderProposalStore } from "../store/builder-proposal-types.js";
import type { BuilderDispatchStore } from "../store/builder-runtime-types.js";
import type { Actor } from "../store/types.js";

function recordField(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Builder session proposal response ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Builder session proposal response ${field} must be a non-empty string`);
  }
  return value;
}

export class BuilderSessionProposalService {
  public constructor(
    private readonly pool: Pool,
    private readonly proposalStore: BuilderProposalStore,
    private readonly dispatchStore: BuilderDispatchStore,
    private readonly adapters: BuilderProposalAdapterRegistry,
  ) {}

  private async sessionDispatchContext(
    builderSessionId: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `SELECT session.id AS builder_session_id,
              session.project_id,
              session.status,
              session.builder_invocation_id,
              session.builder_dispatch_claim_id,
              session.builder_dispatch_revalidation_id,
              claim.claim_owner,
              claim.claim_token,
              claim.status AS claim_status,
              claim.lease_expires_at AS claim_lease_expires_at,
              revalidation.outcome AS revalidation_outcome
         FROM builder_sessions session
         LEFT JOIN builder_dispatch_claims claim
           ON claim.id = session.builder_dispatch_claim_id
          AND claim.project_id = session.project_id
         LEFT JOIN builder_dispatch_revalidations revalidation
           ON revalidation.id = session.builder_dispatch_revalidation_id
          AND revalidation.project_id = session.project_id
        WHERE session.id = $1`,
      [builderSessionId],
    );
    const context = result.rows[0] as Record<string, unknown> | undefined;
    if (!context) {
      throw new Error(`Builder session not found: ${builderSessionId}`);
    }
    return context;
  }

  private async bindDispatchClaim(input: {
    readonly builderSessionId: string;
    readonly stepClaimId: string;
    readonly stepClaimToken: string;
    readonly claimId: string;
    readonly revalidationId: string;
  }): Promise<void> {
    const result = await this.pool.query(
      `UPDATE builder_sessions session
          SET builder_dispatch_claim_id = $4,
              builder_dispatch_revalidation_id = $5,
              state_version = state_version + 1,
              updated_at = now()
        WHERE session.id = $1
          AND session.status = 'READY_FOR_TURN'
          AND session.builder_dispatch_claim_id IS NULL
          AND EXISTS (
            SELECT 1
              FROM builder_session_step_claims step_claim
             WHERE step_claim.id = $2
               AND step_claim.builder_session_id = session.id
               AND step_claim.claim_token = $3::uuid
               AND step_claim.status = 'ACTIVE'
               AND step_claim.lease_expires_at > now()
          )
        RETURNING session.id`,
      [
        input.builderSessionId,
        input.stepClaimId,
        input.stepClaimToken,
        input.claimId,
        input.revalidationId,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error(
        "Builder session proposal conflict: session dispatch claim could not be bound",
      );
    }
  }

  private async activeSessionClaim(input: {
    readonly builderSessionId: string;
    readonly stepClaimId: string;
    readonly stepClaimToken: string;
    readonly claimLeaseSeconds: number;
    readonly actor: Actor;
  }): Promise<{
    readonly claim: Record<string, unknown>;
    readonly revalidation: Record<string, unknown>;
  } | null> {
    let context = await this.sessionDispatchContext(input.builderSessionId);
    const expectedOwner = `builder-session:${input.builderSessionId}`;

    if (context.builder_dispatch_claim_id === null) {
      const dispatch = await this.dispatchStore.acquireBuilderDispatchClaim({
        builderInvocationId: requiredString(
          context.builder_invocation_id,
          "session.builder_invocation_id",
        ),
        claimOwner: expectedOwner,
        leaseSeconds: input.claimLeaseSeconds,
        actor: input.actor,
      });
      const claim = dispatch.claim as Record<string, unknown> | null | undefined;
      const revalidation = dispatch.revalidation as Record<string, unknown> | null | undefined;
      if (!claim || !revalidation) {
        return null;
      }
      if (!dispatch.acquired && claim.claim_owner !== expectedOwner) {
        return null;
      }
      if (String(claim.status) !== "ACTIVE" || String(revalidation.outcome) !== "READY") {
        return null;
      }
      await this.bindDispatchClaim({
        builderSessionId: input.builderSessionId,
        stepClaimId: input.stepClaimId,
        stepClaimToken: input.stepClaimToken,
        claimId: requiredString(claim.id, "claim.id"),
        revalidationId: requiredString(revalidation.id, "revalidation.id"),
      });
      context = await this.sessionDispatchContext(input.builderSessionId);
    }

    if (
      context.claim_owner !== expectedOwner ||
      context.claim_status !== "ACTIVE" ||
      context.revalidation_outcome !== "READY"
    ) {
      throw new Error(
        "Builder session proposal conflict: bound dispatch ownership is not active and READY",
      );
    }

    const claimId = requiredString(
      context.builder_dispatch_claim_id,
      "session.builder_dispatch_claim_id",
    );
    const claimToken = requiredString(context.claim_token, "claim.claim_token");
    await this.dispatchStore.heartbeatBuilderDispatchClaim({
      builderDispatchClaimId: claimId,
      claimToken,
      leaseSeconds: input.claimLeaseSeconds,
      actor: input.actor,
    });

    const refreshed = await this.sessionDispatchContext(input.builderSessionId);
    return {
      claim: {
        id: refreshed.builder_dispatch_claim_id,
        claim_token: refreshed.claim_token,
        claim_owner: refreshed.claim_owner,
      },
      revalidation: {
        id: refreshed.builder_dispatch_revalidation_id,
        outcome: refreshed.revalidation_outcome,
      },
    };
  }

  public async generate(input: {
    readonly builderSessionId: string;
    readonly builderProposalRunId: string;
    readonly stepClaimId: string;
    readonly stepClaimToken: string;
    readonly claimLeaseSeconds: number;
    readonly actor: Actor;
  }): Promise<Record<string, unknown>> {
    const current = await this.proposalStore.getBuilderProposalRun(
      input.builderProposalRunId,
    );
    if (!current) {
      throw new Error(`Builder proposal run not found: ${input.builderProposalRunId}`);
    }
    if (["GENERATED", "FAILED"].includes(String(current.status))) {
      return current;
    }

    const dispatch = await this.activeSessionClaim(input);
    if (!dispatch) {
      return current;
    }
    const claimId = requiredString(dispatch.claim.id, "claim.id");
    const revalidationId = requiredString(
      dispatch.revalidation.id,
      "revalidation.id",
    );
    const proposalClaim = await this.proposalStore.claimBuilderProposalRun({
      builderProposalRunId: input.builderProposalRunId,
      builderDispatchClaimId: claimId,
      builderDispatchRevalidationId: revalidationId,
      actor: input.actor,
    });
    if (!proposalClaim.claimed) {
      return (
        (await this.proposalStore.getBuilderProposalRun(input.builderProposalRunId)) ??
        proposalClaim.run
      );
    }

    const request = proposalClaim.request;
    try {
      const adapter = this.adapters.get(String(request.adapter_key));
      const result = await adapter.execute({
        proposalRequestId: String(request.id),
        requestHash: String(request.input_hash),
        providerKey: String(request.provider_key),
        inputContent: request.input_content as never,
      });
      return await this.proposalStore.completeBuilderProposalRun({
        builderProposalRunId: input.builderProposalRunId,
        proposal: result.proposal,
        externalProviderCalled: result.externalProviderCalled,
        providerRequestId: result.providerRequestId,
        usage: result.usage,
        actor: input.actor,
      });
    } catch {
      return await this.proposalStore.failBuilderProposalRun({
        builderProposalRunId: input.builderProposalRunId,
        errorCode: "PROPOSAL_ADAPTER_ERROR",
        usage: {},
        actor: input.actor,
      });
    }
  }

  public async finishDispatch(input: {
    readonly builderSessionId: string;
    readonly outcome: "COMPLETED" | "RELEASED";
    readonly actor: Actor;
  }): Promise<void> {
    const context = await this.sessionDispatchContext(input.builderSessionId);
    if (context.builder_dispatch_claim_id === null) {
      return;
    }
    if (context.claim_status !== "ACTIVE") {
      return;
    }
    const params = {
      builderDispatchClaimId: requiredString(
        context.builder_dispatch_claim_id,
        "session.builder_dispatch_claim_id",
      ),
      claimToken: requiredString(context.claim_token, "claim.claim_token"),
      actor: input.actor,
    };
    if (input.outcome === "COMPLETED") {
      await this.dispatchStore.completeBuilderDispatchClaim(params);
    } else {
      await this.dispatchStore.releaseBuilderDispatchClaim(params);
    }
  }
}
