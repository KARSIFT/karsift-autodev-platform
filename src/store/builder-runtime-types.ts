import type {
  BuilderAdapterResult,
  BuilderExecutionLimits,
} from "../domain/builder-runtime.js";
import type { Actor } from "./types.js";

export interface PrepareBuilderInvocationInput {
  readonly executionAttemptId: string;
  readonly leaseToken: string;
  readonly limits: BuilderExecutionLimits;
  readonly actor: Actor;
}

export interface StartBuilderInvocationInput {
  readonly builderInvocationId: string;
  readonly actor: Actor;
}

export interface CompleteBuilderInvocationInput {
  readonly builderInvocationId: string;
  readonly result: BuilderAdapterResult;
  readonly actor: Actor;
}

export interface BuilderRuntimeStore {
  prepareBuilderInvocation(
    input: PrepareBuilderInvocationInput,
  ): Promise<Record<string, unknown>>;
  startBuilderInvocation(
    input: StartBuilderInvocationInput,
  ): Promise<Record<string, unknown>>;
  completeBuilderInvocation(
    input: CompleteBuilderInvocationInput,
  ): Promise<Record<string, unknown>>;
  getBuilderInvocation(
    builderInvocationId: string,
  ): Promise<Record<string, unknown> | null>;
  getProjectBuilderRuntimeStatus(
    projectId: string,
  ): Promise<Record<string, unknown>>;
  getPlatformBuilderRuntimeStatus(): Promise<Record<string, unknown>>;
}
