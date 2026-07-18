import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { AppConfig } from "../config.js";
import { authenticateBearerToken } from "../security/auth.js";
import type { WorkspaceReadContextService } from "../services/workspace-read-context-service.js";
import type { WorkspaceReadContextStore } from "../store/workspace-read-context-types.js";

const MAX_BODY_BYTES = 100_000;
const PREPARE_PATH = /^\/v1\/repository-workspaces\/([^/]+)\/read-contexts$/;
const CAPTURE_PATH = /^\/v1\/workspace-read-context-runs\/([^/]+)\/capture$/;
const READ_PATH = /^\/v1\/workspace-read-context-runs\/([^/]+)$/;
const PROJECT_STATUS_PATH = /^\/v1\/projects\/([^/]+)\/workspace-read-contexts\/status$/;
const PLATFORM_STATUS_PATH = "/v1/workspace-read-contexts/status";

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
      throw new Error("Request body exceeds workspace read context limit");
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

function requiredStringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be a string array`);
  }
  return value as string[];
}

export function attachWorkspaceReadContextRoute(
  server: Server,
  config: AppConfig,
  store: WorkspaceReadContextStore,
  service: WorkspaceReadContextService,
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
    const captureMatch = method === "POST" ? CAPTURE_PATH.exec(url.pathname) : null;
    const readMatch = method === "GET" ? READ_PATH.exec(url.pathname) : null;
    const projectStatusMatch =
      method === "GET" ? PROJECT_STATUS_PATH.exec(url.pathname) : null;
    const platformStatus = method === "GET" && url.pathname === PLATFORM_STATUS_PATH;

    if (!prepareMatch && !captureMatch && !readMatch && !projectStatusMatch && !platformStatus) {
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
            message: "Only the internal Control Plane service may operate workspace read contexts",
          });
          return;
        }

        if (prepareMatch) {
          const body = await readJsonBody(request);
          const result = await store.prepareWorkspaceReadContext({
            repositoryWorkspaceId: decodeURIComponent(prepareMatch[1] ?? ""),
            requestedPaths: requiredStringArray(body, "requestedPaths"),
            actor,
          });
          sendJson(response, 201, result);
          return;
        }

        if (captureMatch) {
          const result = await service.capture({
            workspaceReadContextRunId: decodeURIComponent(captureMatch[1] ?? ""),
            actor,
          });
          sendJson(response, 200, result);
          return;
        }

        if (projectStatusMatch) {
          sendJson(
            response,
            200,
            await store.getProjectWorkspaceReadContextStatus(
              decodeURIComponent(projectStatusMatch[1] ?? ""),
            ),
          );
          return;
        }

        if (platformStatus) {
          sendJson(response, 200, await store.getPlatformWorkspaceReadContextStatus());
          return;
        }

        const run = await store.getWorkspaceReadContextRun(
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
          message.includes("cannot exceed") ||
          message.includes("requires") ||
          message.includes("protected path") ||
          message.includes("outside relevant scope")
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
