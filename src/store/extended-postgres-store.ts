import type { Pool } from "pg";

import { PostgresContractAuthorizationStore } from "./contract-authorization-store.js";
import type {
  ContractAuthorizationStore,
  RecordChangeContractAuthorizationInput,
} from "./contract-authorization-types.js";
import { PostgresControlPlaneStore } from "./postgres-store.js";
import { PostgresFreshnessValidationStore } from "./freshness-validation-store.js";
import type {
  FreshnessValidationStore,
  ValidateWorkQueueItemInput,
} from "./freshness-validation-types.js";
import { PostgresWorkQueueStore } from "./work-queue-store.js";
import type {
  ClaimExecutionLeaseInput,
  CompleteExecutionLeaseInput,
  CreateWorkQueueItemInput,
  HeartbeatExecutionLeaseInput,
  ReleaseExecutionLeaseInput,
  SetWorkQueueEligibilityInput,
  WorkQueueStore,
} from "./work-queue-types.js";

export class ExtendedPostgresControlPlaneStore
  extends PostgresControlPlaneStore
  implements WorkQueueStore, FreshnessValidationStore, ContractAuthorizationStore
{
  private readonly workQueue: PostgresWorkQueueStore;
  private readonly freshnessValidation: PostgresFreshnessValidationStore;
  private readonly contractAuthorization: PostgresContractAuthorizationStore;

  public constructor(pool: Pool) {
    super(pool);
    this.workQueue = new PostgresWorkQueueStore(pool);
    this.freshnessValidation = new PostgresFreshnessValidationStore(pool);
    this.contractAuthorization = new PostgresContractAuthorizationStore(pool);
  }

  public createWorkQueueItem(input: CreateWorkQueueItemInput) {
    return this.workQueue.createWorkQueueItem(input);
  }

  public setWorkQueueEligibility(input: SetWorkQueueEligibilityInput) {
    return this.workQueue.setWorkQueueEligibility(input);
  }

  public claimExecutionLease(input: ClaimExecutionLeaseInput) {
    return this.workQueue.claimExecutionLease(input);
  }

  public heartbeatExecutionLease(input: HeartbeatExecutionLeaseInput) {
    return this.workQueue.heartbeatExecutionLease(input);
  }

  public completeExecutionLease(input: CompleteExecutionLeaseInput) {
    return this.workQueue.completeExecutionLease(input);
  }

  public releaseExecutionLease(input: ReleaseExecutionLeaseInput) {
    return this.workQueue.releaseExecutionLease(input);
  }

  public getProjectQueueStatus(projectId: string) {
    return this.workQueue.getProjectQueueStatus(projectId);
  }

  public getPlatformQueueStatus() {
    return this.workQueue.getPlatformQueueStatus();
  }

  public validateWorkQueueItem(input: ValidateWorkQueueItemInput) {
    return this.freshnessValidation.validateWorkQueueItem(input);
  }

  public getProjectValidationStatus(projectId: string) {
    return this.freshnessValidation.getProjectValidationStatus(projectId);
  }

  public getPlatformValidationStatus() {
    return this.freshnessValidation.getPlatformValidationStatus();
  }

  public recordChangeContractAuthorization(
    input: RecordChangeContractAuthorizationInput,
  ) {
    return this.contractAuthorization.recordChangeContractAuthorization(input);
  }

  public getProjectAuthorizationStatus(projectId: string) {
    return this.contractAuthorization.getProjectAuthorizationStatus(projectId);
  }

  public getPlatformAuthorizationStatus() {
    return this.contractAuthorization.getPlatformAuthorizationStatus();
  }

  public override async getProjectStatus(projectId: string) {
    const [base, queue, validation, authorization] = await Promise.all([
      super.getProjectStatus(projectId),
      this.workQueue.getProjectQueueStatus(projectId),
      this.freshnessValidation.getProjectValidationStatus(projectId),
      this.contractAuthorization.getProjectAuthorizationStatus(projectId),
    ]);
    return { ...base, ...queue, ...validation, ...authorization };
  }

  public override async getPlatformStatus() {
    const [base, queue, validation, authorization] = await Promise.all([
      super.getPlatformStatus(),
      this.workQueue.getPlatformQueueStatus(),
      this.freshnessValidation.getPlatformValidationStatus(),
      this.contractAuthorization.getPlatformAuthorizationStatus(),
    ]);
    return { ...base, ...queue, ...validation, ...authorization };
  }
}
