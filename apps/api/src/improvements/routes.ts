import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "@myskills-app/core";
import type { AuthService } from "../auth/service.js";
import type { ApiTokenScope } from "../auth/types.js";
import type { ImprovementService } from "./service.js";
import type { ImprovementActor, ImprovementDocumentKind } from "./types.js";

export interface ImprovementRouteDependencies {
  authService?: AuthService;
  improvementService?: ImprovementService;
  /** The app's bearer-or-session-cookie resolver, so cookie sessions keep the existing CSRF guard. */
  requestAuthorization: (request: FastifyRequest) => string | undefined;
}

type Params = Record<string, string>;

/** Registers /v1/improvements. Sessions carry every scope; API tokens need the named scope. */
export function registerImprovementRoutes(app: FastifyInstance, deps: ImprovementRouteDependencies): void {
  const service = () => {
    if (!deps.improvementService) throw new AppError("Skill improvement service is not configured.", "IMPROVEMENT_SERVICE_UNAVAILABLE", 503);
    return deps.improvementService;
  };
  const actor = (request: FastifyRequest, scope: ApiTokenScope) => authenticate(deps, request, scope);

  app.get("/v1/improvements/releases/:slug/:version/compatibility", async (request) => {
    const improvements = service();
    const params = request.params as Params;
    const viewer = await optionalActor(deps, request, "improvements:read");
    return { compatibility: await improvements.getCompatibility(viewer, params.slug ?? "", params.version ?? "") };
  });

  app.post("/v1/improvements/releases/:slug/:version/declarations", async (request, reply) => {
    const improvements = service();
    const params = request.params as Params;
    const result = await improvements.appendDeclaration(await actor(request, "skills:submit"), params.slug ?? "", params.version ?? "", request.body);
    return reply.code(result.created ? 201 : 200).send(result);
  });

  app.post("/v1/improvements/releases/:slug/:version/declarations/:revisionId/review", async (request) => {
    const improvements = service();
    const params = request.params as Params;
    return improvements.reviewDeclaration(await actor(request, "review:write"), params.slug ?? "", params.version ?? "", params.revisionId ?? "", request.body);
  });

  app.get("/v1/improvements/policies/:scopeType/:scopeId", async (request) => {
    const improvements = service();
    const params = request.params as Params;
    return improvements.getPolicy(await actor(request, "improvements:read"), params.scopeType ?? "", params.scopeId ?? "");
  });

  app.put("/v1/improvements/policies/:scopeType/:scopeId", async (request, reply) => {
    const improvements = service();
    const params = request.params as Params;
    const result = await improvements.putPolicy(await actor(request, "improvements:configure"), params.scopeType ?? "", params.scopeId ?? "", request.body);
    return reply.code(result.created ? 201 : 200).send(result);
  });

  for (const [kind, collection] of [["profile", "profiles"], ["suite", "suites"]] as Array<[ImprovementDocumentKind, string]>) {
    app.get(`/v1/improvements/${collection}`, async (request) => {
      const improvements = service();
      const query = (request.query ?? {}) as Record<string, unknown>;
      return { [collection]: await improvements.listDocuments(await actor(request, "improvements:read"), kind, query.ownerType, query.ownerId) };
    });

    app.post(`/v1/improvements/${collection}`, async (request, reply) => {
      const improvements = service();
      const document = await improvements.createDocument(await actor(request, "improvements:configure"), kind, request.body);
      return reply.code(201).send({ [kind]: document });
    });

    app.get(`/v1/improvements/${collection}/:id`, async (request) => {
      const improvements = service();
      const params = request.params as Params;
      return { [kind]: await improvements.getDocument(await actor(request, "improvements:read"), kind, params.id ?? "") };
    });

    app.put(`/v1/improvements/${collection}/:id`, async (request, reply) => {
      const improvements = service();
      const params = request.params as Params;
      const result = await improvements.appendDocument(await actor(request, "improvements:configure"), kind, params.id ?? "", request.body);
      return reply.code(result.created ? 201 : 200).send({ [kind]: result.document, created: result.created });
    });
  }

  app.post("/v1/improvements/plans/preview", async (request) => {
    const improvements = service();
    return improvements.previewPlan(await actor(request, "improvements:run"), request.body);
  });

  app.post("/v1/improvements/plans", async (request, reply) => {
    const improvements = service();
    const result = await improvements.createPlan(await actor(request, "improvements:run"), request.body);
    return reply.code(result.created ? 201 : 200).send(result);
  });

  app.get("/v1/improvements/plans/:id", async (request) => {
    const improvements = service();
    const params = request.params as Params;
    return improvements.getPlan(await actor(request, "improvements:read"), params.id ?? "");
  });

  app.post("/v1/improvements/plans/:id/runs", async (request, reply) => {
    const improvements = service();
    const params = request.params as Params;
    const result = await improvements.createRun(await actor(request, "improvements:run"), params.id ?? "", request.body);
    return reply.code(result.created ? 201 : 200).send(result);
  });

  app.get("/v1/improvements/runs/:id", async (request) => {
    const improvements = service();
    const params = request.params as Params;
    return improvements.getRun(await actor(request, "improvements:read"), params.id ?? "");
  });

  app.post("/v1/improvements/runs/:id/events", async (request, reply) => {
    const improvements = service();
    const params = request.params as Params;
    const { status, ...result } = await improvements.appendRunEvent(await actor(request, "improvements:run"), params.id ?? "", request.body);
    return reply.code(status).send(result);
  });

  app.post("/v1/improvements/runs/:id/cancel", async (request) => {
    const improvements = service();
    const params = request.params as Params;
    return improvements.cancelRun(await actor(request, "improvements:run"), params.id ?? "", request.body);
  });

  app.post("/v1/improvements/runs/:id/evidence", async (request, reply) => {
    const improvements = service();
    const params = request.params as Params;
    const result = await improvements.shareEvidence(await actor(request, "improvements:report"), params.id ?? "", request.body);
    return reply.code(result.created ? 201 : 200).send(result);
  });

  app.get("/v1/improvements/evidence/:id", async (request) => {
    const improvements = service();
    const params = request.params as Params;
    return improvements.getEvidence(await actor(request, "improvements:read"), params.id ?? "");
  });

  app.post("/v1/improvements/evidence/:id/acceptances", async (request, reply) => {
    const improvements = service();
    const params = request.params as Params;
    const result = await improvements.decideEvidence(await actor(request, "improvements:report"), params.id ?? "", request.body);
    return reply.code(201).send(result);
  });
}

