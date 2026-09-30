import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "@myskills-app/core";
import type { AuthService } from "../auth/service.js";
import { actionCredential } from "../auth/postgres-action-authority.js";
import type { ApiTokenScope } from "../auth/types.js";
import type { EvaluationService } from "./service.js";

export function registerEvaluationRoutes(app: FastifyInstance, deps: { evaluationService?: EvaluationService; authService?: AuthService; requestAuthorization(request: FastifyRequest): string | undefined }) {
  const service = () => { if (!deps.evaluationService) throw new AppError("Evaluations are not configured.", "EVALUATION_SERVICE_UNAVAILABLE", 503); return deps.evaluationService; };
  const actor = async (request: FastifyRequest, scope: ApiTokenScope, optional = false) => {
    const header = deps.requestAuthorization(request);
    if (!header && optional) return null;
    const context = await deps.authService?.authenticateRequest(header);
    if (!context || !header) throw new AppError("Authentication is required.", "AUTHENTICATION_REQUIRED", 401);
    if (context.credential.kind !== "session" && !context.credential.scopes.includes(scope)) throw new AppError("API token scope is required.", "API_TOKEN_SCOPE_REQUIRED", 403, { scope });
    return { id: context.user.id, roles: context.user.roles, mfaVerified: context.user.mfaVerified, credential: actionCredential(context, header) };
  };
  const params = (request: FastifyRequest) => {
    const parsed = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), version: z.string().min(1).max(64) }).safeParse(request.params);
    if (!parsed.success) throw new AppError("Invalid evaluation resource.", "INVALID_EVALUATION_REQUEST", 400);
    return parsed.data;
  };
  app.post("/v1/evaluations/releases/:slug/:version/runs", { bodyLimit: 4096 }, async (request, reply) => {
    const body = z.object({ artifactSha256: z.string().regex(/^[a-f0-9]{64}$/), suiteRevisionId: z.string().uuid(), platform: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/), idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/), disclosure: z.enum(["private", "public-summary"]).optional() }).strict().safeParse(request.body);
    if (!body.success) throw new AppError("Invalid evaluation request.", "INVALID_EVALUATION_REQUEST", 400);
    const user = await actor(request, "improvements:run");
    const result = await service().create(user!, { ...params(request), ...body.data });
    return reply.code(result.created ? 201 : 200).send(result);
  });
  app.get("/v1/evaluations/releases/:slug/:version/runs", async request => {
    const p = params(request); return { runs: await service().list(await actor(request, "improvements:read"), p.slug, p.version) };
  });
  app.get("/v1/evaluations/releases/:slug/:version/summary", async request => {
    const p = params(request); return { runs: await service().list(await actor(request, "improvements:read", true), p.slug, p.version, true) };
  });
}
