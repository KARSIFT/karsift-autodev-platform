import type {
  ProviderCapacityFacts,
  ProviderDispatchDecision,
} from "./provider-capacity.js";
import { evaluateProviderDispatchReadiness } from "./provider-capacity.js";

export const BUILDER_DISPATCH_CLAIM_STATUSES = [
  "ACTIVE",
  "COMPLETED",
  "RELEASED",
  "EXPIRED",
] as const;
export type BuilderDispatchClaimStatus =
  (typeof BUILDER_DISPATCH_CLAIM_STATUSES)[number];

export function builderDispatchIdempotencyKey(planHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(planHash)) {
    throw new Error("planHash must be a lowercase 64-character SHA-256 hash");
  }
  return `builder-dispatch:${planHash}`;
}

export function evaluateLatestBuilderProviderReadiness(
  facts: ProviderCapacityFacts | null,
): ProviderDispatchDecision {
  return evaluateProviderDispatchReadiness(facts);
}

export function assertDispatchLeaseSeconds(leaseSeconds: number): void {
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) {
    throw new Error("dispatch leaseSeconds must be a safe integer between 30 and 3600");
  }
}
