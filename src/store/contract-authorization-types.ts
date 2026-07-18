import type { Actor } from "./types.js";

export interface RecordChangeContractAuthorizationInput {
  readonly changeContractId: string;
  readonly action: "AUTHORIZE" | "REVOKE";
  readonly rationale: string | null;
  readonly actor: Actor;
}

export interface ContractAuthorizationResult {
  readonly decision: Record<string, unknown>;
  readonly authorized: boolean;
}

export interface ContractAuthorizationStore {
  recordChangeContractAuthorization(
    input: RecordChangeContractAuthorizationInput,
  ): Promise<ContractAuthorizationResult>;
  getProjectAuthorizationStatus(
    projectId: string,
  ): Promise<Record<string, unknown>>;
  getPlatformAuthorizationStatus(): Promise<Record<string, unknown>>;
}
