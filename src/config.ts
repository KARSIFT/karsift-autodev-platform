export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly publicBaseUrl: string;
  readonly internalApiToken: string;
  readonly internalServiceId: string;
  readonly founderApiToken: string;
  readonly founderInterfaceApiToken: string;
  readonly founderId: string;
  readonly databaseUrl: string;
}

function requiredEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CONTROL_PLANE_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function requireStrongToken(env: NodeJS.ProcessEnv, name: string): string {
  const token = requiredEnv(env, name);
  if (token.length < 32) {
    throw new Error(`${name} must be at least 32 characters`);
  }
  return token;
}

function parsePublicBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || "http://127.0.0.1:8080";
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "CONTROL_PLANE_PUBLIC_BASE_URL must not contain credentials, query, or fragment",
    );
  }
  return url.toString().replace(/\/$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const internalApiToken = requireStrongToken(env, "CONTROL_PLANE_API_TOKEN");
  const founderApiToken = requireStrongToken(
    env,
    "CONTROL_PLANE_FOUNDER_API_TOKEN",
  );
  const founderInterfaceApiToken = requireStrongToken(
    env,
    "CONTROL_PLANE_FOUNDER_INTERFACE_API_TOKEN",
  );

  const tokens = new Set([
    internalApiToken,
    founderApiToken,
    founderInterfaceApiToken,
  ]);
  if (tokens.size !== 3) {
    throw new Error("Control Plane bearer tokens must all be distinct");
  }

  return {
    host: env.CONTROL_PLANE_HOST?.trim() || "127.0.0.1",
    port: parsePort(env.CONTROL_PLANE_PORT),
    publicBaseUrl: parsePublicBaseUrl(env.CONTROL_PLANE_PUBLIC_BASE_URL),
    internalApiToken,
    internalServiceId:
      env.CONTROL_PLANE_SERVICE_ID?.trim() || "karsift-control-plane",
    founderApiToken,
    founderInterfaceApiToken,
    founderId: env.CONTROL_PLANE_FOUNDER_ID?.trim() || "founder",
    databaseUrl: requiredEnv(env, "DATABASE_URL"),
  };
}
