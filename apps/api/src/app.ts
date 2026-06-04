import Fastify, { type FastifyInstance } from "fastify";
import type { SkillRepository } from "@ai-skills-share/core";

export interface BuildAppOptions {
  skillRepository: SkillRepository;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get("/health", async () => ({
    ok: true,
    service: "ai-skills-share-api",
  }));

  app.get("/v1/skills", async (request) => {
    const query = parseQuery(request.query);
    const skills = await options.skillRepository.searchVisibleSkills({
      query: query.q,
      limit: query.limit,
    });
    return { skills };
  });

  app.get("/v1/me", async (_request, reply) => {
    return reply.code(401).send({
      error: {
        code: "AUTHENTICATION_REQUIRED",
        message: "Authentication is required.",
      },
    });
  });

  return app;
}

function parseQuery(input: unknown): { q?: string; limit?: number } {
  const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const q = typeof params.q === "string" ? params.q : undefined;
  const rawLimit = typeof params.limit === "string" ? Number.parseInt(params.limit, 10) : undefined;
  const limit = rawLimit && Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : undefined;
  return { q, limit };
}

