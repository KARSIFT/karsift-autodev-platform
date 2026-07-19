import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { AppConfig } from "../config.js";
import { authenticateBearerToken } from "../security/auth.js";
import type { BuilderProposalActionService } from "../services/builder-proposal-action-service.js";
import type { BuilderProposalActionStore } from "../store/builder-proposal-action-types.js";

const MAX_BODY_BYTES = 100_000;
const PREPARE_PATH = /^\/v1\/builder-proposal-runs\/([^/]+)\/actions$/;
const RECONCILE_PATH = /^\/v1\/builder-proposal-action-runs\/([^/]+)\/reconcile$/;
const READ_PATH = /^\/v1\/builder-proposal-action-runs\/([^/]+)$/;
const PROJECT_STATUS_PATH = /^\/v1\/projects\/([^/]+)\/builder-proposal-actions\/status$/;
const PLATFORM_STATUS_PATH = "/v1/builder-proposal-actions/status";

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
      throw new Error("Request body exceeds builder proposal action limit");
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

function optionalString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string when provided`);
  }
  return value;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

export function attachBuilderProposalActionRoute(
  server: Server,
  config: AppConfig,
  store: BuilderProposalActionStore,
  service: BuilderProposalActionService,
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
    const reconcileMatch = method === "POST" ? RECONCILE_PATH.exec(url.pathname) : null;
    const readMatch = method === "GET" ? READ_PATH.exec(url.pathname) : null;
    const projectStatusMatch =
      method === "GET" ? PROJECT_STATUS_PATH.exec(url.pathname) : null;
    const platformStatus = method === "GET" && url.pathname === PLATFORM_STATUS_PATH;

    if (!prepareMatch && !reconcileMatch && !readMatch && !projectStatusMatch && !platformStatus) {
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
            message: "Only the internal Control Plane service may orchestrate builder proposal actions",
          });
          return;
        }

        if (prepareMatch) {
          const body = await readJsonBody(request);
          const result = await service.authorizeAndMaterialize({
            builderProposalRunId: decodeURIComponent(prepareMatch[1] ?? ""),
            commandPolicyKey: optionalString(body, "commandPolicyKey"),
            actor,
          });
          sendJson(response, 201, result);
          return;
        }

        if (reconcileMatch) {
          const result = await service.reconcile({
            builderProposalActionRunId: decodeURIComponent(reconcileMatch[1] ?? ""),
            actor,
          });
          sendJson(response, 200, result);
          return;
        }

        if (projectStatusMatch) {
          sendJson(
            response,
            200,
            await store.getProjectBuilderProposalActionStatus(
              decodeURIComponent(projectStatusMatch[1] ?? ""),
            ),
          );
          return;
        }

        if (platformStatus) {
          sendJson(response, 200, await store.getPlatformBuilderProposalActionStatus());
          return;
        }

        const run = await store.getBuilderProposalActionRun(
          decodeURIComponent(readMatch?.[1] ?? ""),
        );
        if (!run) {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        sendJson(response, 200, run);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown builder proposal action error";
        sendJson(response, 409, { error: "builder_proposal_action_conflict", message });
      }
    })();
  });
}
