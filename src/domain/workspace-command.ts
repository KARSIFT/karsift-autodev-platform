import { sha256Json, type JsonValue } from "./stable-json.js";

export const WORKSPACE_COMMAND_PURPOSES = [
  "INSPECT",
  "BUILD",
  "TEST",
  "FORMAT_CHECK",
] as const;
export type WorkspaceCommandPurpose = (typeof WORKSPACE_COMMAND_PURPOSES)[number];

export interface WorkspaceCommandRule {
  readonly executable: string;
  readonly allowedArguments: readonly (readonly string[])[];
}

export interface WorkspaceCommandPolicySnapshot {
  readonly purposes: readonly WorkspaceCommandPurpose[];
  readonly rules: readonly WorkspaceCommandRule[];
  readonly environmentAllowlist: readonly string[];
  readonly maxTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxCommandsPerWorkspace: number;
}

export interface WorkspaceCommandRequest {
  readonly purpose: WorkspaceCommandPurpose;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly environment: Readonly<Record<string, string>>;
}

export interface WorkspaceCommandPlanContentInput extends WorkspaceCommandRequest {
  readonly projectId: string;
  readonly repositoryWorkspaceId: string;
  readonly repositoryWorkspacePlanId: string;
  readonly policyId: string;
  readonly policyHash: string;
  readonly workspaceStateVersion: number;
  readonly workspacePath: string;
  readonly workspaceMode: "READ_ONLY" | "WRITE";
}

const RESERVED_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "HOME",
  "CI",
  "LANG",
  "NODE_OPTIONS",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
}

