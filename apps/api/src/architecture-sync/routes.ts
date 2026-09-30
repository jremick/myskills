import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "@myskills-app/core";
import { ArchitecturePlanService, validateArchitecturePlanIdentifier, validateApproveArchitecturePlanInput, validateCreateArchitecturePlanInput, validatePlanHistoryLimit, type ArchitecturePlanActor } from "./plan-service.js";

export function registerArchitecturePlanRoutes(app: FastifyInstance, options: { service: ArchitecturePlanService; authenticate(request: FastifyRequest, reply: FastifyReply): Promise<ArchitecturePlanActor | null> }) {
  app.post("/v1/architecture-targets/:id/plans", async (request, reply) => {
    const actor = await options.authenticate(request, reply);
    if (!actor) return;
    const id = parameter(request.params);
    validateCreateArchitecturePlanInput(request.body);
    const result = await options.service.createPlan(actor, id, request.body);
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
  app.get("/v1/architecture-targets/:id/plans", async (request, reply) => {
    const actor = await options.authenticate(request, reply);
    if (!actor) return;
    return options.service.listPlans(actor, parameter(request.params), limit(request.query));
  });
  app.get("/v1/architecture-plans/:id", async (request, reply) => {
    const actor = await options.authenticate(request, reply);
    if (!actor) return;
    return options.service.getPlan(actor, parameter(request.params));
  });
  app.post("/v1/architecture-plans/:id/approve", async (request, reply) => {
    const actor = await options.authenticate(request, reply);
    if (!actor) return;
    const id = parameter(request.params);
    validateApproveArchitecturePlanInput(request.body);
    return options.service.approvePlan(actor, id, request.body);
  });
}
function parameter(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const id = (input as { id?: unknown }).id;
  validateArchitecturePlanIdentifier(id);
  return id;
}
function limit(input: unknown): number {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "limit")) throw invalid();
  const value = (input as { limit?: unknown }).limit;
  if (value === undefined) return 100;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,2}$/.test(value)) throw invalid();
  const result = Number(value);
  validatePlanHistoryLimit(result);
  return result;
}
function invalid() { return new AppError("Architecture plan request is invalid.", "INVALID_REQUEST_BODY", 400); }
