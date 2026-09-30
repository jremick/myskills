import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hashSessionToken } from "@myskills-app/auth";
import { AppError } from "@myskills-app/core";
import type { AuthService } from "../auth/service.js";
import { authenticateApplicationUser } from "../auth/delegated-actions.js";
import { MemoryAuthRateLimiter, type AuthRateLimiter } from "../auth/rate-limit.js";
import { ACCESS_TOKEN_PREFIX } from "./tokens.js";
import { OAuthProtocolError, type OAuthParams, type OAuthService } from "./service.js";

const FORM_BODY_LIMIT_BYTES = 16 * 1024;
const REGISTRATION_BODY_LIMIT_BYTES = 8 * 1024;
const CONSENT_BODY_LIMIT_BYTES = 4 * 1024;
const METADATA_CACHE_CONTROL = "public, max-age=300";

/**
 * True when the effective credential is a connector access token. Parsing
 * mirrors AuthService's bearer extraction (the "bearer" scheme, then ASCII
 * whitespace 0x09-0x0d or 0x20 on either side of the value) without its length
 * limits, so every value that service could accept as a connector token is
 * recognized here.
 */
export function isConnectorBearer(authorization: string | undefined): boolean {
  if (typeof authorization !== "string" || authorization.length < 7) return false;
  if (authorization.slice(0, 6).toLowerCase() !== "bearer" || !isAsciiWhitespace(authorization.charCodeAt(6))) return false;
  let start = 6;
  while (start < authorization.length && isAsciiWhitespace(authorization.charCodeAt(start))) start += 1;
  return authorization.startsWith(ACCESS_TOKEN_PREFIX, start);
}

function isAsciiWhitespace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

export interface OAuthRouteLimiters {
  register?: AuthRateLimiter;
  authorize?: AuthRateLimiter;
  token?: AuthRateLimiter;
}