async function authenticate(deps: ImprovementRouteDependencies, request: FastifyRequest, scope: ApiTokenScope): Promise<ImprovementActor> {
  if (!deps.authService) throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
  const context = await deps.authService.authenticateRequest(deps.requestAuthorization(request));
  if (!context) throw new AppError("Authentication is required.", "AUTHENTICATION_REQUIRED", 401);
  if (context.credential.kind === "api_token" && !context.credential.scopes.includes(scope)) {
    throw new AppError("API token scope is required.", "API_TOKEN_SCOPE_REQUIRED", 403, { scope });
  }
  return {
    id: context.user.id,
    email: context.user.email,
    name: context.user.name,
    roles: context.user.roles,
    mfaVerified: context.user.mfaVerified,
  };
}

/** Anonymous reads are allowed; a presented but unusable credential reads anonymously, matching registry reads. */
async function optionalActor(deps: ImprovementRouteDependencies, request: FastifyRequest, scope: ApiTokenScope): Promise<ImprovementActor | null> {
  const authorization = deps.requestAuthorization(request);
  if (!deps.authService || !authorization) return null;
  const context = await deps.authService.authenticateRequest(authorization);
  if (!context) return null;
  if (context.credential.kind === "api_token" && !context.credential.scopes.includes(scope)) {
    throw new AppError("API token scope is required.", "API_TOKEN_SCOPE_REQUIRED", 403, { scope });
  }
  return {
    id: context.user.id,
    email: context.user.email,
    name: context.user.name,
    roles: context.user.roles,
    mfaVerified: context.user.mfaVerified,
  };
}
