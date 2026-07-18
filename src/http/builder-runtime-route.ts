import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { AppConfig } from "../config.js";
import { authenticateBearerToken } from "../security/auth.js";
import type { BuilderRuntimeService } from "../services/builder-runtime-service.js";
import type { BuilderRuntimeStore } from "../store/builder-runtime-types.js";

const MAX_BODY_BYTES = 1_000_000;
const PREPARE_PATH = /^\/v1\/execution-attempts\/([^/]+)\/builder-invocations$/;
const RUN_PATH = /^\/v1\/builder-invocations\/([^/]+)\/run-dry-run$/;
const READ_PATH = /^\/v1\/builder-invocations\/([^/]+)$/;

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

function requiredSafeInteger(
  body: Record<string, unknown>,
  key: string,
  minimum: number,
): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${key} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

export function attachBuilderRuntimeRoute(
  server: Server,
  config: AppConfig,
  store: BuilderRuntimeStore,
  service: BuilderRuntimeService,
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
    const runMatch = method === "POST" ? RUN_PATH.exec(url.pathname) : null;
    const readMatch = method === "GET" ? READ_PATH.exec(url.pathname) : null;

    if (!prepareMatch && !runMatch && !readMatch) {
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
            message: "Only the internal Control Plane service may operate the builder runtime",
          });
          return;
        }

        if (prepareMatch) {
          const body = await readJsonBody(request);
          const prepared = await store.prepareBuilderInvocation({
            executionAttemptId: decodeURIComponent(prepareMatch[1] ?? ""),
            leaseToken: requiredString(body, "leaseToken"),
            limits: {
              maxTurns: requiredSafeInteger(body, "maxTurns", 1),
              retryBudget: requiredSafeInteger(body, "retryBudget", 0),
              commandBudget: requiredSafeInteger(body, "commandBudget", 0),
              timeoutSeconds: requiredSafeInteger(body, "timeoutSeconds", 1),
            },
            actor,
          });
          sendJson(response, 201, prepared);
          return;
        }

        if (runMatch) {
          const result = await service.runBuilderInvocation({
            builderInvocationId: decodeURIComponent(runMatch[1] ?? ""),
            actor,
          });
          sendJson(response, 200, result);
          return;
        }

        const invocation = await store.getBuilderInvocation(
          decodeURIComponent(readMatch?.[1] ?? ""),
        );
        if (!invocation) {
          sendJson(response, 404, { error: "not_found" });
          return;
        }
        sendJson(response, 200, invocation);
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
