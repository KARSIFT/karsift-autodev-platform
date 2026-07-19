import type {
  BuilderSessionStatus,
  BuilderSessionStepOperation,
  BuilderSessionTerminalStatus,
} from "../domain/builder-session.js";
import type { Actor } from "./types.js";

export interface PrepareBuilderSessionInput {
  readonly builderInvocationId: string;
  readonly actor: Actor;
}

export interface AcquireBuilderSessionStepClaimInput {
  readonly builderSessionId: string;
  readonly claimOwner: string;
  readonly leaseSeconds: number;
  readonly actor: Actor;
}

export interface HeartbeatBuilderSessionExecutionLeaseInput {
  readonly builderSessionId: string;
  readonly stepClaimId: string;
  readonly stepClaimToken: string;
  readonly leaseSeconds: number;
  readonly actor: Actor;
}

export interface TransitionBuilderSessionInput {
  readonly builderSessionId: string;
  readonly stepClaimId: string;
  readonly stepClaimToken: string;
  readonly expectedStatus: BuilderSessionStatus;
  readonly nextStatus: BuilderSessionStatus;
  readonly currentReadContextRunId?: string;
  readonly currentProposalRunId?: string | null;
  readonly currentActionRunId?: string | null;
  readonly turnCount?: number;
  readonly actor: Actor;
}

export interface CompleteBuilderSessionStepClaimInput {
  readonly builderSessionStepClaimId: string;
  readonly claimToken: string;
  readonly operation: BuilderSessionStepOperation;
  readonly actor: Actor;
}

export interface ReleaseBuilderSessionStepClaimInput {
  readonly builderSessionStepClaimId: string;
  readonly claimToken: string;
  readonly actor: Actor;
}

export interface RecordBuilderSessionTerminalEvidenceInput {
  readonly builderSessionId: string;
  readonly stepClaimId: string;
  readonly stepClaimToken: string;
  readonly outcome: BuilderSessionTerminalStatus;
  readonly finalActionEvidenceId: string | null;
  readonly finalActionEvidenceHash: string | null;
  readonly summary: string;
  readonly actor: Actor;
}

export interface BuilderSessionStore {
  prepareBuilderSession(input: PrepareBuilderSessionInput): Promise<Record<string, unknown>>;
  acquireBuilderSessionStepClaim(
    input: AcquireBuilderSessionStepClaimInput,
  ): Promise<Record<string, unknown>>;
  heartbeatBuilderSessionExecutionLease(
    input: HeartbeatBuilderSessionExecutionLeaseInput,
  ): Promise<Record<string, unknown>>;
  transitionBuilderSession(
    input: TransitionBuilderSessionInput,
  ): Promise<Record<string, unknown>>;
  completeBuilderSessionStepClaim(
    input: CompleteBuilderSessionStepClaimInput,
  ): Promise<Record<string, unknown>>;
  releaseBuilderSessionStepClaim(
    input: ReleaseBuilderSessionStepClaimInput,
  ): Promise<Record<string, unknown>>;
  recordBuilderSessionTerminalEvidence(
    input: RecordBuilderSessionTerminalEvidenceInput,
  ): Promise<Record<string, unknown>>;
  getBuilderSession(builderSessionId: string): Promise<Record<string, unknown> | null>;
  getBuilderSessionStepContext(
    builderSessionId: string,
  ): Promise<Record<string, unknown> | null>;
  getProjectBuilderSessionStatus(projectId: string): Promise<Record<string, unknown>>;
  getPlatformBuilderSessionStatus(): Promise<Record<string, unknown>>;
}
