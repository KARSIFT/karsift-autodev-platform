import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { AppConfig } from "../config.js";
import { authenticateBearerToken } from "../security/auth.js";
import type { ContractAuthorizationStore } from "../store/contract-authorization-types.js";

const MAX_BODY_BYTES = 1_000_000;
const AUTHORIZATION_PATH = /^\/v1\/change-contracts\/([^/]+)\/authorization-decisions$/;

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

export function attachContractAuthorizationRoute(
  server: Server,
  config: AppConfig,
  store: ContractAuthorizationStore,
): void {
  const existingListeners = server.listeners("request") as unknown as RequestHandler[];
  server.removeAllListeners("request");

  server.on("request", (request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );
    const match = AUTHORIZATION_PATH.exec(url.pathname);

    if (method !== "POST" || !match) {
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

        if (actor.credentialKind === "FOUNDER_INTERFACE") {
          sendJson(response, 403, {
            error: "forbidden",
            message:
              "Founder interface credential is not authorized to change contract authority",
          });
          return;
        }

        const body = await readJsonBody(request);
        const action = body.action;
        if (action !== "AUTHORIZE" && action !== "REVOKE") {
          sendJson(response, 400, {
            error: "bad_request",
            message: "action must be AUTHORIZE or REVOKE",
          });
          return;
        }

        const rationale = body.rationale;
        if (
          rationale !== undefined &&
          rationale !== null &&
          typeof rationale !== "string"
        ) {
          sendJson(response, 400, {
            error: "bad_request",
            message: "rationale must be a string when provided",
          });
          return;
        }

        const result = await store.recordChangeContractAuthorization({
          changeContractId: decodeURIComponent(match[1] ?? ""),
          action,
          rationale: typeof rationale === "string" ? rationale : null,
          actor,
        });

        if (action === "AUTHORIZE" && !result.authorized) {
          sendJson(response, 403, {
            error: "authorization_denied",
            ...result,
          });
          return;
        }

        sendJson(response, 201, result);
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
          message.includes("governance") ||
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
