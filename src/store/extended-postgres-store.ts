import type { Pool } from "pg";

import { PostgresAiBudgetStore } from "./ai-budget-store.js";
import type {
  AiBudgetStore,
  AuthorizeWorkBudgetInput,
  SettleAiBudgetReservationInput,
  UpsertAiBudgetPolicyInput,
} from "./ai-budget-types.js";
import { PostgresBudgetAwareLeaseStore } from "./budget-aware-lease-store.js";
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
  implements
    WorkQueueStore,
    FreshnessValidationStore,
    ContractAuthorizationStore,
    AiBudgetStore
{
  private readonly workQueue: PostgresWorkQueueStore;
  private readonly budgetAwareLease: PostgresBudgetAwareLeaseStore;
  private readonly freshnessValidation: PostgresFreshnessValidationStore;
  private readonly contractAuthorization: PostgresContractAuthorizationStore;
  private readonly aiBudget: PostgresAiBudgetStore;

  public constructor(pool: Pool) {
    super(pool);
    this.workQueue = new PostgresWorkQueueStore(pool);
    this.budgetAwareLease = new PostgresBudgetAwareLeaseStore(pool);
    this.freshnessValidation = new PostgresFreshnessValidationStore(pool);
    this.contractAuthorization = new PostgresContractAuthorizationStore(pool);
    this.aiBudget = new PostgresAiBudgetStore(pool);
  }

  public createWorkQueueItem(input: CreateWorkQueueItemInput) {
    return this.workQueue.createWorkQueueItem(input);
  }

  public setWorkQueueEligibility(input: SetWorkQueueEligibilityInput) {
    return this.workQueue.setWorkQueueEligibility(input);
  }

  public claimExecutionLease(input: ClaimExecutionLeaseInput) {
    return this.budgetAwareLease.claimExecutionLease(input);
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

  public upsertAiBudgetPolicy(input: UpsertAiBudgetPolicyInput) {
    return this.aiBudget.upsertAiBudgetPolicy(input);
  }

  public authorizeWorkBudget(input: AuthorizeWorkBudgetInput) {
    return this.aiBudget.authorizeWorkBudget(input);
  }

  public settleAiBudgetReservation(input: SettleAiBudgetReservationInput) {
    return this.aiBudget.settleAiBudgetReservation(input);
  }

  public getProjectAiBudgetStatus(projectId: string) {
    return this.aiBudget.getProjectAiBudgetStatus(projectId);
  }

  public getPlatformAiBudgetStatus() {
    return this.aiBudget.getPlatformAiBudgetStatus();
  }

  public override async getProjectStatus(projectId: string) {
    const [base, queue, validation, authorization, aiBudget] = await Promise.all([
      super.getProjectStatus(projectId),
      this.workQueue.getProjectQueueStatus(projectId),
      this.freshnessValidation.getProjectValidationStatus(projectId),
      this.contractAuthorization.getProjectAuthorizationStatus(projectId),
      this.aiBudget.getProjectAiBudgetStatus(projectId),
    ]);
    return { ...base, ...queue, ...validation, ...authorization, ...aiBudget };
  }

  public override async getPlatformStatus() {
    const [base, queue, validation, authorization, aiBudget] = await Promise.all([
      super.getPlatformStatus(),
      this.workQueue.getPlatformQueueStatus(),
      this.freshnessValidation.getPlatformValidationStatus(),
      this.contractAuthorization.getPlatformAuthorizationStatus(),
      this.aiBudget.getPlatformAiBudgetStatus(),
    ]);
    return { ...base, ...queue, ...validation, ...authorization, ...aiBudget };
  }
}
