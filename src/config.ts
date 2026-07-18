export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly internalApiToken: string;
  readonly internalServiceId: string;
  readonly founderApiToken: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const internalApiToken = requireStrongToken(env, "CONTROL_PLANE_API_TOKEN");
  const founderApiToken = requireStrongToken(
    env,
    "CONTROL_PLANE_FOUNDER_API_TOKEN",
  );

  if (internalApiToken === founderApiToken) {
    throw new Error(
      "CONTROL_PLANE_API_TOKEN and CONTROL_PLANE_FOUNDER_API_TOKEN must differ",
    );
  }

  return {
    host: env.CONTROL_PLANE_HOST?.trim() || "127.0.0.1",
    port: parsePort(env.CONTROL_PLANE_PORT),
    internalApiToken,
    internalServiceId:
      env.CONTROL_PLANE_SERVICE_ID?.trim() || "karsift-control-plane",
    founderApiToken,
    founderId: env.CONTROL_PLANE_FOUNDER_ID?.trim() || "founder",
    databaseUrl: requiredEnv(env, "DATABASE_URL"),
  };
}
