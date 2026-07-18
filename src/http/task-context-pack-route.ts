import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { AppConfig } from "../config.js";
import { authenticateBearerToken } from "../security/auth.js";
import type { TaskContextPackStore } from "../store/task-context-pack-types.js";

const MAX_BODY_BYTES = 1_000_000;
const PACK_PATH = /^\/v1\/execution-attempts\/([^/]+)\/task-context-pack$/;

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
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function relevantPaths(body: Record<string, unknown>): readonly string[] {
  const value = body.relevantPaths;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("relevantPaths must be an array of strings");
  }
  return value;
}

export function attachTaskContextPackRoute(
  server: Server,
  config: AppConfig,
  store: TaskContextPackStore,
): void {
  const existingListeners = server.listeners("request") as unknown as RequestHandler[];
  server.removeAllListeners("request");

  server.on("request", (request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );
    const match = PACK_PATH.exec(url.pathname);

    if (!match || (method !== "POST" && method !== "GET")) {
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
            message: "Task Context Packs are restricted to the internal Control Plane service",
          });
          return;
        }

        const executionAttemptId = decodeURIComponent(match[1] ?? "");
        if (method === "GET") {
          const pack = await store.getTaskContextPack(executionAttemptId);
          if (!pack) {
            sendJson(response, 404, { error: "not_found" });
            return;
          }
          sendJson(response, 200, pack);
          return;
        }

        const body = await readJsonBody(request);
        const pack = await store.createTaskContextPack({
          executionAttemptId,
          leaseToken: requiredString(body, "leaseToken"),
          baseBranch: requiredString(body, "baseBranch"),
          baseCommitSha: requiredString(body, "baseCommitSha"),
          relevantPaths: relevantPaths(body),
          actor,
        });
        sendJson(response, 201, pack);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        if (message.includes("not found")) {
          sendJson(response, 404, { error: "not_found", message });
          return;
        }
        if (
          message.toLowerCase().includes("conflict") ||
          message.includes("lease proof")
        ) {
          sendJson(response, 409, { error: "conflict", message });
          return;
        }
        if (
          message.includes("must be") ||
          message.includes("relevantPaths") ||
          message.includes("baseCommitSha") ||
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
