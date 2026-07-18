import type { BuilderProposal } from "../domain/builder-proposal.js";
import type { JsonValue } from "../domain/stable-json.js";

export interface BuilderProposalAdapterInput {
  readonly proposalRequestId: string;
  readonly requestHash: string;
  readonly providerKey: string;
  readonly inputContent: JsonValue;
}

export interface BuilderProposalAdapterResult {
  readonly proposal: BuilderProposal;
  readonly externalProviderCalled: boolean;
  readonly providerRequestId: string | null;
  readonly usage: JsonValue;
}

export interface BuilderProposalAdapter {
  readonly key: string;
  execute(input: BuilderProposalAdapterInput): Promise<BuilderProposalAdapterResult>;
}

export class BuilderProposalAdapterRegistry {
  private readonly adapters = new Map<string, BuilderProposalAdapter>();

  public constructor(adapters: readonly BuilderProposalAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.key)) {
        throw new Error(`Duplicate builder proposal adapter key: ${adapter.key}`);
      }
      this.adapters.set(adapter.key, adapter);
    }
  }

  public get(adapterKey: string): BuilderProposalAdapter {
    const adapter = this.adapters.get(adapterKey);
    if (!adapter) {
      throw new Error(`Builder proposal adapter not registered: ${adapterKey}`);
    }
    return adapter;
  }
}
