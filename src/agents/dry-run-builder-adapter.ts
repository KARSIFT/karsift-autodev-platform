import type {
  BuilderAdapterInput,
  BuilderAdapterResult,
} from "../domain/builder-runtime.js";
import type { BuilderAdapter } from "./builder-adapter.js";

export class DryRunBuilderAdapter implements BuilderAdapter {
  public readonly key = "dry-run";
  public readonly sideEffectMode = "NONE" as const;

  public async execute(input: BuilderAdapterInput): Promise<BuilderAdapterResult> {
    return {
      outcome: "SUCCEEDED",
      turnsUsed: 0,
      commandsUsed: 0,
      durationMs: 0,
      summary: "Dry-run builder contract validated without external calls or side effects.",
      evidence: {
        dryRun: true,
        externalProviderCalled: false,
        repositoryMutated: false,
        invocationId: input.invocationId,
        planHash: input.planHash,
        taskContextPackHash: input.taskContextPackHash,
        providerKey: input.providerKey,
        limits: {
          maxTurns: input.limits.maxTurns,
          retryBudget: input.limits.retryBudget,
          commandBudget: input.limits.commandBudget,
          timeoutSeconds: input.limits.timeoutSeconds,
        },
      },
    };
  }
}
