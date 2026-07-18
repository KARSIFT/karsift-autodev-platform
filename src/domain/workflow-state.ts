export const WORKFLOW_STATUSES = [
  "CREATED",
  "RUNNING",
  "BLOCKED",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

const allowedTransitions: Readonly<Record<WorkflowStatus, readonly WorkflowStatus[]>> = {
  CREATED: ["RUNNING", "BLOCKED", "CANCELLED"],
  RUNNING: ["BLOCKED", "SUCCEEDED", "FAILED", "CANCELLED"],
  BLOCKED: ["RUNNING", "FAILED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransitionWorkflow(
  from: WorkflowStatus,
  to: WorkflowStatus,
): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertWorkflowTransition(
  from: WorkflowStatus,
  to: WorkflowStatus,
): void {
  if (!canTransitionWorkflow(from, to)) {
    throw new Error(`Invalid workflow transition: ${from} -> ${to}`);
  }
}

export function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED";
}
