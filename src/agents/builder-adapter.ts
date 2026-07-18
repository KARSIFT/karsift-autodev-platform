import type {
  BuilderAdapterInput,
  BuilderAdapterResult,
  BuilderSideEffectMode,
} from "../domain/builder-runtime.js";

export interface BuilderAdapter {
  readonly key: string;
  readonly sideEffectMode: BuilderSideEffectMode;
  execute(input: BuilderAdapterInput): Promise<BuilderAdapterResult>;
}

export class BuilderAdapterRegistry {
  private readonly adapters = new Map<string, BuilderAdapter>();

  public constructor(adapters: readonly BuilderAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.key)) {
        throw new Error(`Duplicate builder adapter key: ${adapter.key}`);
      }
      this.adapters.set(adapter.key, adapter);
    }
  }

  public get(adapterKey: string): BuilderAdapter {
    const adapter = this.adapters.get(adapterKey);
    if (!adapter) {
      throw new Error(`Builder adapter not registered: ${adapterKey}`);
    }
    return adapter;
  }
}
