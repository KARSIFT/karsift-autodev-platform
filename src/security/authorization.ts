import type { AuthPrincipal } from "./auth.js";

export function isFounderInterfaceRouteAllowed(
  actor: AuthPrincipal,
  method: string,
  pathname: string,
): boolean {
  if (actor.credentialKind !== "FOUNDER_INTERFACE") {
    return true;
  }

  if (method === "GET" && pathname === "/v1/status") {
    return true;
  }

  if (
    method === "GET" &&
    /^\/v1\/projects\/[^/]+\/status$/.test(pathname)
  ) {
    return true;
  }

  if (
    method === "POST" &&
    /^\/v1\/projects\/[^/]+\/requests$/.test(pathname)
  ) {
    return true;
  }

  return false;
}
