import type {
  BuilderProposalAdapter,
  BuilderProposalAdapterInput,
  BuilderProposalAdapterResult,
} from "./builder-proposal-adapter.js";

export class FixtureBuilderProposalAdapter implements BuilderProposalAdapter {
  public readonly key = "fixture-proposal";

  public async execute(
    input: BuilderProposalAdapterInput,
  ): Promise<BuilderProposalAdapterResult> {
    return {
      proposal: {
        action: "COMPLETE",
        summary: `Fixture proposal completed for request ${input.requestHash.slice(0, 12)}.`,
        requestedPaths: [],
        commands: [],
        mutations: [],
        blockingReason: null,
      },
      externalProviderCalled: false,
      providerRequestId: null,
      usage: {
        inputUnits: 0,
        outputUnits: 0,
        estimatedCostMicrousd: 0,
      },
    };
  }
}
