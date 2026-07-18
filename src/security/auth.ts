import { timingSafeEqual } from "node:crypto";

export interface AuthPrincipal {
  readonly type: "FOUNDER" | "SYSTEM";
  readonly id: string;
}

export interface AuthCredentials {
  readonly internalApiToken: string;
  readonly internalServiceId: string;
  readonly founderApiToken: string;
  readonly founderId: string;
}

export function parseBearerToken(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }

  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1] ?? null;
}

export function secureTokenEquals(
  presented: string | null,
  expected: string,
): boolean {
  if (presented === null) {
    return false;
  }

  const presentedBuffer = Buffer.from(presented, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (presentedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(presentedBuffer, expectedBuffer);
}

export function authenticateBearerToken(
  header: string | undefined,
  credentials: AuthCredentials,
): AuthPrincipal | null {
  const token = parseBearerToken(header);

  if (secureTokenEquals(token, credentials.founderApiToken)) {
    return { type: "FOUNDER", id: credentials.founderId };
  }

  if (secureTokenEquals(token, credentials.internalApiToken)) {
    return { type: "SYSTEM", id: credentials.internalServiceId };
  }

  return null;
}
