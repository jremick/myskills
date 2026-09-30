import { AppError, findDelegatedAction, type DelegatedAction } from "@myskills-app/core";
import type { FastifyRequest } from "fastify";
import type { AuthContext, AuthService } from "./service.js";

export function requestDelegatedAction(request: Pick<FastifyRequest, "method" | "routeOptions">): DelegatedAction | undefined {
  return findDelegatedAction(request.method, request.routeOptions.url ?? "");
}

/** Service guards still decide ownership, resource visibility, lifecycle and MFA. */
export function requireDelegatedAction(context: AuthContext, request: Pick<FastifyRequest, "method" | "routeOptions">): DelegatedAction {
  const action = requestDelegatedAction(request);
  if (!action) throw new AppError("This operation requires its trusted authentication flow.", "SESSION_AUTH_REQUIRED", 403);
  if (context.credential.kind !== "session") {
    for (const scope of action.requiredScopes) {
      if (!context.credential.scopes.includes(scope)) {
        throw new AppError("API token scope is required.", "API_TOKEN_SCOPE_REQUIRED", 403, { scope });
      }
    }
  }
  return action;
}

/** The session-only AuthService method is intentionally unchanged. */
export async function authenticateApplicationUser(auth: AuthService, request: FastifyRequest, authorization: string | undefined) {
  const context = await auth.authenticateRequest(authorization);
  if (!context) return null;
  if (context.credential.kind !== "session") requireDelegatedAction(context, request);
  return context.user;
}

export function requireConditionalDelegatedPolicy(context: AuthContext, action: DelegatedAction, body: unknown): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const input = body as Record<string, unknown>;
  if (action.id === "skills.metadata.update" && Object.prototype.hasOwnProperty.call(input, "visibility")) {
    if (context.credential.kind !== "session" && !context.credential.scopes.includes("sharing:write")) {
      throw new AppError("API token scope is required.", "API_TOKEN_SCOPE_REQUIRED", 403, { scope: "sharing:write" });
    }
    if (!context.user.mfaVerified) throw new AppError("MFA verification is required.", "MFA_VERIFICATION_REQUIRED", 403);
  }
  if ((action.id === "bundles.create" || action.id === "bundles.update") && input.kind === "source"
    && context.credential.kind !== "session" && !context.credential.scopes.includes("libraries:read")) {
    throw new AppError("API token scope is required.", "API_TOKEN_SCOPE_REQUIRED", 403, { scope: "libraries:read" });
  }
}
