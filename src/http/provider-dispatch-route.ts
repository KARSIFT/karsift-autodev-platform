import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { EXECUTION_CLASSES, type ExecutionClass } from "../domain/ai-budget.js";
import {
  PROVIDER_CAPABILITIES,
  PROVIDER_CAPACITY_STATUSES,
  type ProviderCapability,
  type ProviderCapacityStatus,
} from "../domain/provider-capacity.js";
import type { JsonValue } from "../domain/stable-json.js";
import type { AppConfig } from "../config.js";
import { authenticateBearerToken } from "../security/auth.js";
import type {
  AiExecutionClass,
  ProviderDispatchStore,
} from "../store/provider-dispatch-types.js";

const MAX_BODY_BYTES = 1_000_000;
const POLICY_PATH = /^\/v1\/projects\/([^/]+)\/provider-routing-policies$/;
const OBSERVATION_PATH =
  /^\/v1\/projects\/([^/]+)\/provider-capacity-observations$/;
const DECISION_PATH = /^\/v1\/work-queue\/([^/]+)\/provider-dispatch-decisions$/;

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

function optionalString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be null or a non-empty string`);
  }
  return value;
}

function requiredBoolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function requiredSafeInteger(
  body: Record<string, unknown>,
  key: string,
  min: number,
): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    throw new Error(`${key} must be a safe integer >= ${min}`);
  }
  return value as number;
}

function requiredProviderCapability(
  body: Record<string, unknown>,
): ProviderCapability {
  const value = body.capability;
  if (
    typeof value !== "string" ||
    !PROVIDER_CAPABILITIES.includes(value as ProviderCapability)
  ) {
    throw new Error(
      `capability must be one of ${PROVIDER_CAPABILITIES.join(", ")}`,
    );
  }
  return value as ProviderCapability;
}

function requiredProviderCapacityStatus(
  body: Record<string, unknown>,
): ProviderCapacityStatus {
  const value = body.status;
  if (
    typeof value !== "string" ||
    !PROVIDER_CAPACITY_STATUSES.includes(value as ProviderCapacityStatus)
  ) {
    throw new Error(
      `status must be one of ${PROVIDER_CAPACITY_STATUSES.join(", ")}`,
    );
  }
  return value as ProviderCapacityStatus;
}

function requiredAiExecutionClass(body: Record<string, unknown>): AiExecutionClass {
  const value = body.executionClass;
  if (
    typeof value !== "string" ||
    !EXECUTION_CLASSES.includes(value as ExecutionClass) ||
    value === "DETERMINISTIC"
  ) {
    throw new Error("executionClass must be one of AI_TIER_1, AI_TIER_2, AI_TIER_3, AI_TIER_4");
  }
  return value as AiExecutionClass;
}

function requiredProviderKeys(body: Record<string, unknown>): string[] {
  const value = body.providerKeys;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("providerKeys must be an array of strings");
  }
  return value as string[];
}

export function attachProviderDispatchRoute(
  server: Server,
  config: AppConfig,
  store: ProviderDispatchStore,
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
    const observationMatch =
      method === "POST" ? OBSERVATION_PATH.exec(url.pathname) : null;
    const decisionMatch = method === "POST" ? DECISION_PATH.exec(url.pathname) : null;

    if (!policyMatch && !observationMatch && !decisionMatch) {
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
              "Founder interface credential is not authorized to manage provider dispatch gates",
          });
          return;
        }

        const body = await readJsonBody(request);

        if (policyMatch) {
          const policy = await store.upsertProviderRoutingPolicy({
            projectId: decodeURIComponent(policyMatch[1] ?? ""),
            executionClass: requiredAiExecutionClass(body),
            capability: requiredProviderCapability(body),
            providerKeys: requiredProviderKeys(body),
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
              "Only the internal Control Plane service may record capacity or evaluate provider dispatch readiness",
          });
          return;
        }

        if (observationMatch) {
          const observation = await store.recordProviderCapacityObservation({
            projectId: decodeURIComponent(observationMatch[1] ?? ""),
            providerKey: requiredString(body, "providerKey"),
            capability: requiredProviderCapability(body),
            status: requiredProviderCapacityStatus(body),
            ttlSeconds: requiredSafeInteger(body, "ttlSeconds", 1),
            quotaResetAt: optionalString(body, "quotaResetAt"),
            details: (body.details ?? {}) as JsonValue,
            actor,
          });
          sendJson(response, 201, observation);
          return;
        }

        const decision = await store.evaluateProviderDispatch({
          workQueueItemId: decodeURIComponent(decisionMatch?.[1] ?? ""),
          capability: requiredProviderCapability(body),
          actor,
        });
        sendJson(response, 201, decision);
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
          message.includes("between 1 and 10") ||
          message.includes("duplicates") ||
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
