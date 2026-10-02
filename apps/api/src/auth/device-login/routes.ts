import type { FastifyInstance, FastifyRequest } from "fastify";
import { hashSessionToken } from "@myskills-app/auth";
import { AppError } from "@myskills-app/core";
import type { AuthService } from "../service.js";
import { MemoryAuthRateLimiter, type AuthRateLimiter } from "../rate-limit.js";
import type { DeviceLoginService } from "./service.js";

export function registerDeviceLoginRoutes(app: FastifyInstance, options: {
  service?: DeviceLoginService; authService?: AuthService;
  authorization: (request: FastifyRequest) => string | undefined;
  limiter?: AuthRateLimiter;
}) {
  const limiter = options.limiter ?? new MemoryAuthRateLimiter({ maxAttempts: 20, windowMs: 60_000 });
  async function limit(request: FastifyRequest, purpose: string) {
    const result = await limiter.consume(`device:${purpose}:ip:${request.ip}`);
    if (!result.allowed) throw new AppError("Too many device login requests.", "DEVICE_RATE_LIMITED", 429, { retryAfterSeconds: result.retryAfterSeconds });
  }
  function service() {
    if (!options.service) throw new AppError("Browser login is not configured on this instance.", "DEVICE_LOGIN_UNAVAILABLE", 503);
    return options.service;
  }
  async function session(request: FastifyRequest) {
    if (!options.authService) throw new AppError("Authentication is unavailable.", "AUTH_SERVICE_UNAVAILABLE", 503);
    const authorization = options.authorization(request);
    const context = await options.authService.authenticateRequest(authorization);
    if (!context) throw new AppError("Sign in to authorize CLI access.", "AUTHENTICATION_REQUIRED", 401);
    if (context.credential.kind !== "session") throw new AppError("A browser session is required.", "SESSION_AUTH_REQUIRED", 403);
    const token = authorization?.slice(7);
    if (!token) throw new AppError("Sign in to authorize CLI access.", "AUTHENTICATION_REQUIRED", 401);
    return { user: context.user, hash: hashSessionToken(token) };
  }
  app.post("/v1/auth/device/start", async (request, reply) => {
    reply.header("cache-control", "no-store");
    await limit(request, "start");
    return service().start(body(request.body));
  });
  app.post("/v1/auth/device/poll", async (request, reply) => {
    reply.header("cache-control", "no-store");
    // Poll timing lives with the durable request, and the global ingress
    // limiter still bounds random-code traffic across replicas.
    return service().poll(body(request.body).deviceCode);
  });
  app.post("/v1/auth/device/inspect", async (request, reply) => {
    reply.header("cache-control", "no-store");
    await limit(request, "consent");
    const actor = await session(request);
    return service().inspect(body(request.body).userCode, actor.user.roles);
  });
  app.post("/v1/auth/device/decision", async (request, reply) => {
    reply.header("cache-control", "no-store");
    await limit(request, "consent");
    const actor = await session(request);
    const input = body(request.body);
    return service().decide({ userCode: input.userCode, decision: input.decision, userId: actor.user.id, sessionTokenHash: actor.hash });
  });
}
function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("A JSON object is required.", "INVALID_DEVICE_INPUT", 400);
  return value as Record<string, unknown>;
}
