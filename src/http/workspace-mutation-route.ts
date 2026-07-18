import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { AppConfig } from "../config.js";
import {
  WORKSPACE_MUTATION_OPERATION_TYPES,
  type WorkspaceMutationOperation,
  type WorkspaceMutationOperationType,
} from "../domain/workspace-mutation.js";
import { authenticateBearerToken } from "../security/auth.js";
import type { WorkspaceMutationService } from "../services/workspace-mutation-service.js";
import type { WorkspaceMutationStore } from "../store/workspace-mutation-types.js";

const MAX_BODY_BYTES = 6_500_000;
const PREPARE_PATH = /^\/v1\/repository-workspaces\/([^/]+)\/mutations$/;
const APPLY_PATH = /^\/v1\/workspace-mutation-runs\/([^/]+)\/apply$/;
const READ_PATH = /^\/v1\/workspace-mutation-runs\/([^/]+)$/;
const PROJECT_STATUS_PATH = /^\/v1\/projects\/([^/]+)\/workspace-mutations\/status$/;
const PLATFORM_STATUS_PATH = "/v1/workspace-mutations/status";

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
      throw new Error("Request body exceeds workspace mutation limit");
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

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function nullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string or null`);
  }
  return value;
}

function requiredOperations(body: Record<string, unknown>): WorkspaceMutationOperation[] {
  const value = body.operations;
  if (!Array.isArray(value)) {
    throw new Error("operations must be an array");
  }
  return value.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("operations entries must be objects");
    }
    const record = item as Record<string, unknown>;
    const type = requiredString(record, "type");
    if (!WORKSPACE_MUTATION_OPERATION_TYPES.includes(type as WorkspaceMutationOperationType)) {
      throw new Error("type must be CREATE, UPDATE, or DELETE");
    }
    return {
      type: type as WorkspaceMutationOperationType,
      path: requiredString(record, "path"),
      expectedBeforeHash: nullableString(record, "expectedBeforeHash"),
      content: nullableString(record, "content"),
    };
  });
}

export function attachWorkspaceMutationRoute(
  server: Server,
  config: AppConfig,
  store: WorkspaceMutationStore,
  service: WorkspaceMutationService,
): void {
  const existingListeners = server.listeners("request") as unknown as RequestHandler[];
  server.removeAllListeners("request");

  server.on("request", (request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );
    const prepareMatch = method === "POST" ? PREPARE_PATH.exec(url.pathname) : null;
    const applyMatch = method === "POST" ? APPLY_PATH.exec(url.pathname) : null;
    const readMatch = method === "GET" ? READ_PATH.exec(url.pathname) : null;
    const projectStatusMatch =
      method === "GET" ? PROJECT_STATUS_PATH.exec(url.pathname) : null;
    const platformStatus = method === "GET" && url.pathname === PLATFORM_STATUS_PATH;

    if (!prepareMatch && !applyMatch && !readMatch && !projectStatusMatch && !platformStatus) {
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
            message: "Only the internal Control Plane service may operate workspace mutations",
          });
          return;
        }

        if (prepareMatch) {
          const body = await readJsonBody(request);
          const result = await store.prepareWorkspaceMutation({
            repositoryWorkspaceId: decodeURIComponent(prepareMatch[1] ?? ""),
            operations: requiredOperations(body),
            actor,
          });
          sendJson(response, 201, result);
          return;
        }

        if (applyMatch) {
          const result = await service.apply({
            workspaceMutationRunId: decodeURIComponent(applyMatch[1] ?? ""),
            actor,
          });
          sendJson(response, 200, result);
          return;
        }

        if (projectStatusMatch) {
          sendJson(
            response,
            200,
            await store.getProjectWorkspaceMutationStatus(
              decodeURIComponent(projectStatusMatch[1] ?? ""),
            ),
          );
          return;
        }

        if (platformStatus) {
          sendJson(response, 200, await store.getPlatformWorkspaceMutationStatus());
          return;
        }

        const run = await store.getWorkspaceMutationRun(
          decodeURIComponent(readMatch?.[1] ?? ""),
        );
        if (!run) {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        sendJson(response, 200, run);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        if (message.includes("not found")) {
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
          message.includes("unsupported") ||
          message.includes("cannot exceed") ||
          message.includes("requires") ||
          message.includes("must not")
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