function normalizeCommandString(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${field} must be a non-empty string without NUL bytes`);
  }
  return value;
}

export function normalizeWorkspaceCommandPolicy(
  input: WorkspaceCommandPolicySnapshot,
): WorkspaceCommandPolicySnapshot {
  assertPositiveInteger(input.maxTimeoutMs, "maxTimeoutMs");
  assertPositiveInteger(input.maxOutputBytes, "maxOutputBytes");
  assertPositiveInteger(input.maxCommandsPerWorkspace, "maxCommandsPerWorkspace");

  const purposes = [...new Set(input.purposes)].sort() as WorkspaceCommandPurpose[];
  if (purposes.length === 0) {
    throw new Error("workspace command policy must allow at least one purpose");
  }
  for (const purpose of purposes) {
    if (!WORKSPACE_COMMAND_PURPOSES.includes(purpose)) {
      throw new Error(`unsupported workspace command purpose: ${purpose}`);
    }
  }

  const environmentAllowlist = [...new Set(input.environmentAllowlist)]
    .map((key) => normalizeCommandString(key, "environment allowlist key"))
    .sort();
  for (const key of environmentAllowlist) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new Error(`invalid environment allowlist key: ${key}`);
    }
    if (RESERVED_ENVIRONMENT_KEYS.has(key)) {
      throw new Error(`reserved environment key cannot be delegated: ${key}`);
    }
  }

  const rules = input.rules.map((rule) => {
    const executable = normalizeCommandString(rule.executable, "executable");
    if (executable.includes("/") || executable.includes("\\")) {
      throw new Error("workspace command executables must be bare command names");
    }
    if (rule.allowedArguments.length === 0) {
      throw new Error(`workspace command rule ${executable} must allow at least one exact argument vector`);
    }
    const allowedArguments = rule.allowedArguments.map((vector) =>
      vector.map((argument) => normalizeCommandString(argument, "command argument")),
    );
    return { executable, allowedArguments };
  });

  if (rules.length === 0) {
    throw new Error("workspace command policy must contain at least one executable rule");
  }

  rules.sort((left, right) => left.executable.localeCompare(right.executable));
  return {
    purposes,
    rules,
    environmentAllowlist,
    maxTimeoutMs: input.maxTimeoutMs,
    maxOutputBytes: input.maxOutputBytes,
    maxCommandsPerWorkspace: input.maxCommandsPerWorkspace,
  };
}

export function workspaceCommandPolicyContent(
  input: WorkspaceCommandPolicySnapshot,
): JsonValue {
  const normalized = normalizeWorkspaceCommandPolicy(input);
  return {
    purposes: [...normalized.purposes],
    rules: normalized.rules.map((rule) => ({
      executable: rule.executable,
      allowedArguments: rule.allowedArguments.map((vector) => [...vector]),
    })),
    environmentAllowlist: [...normalized.environmentAllowlist],
    maxTimeoutMs: normalized.maxTimeoutMs,
    maxOutputBytes: normalized.maxOutputBytes,
    maxCommandsPerWorkspace: normalized.maxCommandsPerWorkspace,
  };
}

export function hashWorkspaceCommandPolicy(
  input: WorkspaceCommandPolicySnapshot,
): string {
  return sha256Json(workspaceCommandPolicyContent(input));
}

export function assertWorkspaceCommandAllowed(
  policyInput: WorkspaceCommandPolicySnapshot,
  request: WorkspaceCommandRequest,
): void {
  const policy = normalizeWorkspaceCommandPolicy(policyInput);
  if (!policy.purposes.includes(request.purpose)) {
    throw new Error(`workspace command purpose is not allowed: ${request.purpose}`);
  }

  const executable = normalizeCommandString(request.executable, "executable");
  const args = request.arguments.map((argument) =>
    normalizeCommandString(argument, "command argument"),
  );
  const rule = policy.rules.find((candidate) => candidate.executable === executable);
  if (!rule) {
    throw new Error(`workspace command executable is not allowed: ${executable}`);
  }
  const exactArgumentsAllowed = rule.allowedArguments.some(
    (vector) =>
      vector.length === args.length &&
      vector.every((argument, index) => argument === args[index]),
  );
  if (!exactArgumentsAllowed) {
    throw new Error("workspace command arguments are not allowed by policy");
  }

  assertPositiveInteger(request.timeoutMs, "timeoutMs");
  assertPositiveInteger(request.maxOutputBytes, "maxOutputBytes");
  if (request.timeoutMs > policy.maxTimeoutMs) {
    throw new Error("workspace command timeout exceeds policy maximum");
  }
  if (request.maxOutputBytes > policy.maxOutputBytes) {
    throw new Error("workspace command output limit exceeds policy maximum");
  }

  for (const [key, value] of Object.entries(request.environment)) {
    normalizeCommandString(value, `environment value ${key}`);
    if (!policy.environmentAllowlist.includes(key)) {
      throw new Error(`workspace command environment key is not allowed: ${key}`);
    }
    if (RESERVED_ENVIRONMENT_KEYS.has(key)) {
      throw new Error(`reserved environment key cannot be delegated: ${key}`);
    }
  }
}

export function buildWorkspaceCommandPlanContent(
  input: WorkspaceCommandPlanContentInput,
): JsonValue {
  if (!/^[a-f0-9]{64}$/.test(input.policyHash)) {
    throw new Error("policyHash must be a lowercase SHA-256 hash");
  }
  if (!Number.isInteger(input.workspaceStateVersion) || input.workspaceStateVersion < 0) {
    throw new Error("workspaceStateVersion must be a non-negative integer");
  }

  const environment = Object.fromEntries(
    Object.entries(input.environment).sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    projectId: input.projectId,
    repositoryWorkspaceId: input.repositoryWorkspaceId,
    repositoryWorkspacePlanId: input.repositoryWorkspacePlanId,
    policyId: input.policyId,
    policyHash: input.policyHash,
    workspaceStateVersion: input.workspaceStateVersion,
    workspacePath: input.workspacePath,
    workspaceMode: input.workspaceMode,
    purpose: input.purpose,
    executable: input.executable,
    arguments: [...input.arguments],
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
    environment,
  };
}

export function hashWorkspaceCommandPlan(
  input: WorkspaceCommandPlanContentInput,
): string {
  return sha256Json(buildWorkspaceCommandPlanContent(input));
}
