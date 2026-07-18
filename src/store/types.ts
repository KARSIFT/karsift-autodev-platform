import type { Capability } from "../domain/capabilities.js";
import type { JsonValue } from "../domain/stable-json.js";
import type { WorkflowStatus } from "../domain/workflow-state.js";

export interface Actor {
  readonly type: "FOUNDER" | "HUMAN" | "SYSTEM" | "AGENT";
  readonly id: string;
}

export interface CreateProjectInput {
  readonly slug: string;
  readonly name: string;
  readonly repositoryFullName: string;
  readonly defaultBranch: string;
  readonly integrationBranch: string;
}

export interface CreateFounderRequestInput {
  readonly projectId: string;
  readonly title: string;
  readonly body: string;
  readonly authorityContext: JsonValue;
  readonly actor: Actor;
}

export interface CreateDecisionInput {
  readonly projectId: string;
  readonly requestId: string | null;
  readonly decisionType: string;
  readonly summary: string;
  readonly rationale: string | null;
  readonly authorityLevel: "R0" | "R1" | "R2" | "R3" | "R4";
  readonly metadata: JsonValue;
  readonly actor: Actor;
}

export interface CreateChangeContractInput {
  readonly projectId: string;
  readonly stableId: string;
  readonly content: JsonValue;
  readonly actor: Actor;
}

export interface AppendChangeContractVersionInput {
  readonly contractId: string;
  readonly content: JsonValue;
  readonly actor: Actor;
}

export interface CreateTaskInput {
  readonly projectId: string;
  readonly changeContractVersionId: string;
  readonly title: string;
  readonly description: string;
  readonly priority: "P0" | "P1" | "P2" | "P3";
  readonly actor: Actor;
}

export interface CreateWorkflowRunInput {
  readonly projectId: string;
  readonly taskId: string | null;
  readonly workflowType: string;
  readonly metadata: JsonValue;
  readonly actor: Actor;
}

export interface TransitionWorkflowRunInput {
  readonly workflowRunId: string;
  readonly expectedStateVersion: number;
  readonly targetStatus: WorkflowStatus;
  readonly actor: Actor;
}

export interface DisableCapabilityInput {
  readonly capability: Capability;
  readonly projectId: string | null;
  readonly reason: string;
  readonly actor: Actor;
}


export interface ControlPlaneStore {
  ping(): Promise<void>;
  createProject(
    input: CreateProjectInput,
    actor: Actor,
  ): Promise<Record<string, unknown>>;
  createFounderRequest(
    input: CreateFounderRequestInput,
  ): Promise<Record<string, unknown>>;
  createDecision(input: CreateDecisionInput): Promise<Record<string, unknown>>;
  createChangeContract(
    input: CreateChangeContractInput,
  ): Promise<Record<string, unknown>>;
  appendChangeContractVersion(
    input: AppendChangeContractVersionInput,
  ): Promise<Record<string, unknown>>;
  createTask(input: CreateTaskInput): Promise<Record<string, unknown>>;
  createWorkflowRun(
    input: CreateWorkflowRunInput,
  ): Promise<Record<string, unknown>>;
  transitionWorkflowRun(
    input: TransitionWorkflowRunInput,
  ): Promise<Record<string, unknown>>;
  listCapabilities(
    projectId: string | null,
  ): Promise<readonly Record<string, unknown>[]>;
  disableCapability(
    input: DisableCapabilityInput,
  ): Promise<Record<string, unknown>>;
  getProjectStatus(projectId: string): Promise<Record<string, unknown>>;
  getPlatformStatus(): Promise<Record<string, unknown>>;
}