export function registerOAuthRoutes(
  app: FastifyInstance,
  options: { authService?: AuthService; oauthService?: OAuthService; oauthLimiters?: OAuthRouteLimiters },
  helpers: {
    requestAuthorization(request: FastifyRequest): string | undefined;
    authFailureReply(authService: AuthService, authorization: string | undefined, reply: FastifyReply): Promise<unknown>;
  },
): void {
  const service = options.oauthService;

  // Always present so the account UI can show an honest unavailable state.
  app.get("/v1/oauth/connector", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { connector: service ? service.connectorInfo() : { enabled: false, mcpUrl: null } };
  });

  if (!service || !options.authService) return;
  const authService = options.authService;
  const limiters = {
    register: options.oauthLimiters?.register ?? new MemoryAuthRateLimiter({ maxAttempts: 20, windowMs: 60 * 60 * 1000 }),
    authorize: options.oauthLimiters?.authorize ?? new MemoryAuthRateLimiter({ maxAttempts: 60, windowMs: 60 * 1000 }),
    token: options.oauthLimiters?.token ?? new MemoryAuthRateLimiter({ maxAttempts: 120, windowMs: 60 * 1000 }),
  };

  app.get("/.well-known/oauth-authorization-server", async (_request, reply) => {
    reply.header("cache-control", METADATA_CACHE_CONTROL);
    return service.metadata();
  });

  app.get("/oauth/authorize", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const limited = await limiters.authorize.consume(`oauth:authorize:ip:${request.ip}`);
    if (!limited.allowed) {
      return reply.redirect(`${service.config.consentOrigin}/connect/authorize?error=rate_limited`, 302);
    }
    return reply.redirect(await service.authorize(request.query as OAuthParams), 302);
  });

  if (service.config.dynamicRegistration) {
    app.post("/oauth/register", { bodyLimit: REGISTRATION_BODY_LIMIT_BYTES }, async (request, reply) => {
      reply.header("cache-control", "no-store");
      const limited = await limiters.register.consume(`oauth:register:ip:${request.ip}`);
      if (!limited.allowed) {
        return protocolError(reply.header("retry-after", String(limited.retryAfterSeconds)), new OAuthProtocolError("temporarily_unavailable", "Too many client registrations. Try again later.", 429));
      }
      try {
        return reply.code(201).send(await service.registerClient(request.body));
      } catch (error) {
        if (error instanceof OAuthProtocolError) return protocolError(reply, error);
        throw error;
      }
    });
  }

  // Form-encoded token and revocation endpoints live in their own
  // encapsulated scope: registering the form parser here does not make any
  // other JSON route accept cross-site form posts.
  void app.register(async (scope) => {
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: FORM_BODY_LIMIT_BYTES }, (_request, body, done) => {
      const params: Record<string, string | string[]> = {};
      for (const [key, value] of new URLSearchParams(body as string)) {
        const existing = params[key];
        params[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
      }
      done(null, params);
    });

    const formEndpoint = (handler: (params: OAuthParams, authorization: string | undefined) => Promise<Record<string, unknown> | void>) => async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header("cache-control", "no-store").header("pragma", "no-cache");
      const limited = await limiters.token.consume(`oauth:token:ip:${request.ip}`);
      if (!limited.allowed) {
        return protocolError(reply.header("retry-after", String(limited.retryAfterSeconds)), new OAuthProtocolError("temporarily_unavailable", "Too many requests. Try again later.", 429));
      }
      if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded") || !request.body || typeof request.body !== "object") {
        return protocolError(reply, new OAuthProtocolError("invalid_request", "Use an application/x-www-form-urlencoded request body."));
      }
      try {
        const result = await handler(request.body as OAuthParams, firstHeader(request.headers.authorization));
        return reply.code(200).send(result ?? {});
      } catch (error) {
        if (error instanceof OAuthProtocolError) return protocolError(reply, error);
        throw error;
      }
    };
    scope.post("/oauth/token", formEndpoint((params, authorization) => service.token(params, authorization)));
    scope.post("/oauth/revoke", formEndpoint((params, authorization) => service.revoke(params, authorization)));
  });

  const sessionUser = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "no-store");
    const authorization = helpers.requestAuthorization(request);
    const user = await authService.authenticateSessionAuthorizationHeader(authorization);
    if (!user) await helpers.authFailureReply(authService, authorization, reply);
    return user;
  };

  app.post("/v1/oauth/consent/inspect", { bodyLimit: CONSENT_BODY_LIMIT_BYTES }, async (request, reply) => {
    const user = await sessionUser(request, reply);
    if (!user) return reply;
    const sessionToken = (helpers.requestAuthorization(request) ?? "").replace(/^bearer\s+/i, "").trim();
    return { authorization: await service.inspect(user, bodyField(request.body, "request"), hashSessionToken(sessionToken)) };
  });

  app.post("/v1/oauth/consent/decision", { bodyLimit: CONSENT_BODY_LIMIT_BYTES }, async (request, reply) => {
    const user = await sessionUser(request, reply);
    if (!user) return reply;
    // The session was just authenticated from this bearer or cookie value.
    const sessionToken = (helpers.requestAuthorization(request) ?? "").replace(/^bearer\s+/i, "").trim();
    return service.decide(user, hashSessionToken(sessionToken), bodyField(request.body, "request"), bodyField(request.body, "decision"));
  });

  app.get("/v1/oauth/connections", async (request, reply) => {
    const user = await authenticateApplicationUser(authService, request, helpers.requestAuthorization(request));
    if (!user) return helpers.authFailureReply(authService, helpers.requestAuthorization(request), reply);
    reply.header("cache-control", "no-store");
    return { connections: await service.listConnections(user.id) };
  });

  app.delete("/v1/oauth/connections/:id", async (request, reply) => {
    const user = await authenticateApplicationUser(authService, request, helpers.requestAuthorization(request));
    if (!user) return helpers.authFailureReply(authService, helpers.requestAuthorization(request), reply);
    reply.header("cache-control", "no-store");
    const id = (request.params as { id?: unknown }).id;
    if (typeof id !== "string") throw new AppError("Connection not found.", "OAUTH_CONNECTION_NOT_FOUND", 404);
    return { connection: await service.revokeConnection(user.id, id) };
  });
}

function protocolError(reply: FastifyReply, error: OAuthProtocolError) {
  if (error.statusCode === 401) reply.header("www-authenticate", "Basic realm=\"MySkills\"");
  return reply.code(error.statusCode).send({ error: error.error, error_description: error.description });
}

function bodyField(body: unknown, field: string): unknown {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>)[field] : undefined;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
