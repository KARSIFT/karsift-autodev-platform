import type {
  ProviderCapability,
  ProviderCapacityStatus,
} from "../domain/provider-capacity.js";
import type { JsonValue } from "../domain/stable-json.js";
import type { Actor } from "./types.js";

export interface RecordProviderCapacityObservationInput {
  readonly projectId: string;
  readonly providerKey: string;
  readonly capability: ProviderCapability;
  readonly status: ProviderCapacityStatus;
  readonly ttlSeconds: number;
  readonly quotaResetAt: string | null;
  readonly details: JsonValue;
  readonly actor: Actor;
}

export interface EvaluateProviderDispatchInput {
  readonly workQueueItemId: string;
  readonly providerKey: string;
  readonly capability: ProviderCapability;
  readonly actor: Actor;
}

export interface ProviderDispatchStore {
  recordProviderCapacityObservation(
    input: RecordProviderCapacityObservationInput,
  ): Promise<Record<string, unknown>>;
  evaluateProviderDispatch(
    input: EvaluateProviderDispatchInput,
  ): Promise<Record<string, unknown>>;
  getProjectProviderDispatchStatus(
    projectId: string,
  ): Promise<Record<string, unknown>>;
  getPlatformProviderDispatchStatus(): Promise<Record<string, unknown>>;
}
