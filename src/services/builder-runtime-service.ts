import { BuilderAdapterRegistry } from "../agents/builder-adapter.js";
import {
  assertBuilderAdapterResult,
  type BuilderAdapterInput,
  type BuilderExecutionLimits,
} from "../domain/builder-runtime.js";
import type { BuilderRuntimeStore } from "../store/builder-runtime-types.js";
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
  public constructor(
    private readonly store: BuilderRuntimeStore,
    private readonly adapters: BuilderAdapterRegistry,
  ) {}

  public async runBuilderInvocation(input: {
    readonly builderInvocationId: string;
    readonly actor: Actor;
  }): Promise<Record<string, unknown>> {
    const started = await this.store.startBuilderInvocation({
      builderInvocationId: input.builderInvocationId,
      actor: input.actor,
    });
    const invocation = started.invocation as Record<string, unknown>;
    const plan = started.plan as unknown as RuntimePlan;
    const adapter = this.adapters.get(plan.adapter_key);

    if (adapter.sideEffectMode !== plan.side_effect_mode) {
      throw new Error(
        "Builder invocation conflict: adapter side-effect mode does not match the immutable plan",
      );
    }

    const limits = limitsFromPlan(plan);
    const adapterInput: BuilderAdapterInput = {
      invocationId: String(invocation.id),
      planHash: plan.plan_hash,
      taskContextPackHash: plan.task_context_pack_hash,
      providerKey: plan.provider_key,
      limits,
    };

    try {
      const result = await adapter.execute(adapterInput);
      assertBuilderAdapterResult(result, limits);
      return await this.store.completeBuilderInvocation({
        builderInvocationId: input.builderInvocationId,
        result,
        actor: input.actor,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown builder adapter error";
      return await this.store.completeBuilderInvocation({
        builderInvocationId: input.builderInvocationId,
        result: {
          outcome: "FAILED",
          turnsUsed: 0,
          commandsUsed: 0,
          durationMs: 0,
          summary: "Builder adapter failed before producing a valid result.",
          evidence: { error: message },
        },
        actor: input.actor,
      });
    }
  }
}
