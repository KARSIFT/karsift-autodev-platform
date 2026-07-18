import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { AppConfig } from "../config.js";
import { REPOSITORY_WORKSPACE_MODES } from "../domain/repository-workspace.js";
import { authenticateBearerToken } from "../security/auth.js";
import type { RepositoryWorkspaceService } from "../services/repository-workspace-service.js";
import type { RepositoryWorkspaceStore } from "../store/repository-workspace-types.js";

const MAX_BODY_BYTES = 1_000_000;
const PREPARE_PATH = /^\/v1\/builder-invocations\/([^/]+)\/repository-workspaces$/;
const MATERIALIZE_PATH = /^\/v1\/repository-workspaces\/([^/]+)\/materialize$/;
const FINALIZE_PATH = /^\/v1\/repository-workspaces\/([^/]+)\/finalize$/;
const ABANDON_PATH = /^\/v1\/repository-workspaces\/([^/]+)\/abandon$/;
const READ_PATH = /^\/v1\/repository-workspaces\/([^/]+)$/;
const PROJECT_STATUS_PATH = /^\/v1\/projects\/([^/]+)\/repository-workspaces\/status$/;
const PLATFORM_STATUS_PATH = "/v1/repository-workspaces/status";

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

export function attachRepositoryWorkspaceRoute(
  server: Server,
  config: AppConfig,
  store: RepositoryWorkspaceStore,
  service: RepositoryWorkspaceService,
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
    const materializeMatch =
      method === "POST" ? MATERIALIZE_PATH.exec(url.pathname) : null;
    const finalizeMatch = method === "POST" ? FINALIZE_PATH.exec(url.pathname) : null;
    const abandonMatch = method === "POST" ? ABANDON_PATH.exec(url.pathname) : null;
    const readMatch = method === "GET" ? READ_PATH.exec(url.pathname) : null;
    const projectStatusMatch =
      method === "GET" ? PROJECT_STATUS_PATH.exec(url.pathname) : null;
    const platformStatus = method === "GET" && url.pathname === PLATFORM_STATUS_PATH;

    if (
      !prepareMatch &&
      !materializeMatch &&
      !finalizeMatch &&
      !abandonMatch &&
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
            message: "Only the internal Control Plane service may operate repository workspaces",
          });
          return;
        }

        if (prepareMatch) {
          const body = await readJsonBody(request);
          const mode = requiredString(body, "mode");
          if (!REPOSITORY_WORKSPACE_MODES.includes(mode as "READ_ONLY" | "WRITE")) {
            throw new Error("mode must be READ_ONLY or WRITE");
          }
          const prepared = await store.prepareRepositoryWorkspace({
            builderInvocationId: decodeURIComponent(prepareMatch[1] ?? ""),
            mode: mode as "READ_ONLY" | "WRITE",
            actor,
          });
          sendJson(response, 201, prepared);
          return;
        }

        if (materializeMatch) {
          const body = await readJsonBody(request);
          const result = await service.materialize({
            repositoryWorkspaceId: decodeURIComponent(materializeMatch[1] ?? ""),
            sourceRepositoryPath: requiredString(body, "sourceRepositoryPath"),
            actor,
          });
          sendJson(response, 200, result);
          return;
        }

        if (finalizeMatch) {
          const result = await service.finalize({
            repositoryWorkspaceId: decodeURIComponent(finalizeMatch[1] ?? ""),
            actor,
          });
          sendJson(response, 200, result);
          return;
        }

        if (abandonMatch) {
          const result = await service.abandon({
            repositoryWorkspaceId: decodeURIComponent(abandonMatch[1] ?? ""),
            actor,
          });
          sendJson(response, 200, result);
          return;
        }

        if (projectStatusMatch) {
          sendJson(
            response,
            200,
            await store.getProjectRepositoryWorkspaceStatus(
              decodeURIComponent(projectStatusMatch[1] ?? ""),
            ),
          );
          return;
        }

        if (platformStatus) {
          sendJson(response, 200, await store.getPlatformRepositoryWorkspaceStatus());
          return;
        }

        const workspace = await store.getRepositoryWorkspace(
          decodeURIComponent(readMatch?.[1] ?? ""),
        );
        if (!workspace) {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        sendJson(response, 200, workspace);
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
          message.includes("JSON")
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
