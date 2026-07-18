import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import type { AppConfig } from "../config.js";
import { assertCapability } from "../domain/capabilities.js";
import type { WorkflowStatus } from "../domain/workflow-state.js";
import { authenticateBearerToken } from "../security/auth.js";
import { isFounderInterfaceRouteAllowed } from "../security/authorization.js";
import type { ControlPlaneStore } from "../store/types.js";
import { ValidationError } from "./errors.js";
import { createFounderOpenApiDocument } from "./founder-openapi.js";
import {
  asObject,
  optionalObject,
  optionalString,
  requiredInteger,
  requiredObject,
  requiredString,
} from "./validation.js";

const MAX_BODY_BYTES = 1_000_000;

interface RouteMatch {
  readonly params: Record<string, string>;
}

function matchPath(
  pathname: string,
  pattern: string,
): RouteMatch | null {
  const actualParts = pathname.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);

  if (actualParts.length !== patternParts.length) {
    return null;
  }

  const params: Record<string, string> = {};

  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index];
    const actual = actualParts[index];

    if (!expected || !actual) {
      return null;
    }

    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }

    if (expected !== actual) {
      return null;
    }
  }

  return { params };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
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

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function isWorkflowStatus(value: string): value is WorkflowStatus {
  return (
    value === "CREATED" ||
    value === "RUNNING" ||
    value === "BLOCKED" ||
    value === "SUCCEEDED" ||
    value === "FAILED" ||
    value === "CANCELLED"
  );
}

