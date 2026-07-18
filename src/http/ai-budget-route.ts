import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { EXECUTION_CLASSES, type ExecutionClass } from "../domain/ai-budget.js";
import type { AppConfig } from "../config.js";
import { authenticateBearerToken } from "../security/auth.js";
import type { AiBudgetStore } from "../store/ai-budget-types.js";

const MAX_BODY_BYTES = 1_000_000;
const POLICY_PATH = /^\/v1\/projects\/([^/]+)\/ai-budget-policy$/;
const DECISION_PATH = /^\/v1\/work-queue\/([^/]+)\/budget-decisions$/;
const SETTLEMENT_PATH = /^\/v1\/execution-attempts\/([^/]+)\/budget-settlement$/;

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

function requiredSafeInteger(
  body: Record<string, unknown>,
  key: string,
  min = 0,
): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    throw new Error(`${key} must be a safe integer >= ${min}`);
  }
  return value as number;
}

function requiredBoolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function requiredExecutionClass(body: Record<string, unknown>): ExecutionClass {
  const value = body.executionClass;
  if (
    typeof value !== "string" ||
    !EXECUTION_CLASSES.includes(value as ExecutionClass)
  ) {
    throw new Error(
      `executionClass must be one of ${EXECUTION_CLASSES.join(", ")}`,
    );
  }
  return value as ExecutionClass;
}

export function attachAiBudgetRoute(
  server: Server,
  config: AppConfig,
  store: AiBudgetStore,
): void {
  const existingListeners = server.listeners("request") as unknown as RequestHandler[];
  server.removeAllListeners("request");

  server.on("request", (request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );

    const policyMatch = method === "PUT" ? POLICY_PATH.exec(url.pathname) : null;
    const decisionMatch =
      method === "POST" ? DECISION_PATH.exec(url.pathname) : null;
    const settlementMatch =
      method === "POST" ? SETTLEMENT_PATH.exec(url.pathname) : null;

    if (!policyMatch && !decisionMatch && !settlementMatch) {
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
              "Founder interface credential is not authorized to manage AI budget execution gates",
          });
          return;
        }

        const body = await readJsonBody(request);

        if (policyMatch) {
          const maxAiTier = requiredSafeInteger(body, "maxAiTier");
          if (maxAiTier > 4) {
            throw new Error("maxAiTier must be between 0 and 4");
          }

          const policy = await store.upsertAiBudgetPolicy({
            projectId: decodeURIComponent(policyMatch[1] ?? ""),
            monthlyLimitMicrousd: requiredSafeInteger(
              body,
              "monthlyLimitMicrousd",
            ),
            perWorkLimitMicrousd: requiredSafeInteger(
              body,
              "perWorkLimitMicrousd",
            ),
            maxAiTier: maxAiTier as 0 | 1 | 2 | 3 | 4,
            enabled: requiredBoolean(body, "enabled"),
            actor,
          });
          sendJson(response, 200, policy);
          return;
        }

        if (actor.credentialKind !== "INTERNAL") {
          sendJson(response, 403, {
            error: "forbidden",
            message:
              "Only the internal Control Plane service may authorize or settle execution budget",
          });
          return;
        }

        if (decisionMatch) {
          const result = await store.authorizeWorkBudget({
            workQueueItemId: decodeURIComponent(decisionMatch[1] ?? ""),
            executionClass: requiredExecutionClass(body),
            estimatedMaxCostMicrousd: requiredSafeInteger(
              body,
              "estimatedMaxCostMicrousd",
            ),
            actor,
          });
          sendJson(response, 201, result);
          return;
        }

        const settlement = await store.settleAiBudgetReservation({
          executionAttemptId: decodeURIComponent(settlementMatch?.[1] ?? ""),
          actualCostMicrousd: requiredSafeInteger(body, "actualCostMicrousd"),
          actor,
        });
        sendJson(response, 200, settlement);
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
          message.includes("cannot exceed") ||
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
