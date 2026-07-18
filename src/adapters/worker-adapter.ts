export interface WorkerTaskContext {
  readonly projectId: string;
  readonly taskId: string;
  readonly changeContractVersionId: string;
  readonly objective: string;
  readonly repositoryFullName: string;
  readonly baseRef: string;
}

export interface PreparedWorkerExecution {
  readonly executionId: string;
  readonly provider: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface WorkerResult {
  readonly executionId: string;
  readonly outcome: "SUCCEEDED" | "FAILED" | "CANCELLED";
  readonly summary: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface WorkerAdapter {
  readonly provider: string;
  prepare(context: WorkerTaskContext): Promise<PreparedWorkerExecution>;
  execute(execution: PreparedWorkerExecution): Promise<WorkerResult>;
  cancel(executionId: string): Promise<void>;
}

/**
 * ADP-002 intentionally provides only the provider-neutral contract.
 * No concrete worker adapter or dispatch path is activated.
 */
export const WORKER_DISPATCH_ACTIVE = false as const;