export function createControlPlaneServer(
  config: AppConfig,
  store: ControlPlaneStore,
) {
  return createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    try {
      if (method === "GET" && url.pathname === "/health") {
        await store.ping();
        sendJson(response, 200, {
          status: "ok",
          activationLevel: "A1",
          autonomousDispatch: false,
        });
        return;
      }

      if (method === "GET" && url.pathname === "/openapi.json") {
        sendJson(response, 200, createFounderOpenApiDocument(config.publicBaseUrl));
        return;
      }

      if (!url.pathname.startsWith("/v1/")) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }

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

      if (!isFounderInterfaceRouteAllowed(actor, method, url.pathname)) {
        sendJson(response, 403, {
          error: "forbidden",
          message: "Founder interface credential is not authorized for this operation",
        });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/status") {
        sendJson(response, 200, await store.getPlatformStatus());
        return;
      }

      if (method === "POST" && url.pathname === "/v1/projects") {
        const body = asObject(await readJsonBody(request));
        const project = await store.createProject(
          {
            slug: requiredString(body, "slug", { max: 63 }),
            name: requiredString(body, "name", { max: 200 }),
            repositoryFullName: requiredString(body, "repositoryFullName", {
              max: 300,
            }),
            defaultBranch: optionalString(body, "defaultBranch") ?? "main",
            integrationBranch:
              optionalString(body, "integrationBranch") ?? "develop",
          },
          actor,
        );
        sendJson(response, 201, project);
        return;
      }

      const projectStatus = matchPath(url.pathname, "/v1/projects/:projectId/status");
      if (method === "GET" && projectStatus) {
        sendJson(
          response,
          200,
          await store.getProjectStatus(projectStatus.params.projectId ?? ""),
        );
        return;
      }

      const projectRequests = matchPath(
        url.pathname,
        "/v1/projects/:projectId/requests",
      );
      if (method === "POST" && projectRequests) {
        const body = asObject(await readJsonBody(request));
        const result = await store.createFounderRequest({
          projectId: projectRequests.params.projectId ?? "",
          title: requiredString(body, "title", { max: 300 }),
          body: requiredString(body, "body", { max: 100_000 }),
          authorityContext: optionalObject(body, "authorityContext"),
          actor,
        });
        sendJson(response, 201, result);
        return;
      }

      const projectDecisions = matchPath(
        url.pathname,
        "/v1/projects/:projectId/decisions",
      );
      if (method === "POST" && projectDecisions) {
        const body = asObject(await readJsonBody(request));
        const authorityLevel = requiredString(body, "authorityLevel");
        if (!["R0", "R1", "R2", "R3", "R4"].includes(authorityLevel)) {
          throw new ValidationError(
            "authorityLevel must be R0, R1, R2, R3, or R4",
          );
        }

        if (authorityLevel === "R4" && actor.type !== "FOUNDER") {
          sendJson(response, 403, {
            error: "forbidden",
            message: "R4 decisions require founder-authenticated authority",
          });
          return;
        }

        const result = await store.createDecision({
          projectId: projectDecisions.params.projectId ?? "",
          requestId: optionalString(body, "requestId"),
          decisionType: requiredString(body, "decisionType", { max: 200 }),
          summary: requiredString(body, "summary", { max: 10_000 }),
          rationale: optionalString(body, "rationale"),
          authorityLevel: authorityLevel as "R0" | "R1" | "R2" | "R3" | "R4",
          metadata: optionalObject(body, "metadata"),
          actor,
        });
        sendJson(response, 201, result);
        return;
      }

      const projectContracts = matchPath(
        url.pathname,
        "/v1/projects/:projectId/change-contracts",
      );
      if (method === "POST" && projectContracts) {
        const body = asObject(await readJsonBody(request));
        const result = await store.createChangeContract({
          projectId: projectContracts.params.projectId ?? "",
          stableId: requiredString(body, "stableId", { max: 200 }),
          content: requiredObject(body, "content"),
          actor,
        });
        sendJson(response, 201, result);
        return;
      }

      const contractVersions = matchPath(
        url.pathname,
        "/v1/change-contracts/:contractId/versions",
      );
      if (method === "POST" && contractVersions) {
        const body = asObject(await readJsonBody(request));
        const result = await store.appendChangeContractVersion({
          contractId: contractVersions.params.contractId ?? "",
          content: requiredObject(body, "content"),
          actor,
        });
        sendJson(response, 201, result);
        return;
      }

      const projectTasks = matchPath(
        url.pathname,
        "/v1/projects/:projectId/tasks",
      );
      if (method === "POST" && projectTasks) {
        const body = asObject(await readJsonBody(request));
        const priority = optionalString(body, "priority") ?? "P2";
        if (!["P0", "P1", "P2", "P3"].includes(priority)) {
          throw new ValidationError("priority must be P0, P1, P2, or P3");
        }

        const result = await store.createTask({
          projectId: projectTasks.params.projectId ?? "",
          changeContractVersionId: requiredString(
            body,
            "changeContractVersionId",
          ),
          title: requiredString(body, "title", { max: 300 }),
          description: requiredString(body, "description", { max: 100_000 }),
          priority: priority as "P0" | "P1" | "P2" | "P3",
          actor,
        });
        sendJson(response, 201, result);
        return;
      }

      const projectWorkflows = matchPath(
        url.pathname,
        "/v1/projects/:projectId/workflow-runs",
      );
      if (method === "POST" && projectWorkflows) {
        const body = asObject(await readJsonBody(request));
        const result = await store.createWorkflowRun({
          projectId: projectWorkflows.params.projectId ?? "",
          taskId: optionalString(body, "taskId"),
          workflowType: requiredString(body, "workflowType", { max: 200 }),
          metadata: optionalObject(body, "metadata"),
          actor,
        });
        sendJson(response, 201, result);
        return;
      }

      const workflowTransition = matchPath(
        url.pathname,
        "/v1/workflow-runs/:workflowRunId/transition",
      );
      if (method === "POST" && workflowTransition) {
        const body = asObject(await readJsonBody(request));
        const targetStatus = requiredString(body, "targetStatus");
        if (!isWorkflowStatus(targetStatus)) {
          throw new ValidationError("targetStatus is not a valid workflow status");
        }

        const result = await store.transitionWorkflowRun({
          workflowRunId: workflowTransition.params.workflowRunId ?? "",
          expectedStateVersion: requiredInteger(body, "expectedStateVersion"),
          targetStatus,
          actor,
        });
        sendJson(response, 200, result);
        return;
      }

      const disableCapability = matchPath(
        url.pathname,
        "/v1/capabilities/:capability/disable",
      );
      if (method === "POST" && disableCapability) {
        const capability = disableCapability.params.capability ?? "";
        assertCapability(capability);
        const body = asObject(await readJsonBody(request));

        const result = await store.disableCapability({
          capability,
          projectId: optionalString(body, "projectId"),
          reason: requiredString(body, "reason", { max: 2_000 }),
          actor,
        });
        sendJson(response, 200, result);
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";

      if (error instanceof ValidationError) {
        sendJson(response, 400, { error: "bad_request", message });
        return;
      }

      if (
        message.includes("version conflict") ||
        message.includes("Invalid workflow transition")
      ) {
        sendJson(response, 409, { error: "conflict", message });
        return;
      }

      if (message.includes("not found")) {
        sendJson(response, 404, { error: "not_found", message });
        return;
      }

      console.error(error);
      sendJson(response, 500, { error: "internal_error" });
    }
  });
}
