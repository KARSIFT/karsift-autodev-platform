import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { AppConfig } from "../config.js";
import {
  WORKSPACE_COMMAND_PURPOSES,
  type WorkspaceCommandPurpose,
  type WorkspaceCommandRule,
} from "../domain/workspace-command.js";
import { authenticateBearerToken } from "../security/auth.js";
import type { WorkspaceCommandService } from "../services/workspace-command-service.js";
import type { WorkspaceCommandStore } from "../store/workspace-command-types.js";

const MAX_BODY_BYTES = 1_000_000;
const POLICY_PATH = /^\/v1\/projects\/([^/]+)\/workspace-command-policies$/;
const PREPARE_PATH = /^\/v1\/repository-workspaces\/([^/]+)\/commands$/;
const RUN_PATH = /^\/v1\/workspace-command-runs\/([^/]+)\/run$/;
const READ_PATH = /^\/v1\/workspace-command-runs\/([^/]+)$/;
const PROJECT_STATUS_PATH = /^\/v1\/projects\/([^/]+)\/workspace-commands\/status$/;
const PLATFORM_STATUS_PATH = "/v1/workspace-commands/status";

type RequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error("Request body exceeds 1 MB limit");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function requiredPositiveInteger(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function requiredBoolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function requiredStringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be a string array`);
  }
  return value as string[];
}

function requiredStringMap(
  body: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const value = body[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }
  if (Object.values(value).some((item) => typeof item !== "string")) {
    throw new Error(`${key} values must be strings`);
  }
  return value as Record<string, string>;
}

function requiredRules(body: Record<string, unknown>): WorkspaceCommandRule[] {
  const value = body.rules;
  if (!Array.isArray(value)) {
    throw new Error("rules must be an array");
  }
  return value.map((rule) => {
    if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error("rules entries must be objects");
    }
    const record = rule as Record<string, unknown>;
    const executable = requiredString(record, "executable");
    const allowedArguments = record.allowedArguments;
    if (
      !Array.isArray(allowedArguments) ||
      allowedArguments.some(
        (vector) =>
          !Array.isArray(vector) || vector.some((argument) => typeof argument !== "string"),
      )
    ) {
      throw new Error("allowedArguments must be an array of string arrays");
    }
    return {
      executable,
      allowedArguments: allowedArguments as string[][],
    };
  });
}

export function attachWorkspaceCommandRoute(
  server: Server,
  config: AppConfig,
  store: WorkspaceCommandStore,
  service: WorkspaceCommandService,
): void {
  const existingListeners = server.listeners("request") as unknown as RequestHandler[];
  server.removeAllListeners("request");

  server.on("request", (request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );
    const policyMatch = method === "POST" ? POLICY_PATH.exec(url.pathname) : null;
    const prepareMatch = method === "POST" ? PREPARE_PATH.exec(url.pathname) : null;
    const runMatch = method === "POST" ? RUN_PATH.exec(url.pathname) : null;
    const readMatch = method === "GET" ? READ_PATH.exec(url.pathname) : null;
    const projectStatusMatch =
      method === "GET" ? PROJECT_STATUS_PATH.exec(url.pathname) : null;
    const platformStatus = method === "GET" && url.pathname === PLATFORM_STATUS_PATH;

    if (
      !policyMatch &&
      !prepareMatch &&
      !runMatch &&
      !readMatch &&
      !projectStatusMatch &&
      !platformStatus
    ) {
      for (const listener of existingListeners) {
        listener(request, response);
      }
      return;
    }

    void (async () => {
      try {
        const actor = authenticateBearerToken(request.headers.authorization, {
          internalApiToken: config.internalApiToken,
          internalServiceId: config.internalServiceId,
          founderApiToken: config.founderApiToken,
          founderInterfaceApiToken: config.founderInterfaceApiToken,
          founderId: config.founderId,
        });
        if (!actor) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        if (actor.credentialKind !== "INTERNAL") {
          sendJson(response, 403, {
            error: "forbidden",
            message: "Only the internal Control Plane service may operate workspace commands",
          });
          return;
        }

        if (policyMatch) {
          const body = await readJsonBody(request);
          const purposes = requiredStringArray(body, "purposes");
          if (
            purposes.some(
              (purpose) =>
                !WORKSPACE_COMMAND_PURPOSES.includes(purpose as WorkspaceCommandPurpose),
            )
          ) {
            throw new Error("purposes contains an unsupported workspace command purpose");
          }
          const result = await store.createWorkspaceCommandPolicy({
            projectId: decodeURIComponent(policyMatch[1] ?? ""),
            policyKey: requiredString(body, "policyKey"),
            version: requiredPositiveInteger(body, "version"),
            enabled: requiredBoolean(body, "enabled"),
            policy: {
              purposes: purposes as WorkspaceCommandPurpose[],
              rules: requiredRules(body),
              environmentAllowlist: requiredStringArray(body, "environmentAllowlist"),
              maxTimeoutMs: requiredPositiveInteger(body, "maxTimeoutMs"),
              maxOutputBytes: requiredPositiveInteger(body, "maxOutputBytes"),
              maxCommandsPerWorkspace: requiredPositiveInteger(
                body,
                "maxCommandsPerWorkspace",
              ),
            },
            actor,
          });
          sendJson(response, 201, result);
          return;
        }

        if (prepareMatch) {
          const body = await readJsonBody(request);
          const purpose = requiredString(body, "purpose");
          if (!WORKSPACE_COMMAND_PURPOSES.includes(purpose as WorkspaceCommandPurpose)) {
            throw new Error("purpose must be a supported workspace command purpose");
          }
          const result = await store.prepareWorkspaceCommand({
            repositoryWorkspaceId: decodeURIComponent(prepareMatch[1] ?? ""),
            policyKey: requiredString(body, "policyKey"),
            purpose: purpose as WorkspaceCommandPurpose,
            executable: requiredString(body, "executable"),
            arguments: requiredStringArray(body, "arguments"),
            timeoutMs: requiredPositiveInteger(body, "timeoutMs"),
            maxOutputBytes: requiredPositiveInteger(body, "maxOutputBytes"),
            environment: requiredStringMap(body, "environment"),
            actor,
          });
          sendJson(response, 201, result);
          return;
        }

        if (runMatch) {
          const result = await service.run({
            workspaceCommandRunId: decodeURIComponent(runMatch[1] ?? ""),
            actor,
          });
          sendJson(response, 200, result);
          return;
        }

        if (projectStatusMatch) {
          sendJson(
            response,
            200,
            await store.getProjectWorkspaceCommandStatus(
              decodeURIComponent(projectStatusMatch[1] ?? ""),
            ),
          );
          return;
        }

        if (platformStatus) {
          sendJson(response, 200, await store.getPlatformWorkspaceCommandStatus());
          return;
        }

        const run = await store.getWorkspaceCommandRun(
          decodeURIComponent(readMatch?.[1] ?? ""),
        );
        if (!run) {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        sendJson(response, 200, run);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        if (message.includes("not found") || message.includes("not registered")) {
          sendJson(response, 404, { error: "not_found", message });
          return;
        }
        if (message.toLowerCase().includes("conflict")) {
          sendJson(response, 409, { error: "conflict", message });
          return;
        }
        if (
          message.includes("must be") ||
          message.includes("Request body") ||
          message.includes("JSON") ||
          message.includes("unsupported") ||
          message.includes("not allowed") ||
          message.includes("reserved environment")
        ) {
          sendJson(response, 400, { error: "bad_request", message });
          return;
        }
        console.error(error);
        sendJson(response, 500, { error: "internal_error" });
      }
    })();
  });
}
