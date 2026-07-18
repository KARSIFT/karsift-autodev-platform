import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { AppConfig } from "../config.js";
import { authenticateBearerToken } from "../security/auth.js";
import type { BuilderProposalService } from "../services/builder-proposal-service.js";
import type { BuilderProposalStore } from "../store/builder-proposal-types.js";

const MAX_BODY_BYTES = 100_000;
const PREPARE_PATH = /^\/v1\/builder-invocations\/([^/]+)\/proposals$/;
const GENERATE_PATH = /^\/v1\/builder-proposal-runs\/([^/]+)\/generate$/;
const READ_PATH = /^\/v1\/builder-proposal-runs\/([^/]+)$/;
const PROJECT_STATUS_PATH = /^\/v1\/projects\/([^/]+)\/builder-proposals\/status$/;
const PLATFORM_STATUS_PATH = "/v1/builder-proposals/status";

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
      throw new Error("Request body exceeds builder proposal limit");
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

export function attachBuilderProposalRoute(
  server: Server,
  config: AppConfig,
  store: BuilderProposalStore,
  service: BuilderProposalService,
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
    const generateMatch = method === "POST" ? GENERATE_PATH.exec(url.pathname) : null;
    const readMatch = method === "GET" ? READ_PATH.exec(url.pathname) : null;
    const projectStatusMatch =
      method === "GET" ? PROJECT_STATUS_PATH.exec(url.pathname) : null;
    const platformStatus = method === "GET" && url.pathname === PLATFORM_STATUS_PATH;

    if (!prepareMatch && !generateMatch && !readMatch && !projectStatusMatch && !platformStatus) {
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
            message: "Only the internal Control Plane service may operate builder proposals",
          });
          return;
        }

        if (prepareMatch) {
          const body = await readJsonBody(request);
          const result = await store.prepareBuilderProposal({
            builderInvocationId: decodeURIComponent(prepareMatch[1] ?? ""),
            workspaceReadContextRunId: requiredString(
              body,
              "workspaceReadContextRunId",
            ),
            actor,
          });
          sendJson(response, 201, result);
          return;
        }

        if (generateMatch) {
          const body = await readJsonBody(request);
          const result = await service.generate({
            builderProposalRunId: decodeURIComponent(generateMatch[1] ?? ""),
            claimOwner: requiredString(body, "claimOwner"),
            claimLeaseSeconds: requiredPositiveInteger(body, "claimLeaseSeconds"),
            actor,
          });
          sendJson(response, 200, result);
          return;
        }

        if (projectStatusMatch) {
          sendJson(
            response,
            200,
            await store.getProjectBuilderProposalStatus(
              decodeURIComponent(projectStatusMatch[1] ?? ""),
            ),
          );
          return;
        }

        if (platformStatus) {
          sendJson(response, 200, await store.getPlatformBuilderProposalStatus());
          return;
        }

        const run = await store.getBuilderProposalRun(
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
          message.includes("cannot exceed") ||
          message.includes("unsupported")
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
