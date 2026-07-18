export const CAPABILITIES = [
  "AUTOMATED_WRITE",
  "AI_DISPATCH",
  "AUTO_MERGE",
  "DEPLOYMENT",
  "PRODUCTION_RELEASE",
  "INCIDENT_REPAIR",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const CAPABILITY_SET = new Set<string>(CAPABILITIES);

export function isCapability(value: string): value is Capability {
  return CAPABILITY_SET.has(value);
}

export function assertCapability(value: string): asserts value is Capability {
  if (!isCapability(value)) {
    throw new Error(`Unknown capability: ${value}`);
  }
}

/**
 * ADP-002 deliberately has no capability-enabling path.
 * Later activation changes must replace this policy through a governed change.
 */
export function assertCapabilityEnablementAllowed(
  _capability: Capability,
  enabled: boolean,
): void {
  if (enabled) {
    throw new Error(
      "Capability enablement is disabled at activation level A1. A later governed change is required.",
    );
  }
}
