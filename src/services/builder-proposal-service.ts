import type { BuilderProposalAdapterRegistry } from "../agents/builder-proposal-adapter.js";
import type { BuilderProposalStore } from "../store/builder-proposal-types.js";
import type { BuilderDispatchStore } from "../store/builder-runtime-types.js";
import type { Actor } from "../store/types.js";

export class BuilderProposalService {
  public constructor(
    private readonly proposalStore: BuilderProposalStore,
    private readonly dispatchStore: BuilderDispatchStore,
    private readonly adapters: BuilderProposalAdapterRegistry,
  ) {}

  public async generate(input: {
    readonly builderProposalRunId: string;
    readonly claimOwner: string;
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

    const builderInvocationId = String(current.builder_invocation_id);
    const dispatch = await this.dispatchStore.acquireBuilderDispatchClaim({
      builderInvocationId,
      claimOwner: input.claimOwner,
      claimLeaseSeconds: input.claimLeaseSeconds,
      actor: input.actor,
    });
    if (!dispatch.acquired) {
      return (
        (await this.proposalStore.getBuilderProposalRun(input.builderProposalRunId)) ??
        current
      );
    }

    const claimId = String(dispatch.claim.id);
    const revalidationId = String(dispatch.revalidation.id);
    const proposalClaim = await this.proposalStore.claimBuilderProposalRun({
      builderProposalRunId: input.builderProposalRunId,
      builderDispatchClaimId: claimId,
      builderDispatchRevalidationId: revalidationId,
      actor: input.actor,
    });
    if (!proposalClaim.claimed) {
      await this.dispatchStore
        .completeBuilderDispatchClaim({
          builderDispatchClaimId: claimId,
          claimToken: dispatch.claimToken,
          actor: input.actor,
        })
        .catch(() => undefined);
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
      const completed = await this.proposalStore.completeBuilderProposalRun({
        builderProposalRunId: input.builderProposalRunId,
        proposal: result.proposal,
        externalProviderCalled: result.externalProviderCalled,
        providerRequestId: result.providerRequestId,
        usage: result.usage,
        actor: input.actor,
      });
      await this.dispatchStore.completeBuilderDispatchClaim({
        builderDispatchClaimId: claimId,
        claimToken: dispatch.claimToken,
        actor: input.actor,
      });
      return completed;
    } catch {
      const failed = await this.proposalStore.failBuilderProposalRun({
        builderProposalRunId: input.builderProposalRunId,
        errorCode: "PROPOSAL_ADAPTER_ERROR",
        usage: {},
        actor: input.actor,
      });
      await this.dispatchStore
        .completeBuilderDispatchClaim({
          builderDispatchClaimId: claimId,
          claimToken: dispatch.claimToken,
          actor: input.actor,
        })
        .catch(() => undefined);
      return failed;
    }
  }
}
