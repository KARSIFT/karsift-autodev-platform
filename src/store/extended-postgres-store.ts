import type { Pool } from "pg";

import { PostgresControlPlaneStore } from "./postgres-store.js";
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
  implements WorkQueueStore
{
  private readonly workQueue: PostgresWorkQueueStore;

  public constructor(pool: Pool) {
    super(pool);
    this.workQueue = new PostgresWorkQueueStore(pool);
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

  public override async getProjectStatus(projectId: string) {
    const [base, queue] = await Promise.all([
      super.getProjectStatus(projectId),
      this.workQueue.getProjectQueueStatus(projectId),
    ]);
    return { ...base, ...queue };
  }

  public override async getPlatformStatus() {
    const [base, queue] = await Promise.all([
      super.getPlatformStatus(),
      this.workQueue.getPlatformQueueStatus(),
    ]);
    return { ...base, ...queue };
  }
}
