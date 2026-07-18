import { ValidationError } from "./errors.js";
import type { JsonValue } from "../domain/stable-json.js";

export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return value as JsonObject;
}

export function requiredString(
  body: JsonObject,
  key: string,
  options: { min?: number; max?: number } = {},
): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw new ValidationError(`${key} must be a string`);
  }

  const trimmed = value.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 10_000;

  if (trimmed.length < min || trimmed.length > max) {
    throw new ValidationError(`${key} must be between ${min} and ${max} characters`);
  }

  return trimmed;
}

export function optionalString(
  body: JsonObject,
  key: string,
): string | null {
  const value = body[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ValidationError(`${key} must be a string or null`);
  }
  return value.trim();
}

export function optionalObject(
  body: JsonObject,
  key: string,
): JsonValue {
  const value = body[key];
  if (value === undefined) {
    return {};
  }
  assertJsonValue(value, key);
  return value;
}

export function requiredObject(
  body: JsonObject,
  key: string,
): JsonValue {
  const value = body[key];
  if (value === undefined) {
    throw new ValidationError(`${key} is required`);
  }
  assertJsonValue(value, key);
  return value;
}

export function requiredInteger(
  body: JsonObject,
  key: string,
): number {
  const value = body[key];
  if (!Number.isInteger(value)) {
    throw new ValidationError(`${key} must be an integer`);
  }
  return value as number;
}

function assertJsonValue(value: unknown, path: string): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }

  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      assertJsonValue(nested, `${path}.${key}`);
    }
    return;
  }

  throw new ValidationError(`${path} must contain only valid JSON values`);
}
