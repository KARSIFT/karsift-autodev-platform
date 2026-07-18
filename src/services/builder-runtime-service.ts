import { BuilderAdapterRegistry } from "../agents/builder-adapter.js";
import {
  assertBuilderAdapterResult,
  type BuilderAdapterInput,
  type BuilderAdapterResult,
  type BuilderExecutionLimits,
} from "../domain/builder-runtime.js";
import type {
  BuilderDispatchStore,
  BuilderRuntimeStore,
} from "../store/builder-runtime-types.js";
import type { Actor } from "../store/types.js";

interface RuntimePlan {
  readonly adapter_key: string;
  readonly side_effect_mode: string;
  readonly plan_hash: string;
  readonly task_context_pack_hash: string;
  readonly provider_key: string;
  readonly max_turns: number;
  readonly retry_budget: number;
  readonly command_budget: number;
  readonly timeout_seconds: number;
}

function limitsFromPlan(plan: RuntimePlan): BuilderExecutionLimits {
  return {
    maxTurns: plan.max_turns,
    retryBudget: plan.retry_budget,
    commandBudget: plan.command_budget,
    timeoutSeconds: plan.timeout_seconds,
  };
}

export class BuilderRuntimeService {
  private readonly store: BuilderRuntimeStore;
  private readonly dispatchStore: BuilderDispatchStore;
  private readonly adapters: BuilderAdapterRegistry;

  public constructor(
    store: BuilderRuntimeStore,
    dispatchStoreOrAdapters: BuilderDispatchStore | BuilderAdapterRegistry,
    adapters?: BuilderAdapterRegistry,
  ) {
    this.store = store;
    if (adapters) {
      this.dispatchStore = dispatchStoreOrAdapters as BuilderDispatchStore;
      this.adapters = adapters;
    } else {
      this.dispatchStore = store as BuilderRuntimeStore & BuilderDispatchStore;
      this.adapters = dispatchStoreOrAdapters as BuilderAdapterRegistry;
    }
  }

  public async runBuilderInvocation(input: {
    readonly builderInvocationId: string;
    readonly actor: Actor;
  }): Promise<Record<string, unknown>> {
    const dispatch = await this.dispatchStore.acquireBuilderDispatchClaim({
      builderInvocationId: input.builderInvocationId,
      claimOwner: input.actor.id,
      leaseSeconds: 300,
      actor: input.actor,
    });

    if (dispatch.acquired !== true) {
      return {
        executed: false,
        dispatchClaim: dispatch.claim ?? null,
        dispatchRevalidation: dispatch.revalidation ?? null,
        reason: dispatch.reason ?? "DISPATCH_NOT_ACQUIRED",
      };
    }

    const claim = dispatch.claim as Record<string, unknown>;
    const claimId = String(claim.id);
    const claimToken = String(claim.claim_token);

    let started: Record<string, unknown>;
    try {
      started = await this.store.startBuilderInvocation({
        builderInvocationId: input.builderInvocationId,
        actor: input.actor,
      });
    } catch (error) {
      await this.dispatchStore.releaseBuilderDispatchClaim({
        builderDispatchClaimId: claimId,
        claimToken,
        actor: input.actor,
      });
      throw error;
    }

    const invocation = started.invocation as Record<string, unknown>;
    const plan = started.plan as unknown as RuntimePlan;
    const adapter = this.adapters.get(plan.adapter_key);

    if (adapter.sideEffectMode !== plan.side_effect_mode) {
      await this.dispatchStore.releaseBuilderDispatchClaim({
        builderDispatchClaimId: claimId,
        claimToken,
        actor: input.actor,
      });
      throw new Error(
        "Builder invocation conflict: adapter side-effect mode does not match the immutable plan",
      );
    }

    const limits = limitsFromPlan(plan);
    const adapterInput: BuilderAdapterInput = {
      invocationId: String(invocation.id),
      dispatchClaimId: claimId,
      dispatchIdempotencyKey: String(claim.idempotency_key),
      planHash: plan.plan_hash,
      taskContextPackHash: plan.task_context_pack_hash,
      providerKey: plan.provider_key,
      limits,
    };

    let result: BuilderAdapterResult;
    try {
      result = await adapter.execute(adapterInput);
      assertBuilderAdapterResult(result, limits);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown builder adapter error";
      result = {
        outcome: "FAILED",
        turnsUsed: 0,
        commandsUsed: 0,
        durationMs: 0,
        summary: "Builder adapter failed before producing a valid result.",
        evidence: {
          error: message,
          dispatchClaimId: claimId,
          dispatchIdempotencyKey: String(claim.idempotency_key),
        },
      };
    }

    const completed = await this.store.completeBuilderInvocation({
      builderInvocationId: input.builderInvocationId,
      result,
      actor: input.actor,
    });
    const completedClaim = await this.dispatchStore.completeBuilderDispatchClaim({
      builderDispatchClaimId: claimId,
      claimToken,
      actor: input.actor,
    });

    return {
      ...completed,
      executed: true,
      dispatchClaim: completedClaim,
      dispatchRevalidation: dispatch.revalidation ?? null,
    };
  }
}
