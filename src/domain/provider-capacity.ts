export const PROVIDER_CAPABILITIES = ["CODE_BUILDER", "CODE_REVIEWER"] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export const PROVIDER_CAPACITY_STATUSES = [
  "HEALTHY",
  "DEGRADED",
  "QUOTA_EXHAUSTED",
  "UNAVAILABLE",
] as const;
export type ProviderCapacityStatus = (typeof PROVIDER_CAPACITY_STATUSES)[number];

export type ProviderDispatchOutcome = "READY" | "WAIT";
export type ProviderWaitingReason = "NONE" | "QUOTA" | "PROVIDER_UNAVAILABLE";
export type ProviderDispatchReason =
  | "PROVIDER_READY"
  | "PROVIDER_ROUTING_POLICY_MISSING"
  | "PROVIDER_OBSERVATION_MISSING"
  | "PROVIDER_OBSERVATION_STALE"
  | "PROVIDER_QUOTA_EXHAUSTED"
  | "PROVIDER_DEGRADED"
  | "PROVIDER_UNAVAILABLE";

export interface ProviderCapacityFacts {
  readonly status: ProviderCapacityStatus;
  readonly fresh: boolean;
}

export interface ProviderDispatchDecision {
  readonly outcome: ProviderDispatchOutcome;
  readonly waitingReason: ProviderWaitingReason;
  readonly reason: ProviderDispatchReason;
}

export interface ProviderRouteCandidate {
  readonly providerKey: string;
  readonly rank: number;
  readonly capacity: ProviderCapacityFacts | null;
}

export interface ProviderRouteDecision extends ProviderDispatchDecision {
  readonly providerKey: string | null;
  readonly providerRank: number | null;
}

export function evaluateProviderDispatchReadiness(
  facts: ProviderCapacityFacts | null,
): ProviderDispatchDecision {
  if (!facts) {
    return {
      outcome: "WAIT",
      waitingReason: "PROVIDER_UNAVAILABLE",
      reason: "PROVIDER_OBSERVATION_MISSING",
    };
  }

  if (!facts.fresh) {
    return {
      outcome: "WAIT",
      waitingReason: "PROVIDER_UNAVAILABLE",
      reason: "PROVIDER_OBSERVATION_STALE",
    };
  }

  if (facts.status === "HEALTHY") {
    return {
      outcome: "READY",
      waitingReason: "NONE",
      reason: "PROVIDER_READY",
    };
  }

  if (facts.status === "QUOTA_EXHAUSTED") {
    return {
      outcome: "WAIT",
      waitingReason: "QUOTA",
      reason: "PROVIDER_QUOTA_EXHAUSTED",
    };
  }

  if (facts.status === "DEGRADED") {
    return {
      outcome: "WAIT",
      waitingReason: "PROVIDER_UNAVAILABLE",
      reason: "PROVIDER_DEGRADED",
    };
  }

  return {
    outcome: "WAIT",
    waitingReason: "PROVIDER_UNAVAILABLE",
    reason: "PROVIDER_UNAVAILABLE",
  };
}

export function evaluateProviderRoute(
  candidates: readonly ProviderRouteCandidate[],
): ProviderRouteDecision {
  if (candidates.length === 0) {
    return {
      outcome: "WAIT",
      waitingReason: "PROVIDER_UNAVAILABLE",
      reason: "PROVIDER_ROUTING_POLICY_MISSING",
      providerKey: null,
      providerRank: null,
    };
  }

  const ordered = [...candidates].sort((left, right) => left.rank - right.rank);
  for (const candidate of ordered) {
    const decision = evaluateProviderDispatchReadiness(candidate.capacity);
    if (decision.outcome === "READY") {
      return {
        ...decision,
        providerKey: candidate.providerKey,
        providerRank: candidate.rank,
      };
    }
  }

  const primary = ordered[0];
  if (!primary) {
    throw new Error("Provider route evaluation failed to resolve a primary candidate");
  }
  return {
    ...evaluateProviderDispatchReadiness(primary.capacity),
    providerKey: primary.providerKey,
    providerRank: primary.rank,
  };
}

export function assertProviderKey(providerKey: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(providerKey)) {
    throw new Error(
      "providerKey must be 2-64 lowercase letters, numbers, dots, underscores, or hyphens",
    );
  }
}

export function normalizeProviderKeys(
  providerKeys: readonly string[],
): readonly string[] {
  if (providerKeys.length < 1 || providerKeys.length > 10) {
    throw new Error("providerKeys must contain between 1 and 10 providers");
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const providerKey of providerKeys) {
    assertProviderKey(providerKey);
    if (seen.has(providerKey)) {
      throw new Error(`providerKeys must not contain duplicates: ${providerKey}`);
    }
    seen.add(providerKey);
    normalized.push(providerKey);
  }
  return normalized;
}
