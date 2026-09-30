import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError, taskDiscoveryLimits, type SkillRepository } from "@myskills-app/core";
import type { AuthContext, AuthService } from "../auth/service.js";
import type { ApiTokenScope } from "../auth/types.js";
import type { SubmissionService } from "../submissions/service.js";
import { discoverTask } from "./service.js";

export function registerTaskDiscoveryRoutes(app: FastifyInstance, options: { skillRepository: SkillRepository; submissionService?: SubmissionService; authService?: AuthService }, helpers: { requestAuthorization(request: FastifyRequest): string | undefined; requireScope(context: AuthContext, scope: ApiTokenScope): void }) {
  app.post("/v1/skills/discover", { bodyLimit: 20 * 1024 }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const parsed = z.object({ task: z.string().min(1).max(taskDiscoveryLimits.taskCharacters).refine(v => Boolean(v.trim())), limit: z.number().int().min(1).max(taskDiscoveryLimits.results).optional() }).strict().safeParse(request.body);
    if (!parsed.success) throw new AppError("Use a task of 1–4,000 characters and a limit of 1–20.", "INVALID_TASK_DISCOVERY_INPUT", 400);
    if (!options.submissionService) throw new AppError("Submission service is not configured.", "SUBMISSION_SERVICE_UNAVAILABLE", 503);
    return discoverTask(parsed.data, {
      repository: options.skillRepository,
      readRelease: input => options.submissionService!.getPublicRelease(input),
      readActor: async () => {
        const header = helpers.requestAuthorization(request);
        if (!header) return null;
        const context = await options.authService?.authenticateRequest(header);
        if (!context) throw new AppError("Authentication is required.", "AUTHENTICATION_REQUIRED", 401);
        helpers.requireScope(context, "skills:read");
        return context.user.id;
      },
    });
  });
}
