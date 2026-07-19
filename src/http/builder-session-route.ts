import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { AppConfig } from "../config.js";
import { authenticateBearerToken } from "../security/auth.js";
import type { GovernedBuilderSessionService } from "../services/governed-builder-session-service.js";
import type { BuilderSessionStore } from "../store/builder-session-types.js";

const MAX_BODY_BYTES = 100_000;
const PREPARE_PATH = /^\/v1\/builder-invocations\/([^/]+)\/session$/;
const STEP_PATH = /^\/v1\/builder-sessions\/([^/]+)\/step$/;
const CANCEL_PATH = /^\/v1\/builder-sessions\/([^/]+)\/cancel$/;
const READ_PATH = /^\/v1\/builder-sessions\/([^/]+)$/;
const PROJECT_STATUS_PATH = /^\/v1\/projects\/([^/]+)\/builder-sessions\/status$/;
const PLATFORM_STATUS_PATH = "/v1/builder-sessions/status";

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
      throw new Error("Request body exceeds builder session limit");
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

function optionalString(
  body: Record<string, unknown>,
  key: string,
  fallback: string | null,
): string | null {
  const value = body[key];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string when provided`);
  }
  return value;
}

function boundedInteger(
  body: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = body[key] ?? fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

export function attachBuilderSessionRoute(
  server: Server,
  config: AppConfig,
  store: BuilderSessionStore,
  service: GovernedBuilderSessionService,
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
    const stepMatch = method === "POST" ? STEP_PATH.exec(url.pathname) : null;
    const cancelMatch = method === "POST" ? CANCEL_PATH.exec(url.pathname) : null;
    const readMatch = method === "GET" ? READ_PATH.exec(url.pathname) : null;
    const projectStatusMatch =
      method === "GET" ? PROJECT_STATUS_PATH.exec(url.pathname) : null;
    const platformStatus = method === "GET" && url.pathname === PLATFORM_STATUS_PATH;

    if (
      !prepareMatch &&
      !stepMatch &&
      !cancelMatch &&
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
            message: "Only the internal Control Plane service may operate builder sessions",
          });
          return;
        }

        if (prepareMatch) {
          const prepared = await service.prepare({
            builderInvocationId: decodeURIComponent(prepareMatch[1] ?? ""),
            actor,
          });
          sendJson(response, 201, prepared);
          return;
        }

        if (stepMatch) {
          const body = await readJsonBody(request);
          const result = await service.step({
            builderSessionId: decodeURIComponent(stepMatch[1] ?? ""),
            claimOwner:
              optionalString(body, "claimOwner", `internal:${actor.id}`) ??
              `internal:${actor.id}`,
            stepLeaseSeconds: boundedInteger(body, "stepLeaseSeconds", 120, 30, 3600),
            executionLeaseSeconds: boundedInteger(
              body,
              "executionLeaseSeconds",
              600,
              30,
              3600,
            ),
            dispatchLeaseSeconds: boundedInteger(
              body,
              "dispatchLeaseSeconds",
              600,
              30,
              3600,
            ),
            commandPolicyKey: optionalString(body, "commandPolicyKey", null),
            actor,
          });
          sendJson(response, 200, result);
          return;
        }

        if (cancelMatch) {
          const body = await readJsonBody(request);
          const result = await service.cancel({
            builderSessionId: decodeURIComponent(cancelMatch[1] ?? ""),
            summary:
              optionalString(
                body,
                "summary",
                "Builder session cancelled by internal Control Plane authority.",
              ) ?? "Builder session cancelled by internal Control Plane authority.",
            actor,
          });
          sendJson(response, 200, result);
          return;
        }

        if (projectStatusMatch) {
          sendJson(
            response,
            200,
            await store.getProjectBuilderSessionStatus(
              decodeURIComponent(projectStatusMatch[1] ?? ""),
            ),
          );
          return;
        }

        if (platformStatus) {
          sendJson(response, 200, await store.getPlatformBuilderSessionStatus());
          return;
        }

        const session = await store.getBuilderSession(
          decodeURIComponent(readMatch?.[1] ?? ""),
        );
        if (!session) {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        sendJson(response, 200, session);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown builder session error";
        sendJson(response, 409, { error: "builder_session_conflict", message });
      }
    })();
  });
}
