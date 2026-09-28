import { AppError } from "@myskills-app/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthService } from "../auth/service.js";
import type { GithubIntegrationService } from "./service.js";

export function registerGithubRoutes(
  app: FastifyInstance,
  services: { authService?: AuthService; githubService?: GithubIntegrationService },
  helpers: {
    requestAuthorization: (request: FastifyRequest) => string | undefined;
    authFailureReply: (auth: AuthService, authorization: string | undefined, reply: FastifyReply) => Promise<unknown>;
  },
): void {
  async function context(request: FastifyRequest, reply: FastifyReply) {
    reply.header("cache-control", "no-store");
    reply.header("referrer-policy", "no-referrer");
    if (!services.authService || !services.githubService) throw new AppError("GitHub integration is not configured.", "GITHUB_NOT_CONFIGURED", 503);
    const authorization = helpers.requestAuthorization(request);
    const actor = await services.authService.authenticateSessionAuthorizationHeader(authorization);
    if (!actor) { await helpers.authFailureReply(services.authService, authorization, reply); return null; }
    return { actor, sessionToken: authorization!.replace(/^Bearer\s+/i, ""), github: services.githubService };
  }
  app.get("/v1/account/github", async (request, reply) => {
    const ctx = await context(request, reply);
    if (ctx) return { github: await ctx.github.getAccount(ctx.actor) };
  });
  app.post("/v1/account/github/connect", async (request, reply) => {
    const ctx = await context(request, reply);
    if (ctx) return ctx.github.connect(ctx.actor, ctx.sessionToken);
  });
  app.get("/v1/account/github/callback", async (request, reply) => {
    const ctx = await context(request, reply);
    if (!ctx) return;
    const query = request.query as Record<string, unknown>;
    return reply.redirect(await ctx.github.callback(ctx.actor, ctx.sessionToken, {
      state: typeof query.state === "string" ? query.state : "",
      code: typeof query.code === "string" ? query.code : undefined,
      error: typeof query.error === "string" ? query.error : undefined,
    }));
  });
  app.delete("/v1/account/github", async (request, reply) => {
    const ctx = await context(request, reply);
    if (ctx) return { github: await ctx.github.disconnect(ctx.actor) };
  });
  app.get("/v1/admin/github", async (request, reply) => {
    const ctx = await context(request, reply);
    if (ctx) return { github: await ctx.github.getAdmin(ctx.actor) };
  });
  app.put("/v1/admin/github", async (request, reply) => {
    const ctx = await context(request, reply);
    if (ctx) return { github: await ctx.github.updateAdmin(ctx.actor, request.body) };
  });
  app.post("/v1/admin/github/test", async (request, reply) => {
    const ctx = await context(request, reply);
    if (ctx) return { github: await ctx.github.testAdmin(ctx.actor) };
  });
}
