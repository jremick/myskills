import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "@myskills-app/core";
import type { AuthService, AuthContext } from "../auth/service.js";
import type { ApiTokenScope } from "../auth/types.js";
import type { BundleService } from "./service.js";

const identifier = z.string().uuid();
const memberSlug = z
  .string()
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
const plain = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s));
const fields = {
  kind: z.enum(["curated", "source"]),
  name: plain(120),
  purpose: plain(2000),
  owner: z.discriminatedUnion("type", [
    z.object({ type: z.literal("user") }).strict(),
    z.object({ type: z.literal("team"), id: identifier }).strict(),
  ]),
  visibility: z.enum(["public", "authenticated", "team", "private"]),
  memberSlugs: z
    .array(memberSlug)
    .min(1)
    .max(200)
    .refine((a) => new Set(a).size === a.length),
  sourceEntryId: identifier.optional(),
};
const createSchema = z.object(fields).strict();
const updateSchema = z
  .object({ ...fields, expectedRevision: z.number().int().positive() })
  .strict();
const pageSchema = z
  .object({
    query: z.string().max(200).optional(),
    cursor: z.string().max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const catalogSchema = pageSchema.extend({
  view: z.enum(["grouped", "list", "outline"]).optional(),
});
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError(
      "Request fields are invalid.",
      "INVALID_REQUEST_BODY",
      400,
    );
  return result.data;
}
interface Helpers {
  requestAuthorization(request: FastifyRequest): string | undefined;
  readActor(
    auth: AuthService | undefined,
    authorization: string | undefined,
  ): Promise<{ id: string } | null>;
  requireScope(context: AuthContext, scope: ApiTokenScope): void;
  requiresMfaForRole(context: AuthContext): boolean;
}
export function registerBundleRoutes(
  app: FastifyInstance,
  options: {
    authService?: AuthService;
    bundleService?: BundleService;
    bundlesEnabled?: boolean;
  },
  helpers: Helpers,
) {
  const service = () => {
    if (options.bundlesEnabled === false)
      throw new AppError("Bundles are disabled.", "BUNDLES_DISABLED", 404);
    if (!options.bundleService)
      throw new AppError(
        "Bundles are unavailable on this server.",
        "BUNDLE_SERVICE_UNAVAILABLE",
        503,
      );
    return options.bundleService;
  };
  const read = async (request: FastifyRequest) =>
    (
      await helpers.readActor(
        options.authService,
        helpers.requestAuthorization(request),
      )
    )?.id ?? null;
  const actor = async (
    request: FastifyRequest,
    scopes: ApiTokenScope[],
    mfa = false,
  ) => {
    const context = await options.authService?.authenticateRequest(
      helpers.requestAuthorization(request),
    );
    if (!context)
      throw new AppError(
        "Sign in to continue.",
        "AUTHENTICATION_REQUIRED",
        401,
      );
    for (const scope of scopes) helpers.requireScope(context, scope);
    if (mfa && helpers.requiresMfaForRole(context) && !context.user.mfaVerified)
      throw new AppError(
        "MFA verification is required.",
        "MFA_VERIFICATION_REQUIRED",
        403,
      );
    return {
      id: context.user.id,
      roles: context.user.roles,
      mfaVerified: context.user.mfaVerified,
    };
  };
  const id = (request: FastifyRequest) =>
    parse(z.object({ id: identifier }), request.params).id;
  const catalog = async (request: FastifyRequest) =>
    service().catalog(await read(request), parse(catalogSchema, request.query));
  app.get("/v1/registry/catalog", catalog);
  app.get("/v1/bundles", catalog);
  app.get("/v1/bundle-sources", async (request) =>
    service().sources(await actor(request, ["skills:read", "libraries:read"])),
  );
  app.get("/v1/bundles/:id", async (request) =>
    service().get(id(request), await read(request)),
  );
  app.get("/v1/bundles/:id/members", async (request) =>
    service().members(
      id(request),
      await read(request),
      parse(pageSchema, request.query),
    ),
  );
  app.get("/v1/skills/:slug/bundles", async (request) =>
    service().memberships(
      parse(z.object({ slug: memberSlug }), request.params).slug,
      await read(request),
    ),
  );
  app.post("/v1/bundles", async (request, reply) => {
    const author = await actor(request, ["skills:submit", "skills:read"], true);
    const input = parse(createSchema, request.body);
    validateIdentity(input);
    if (input.kind === "source") await actor(request, ["libraries:read"]);
    return reply.code(201).send(await service().write(author, input));
  });
  app.patch("/v1/bundles/:id", async (request) => {
    const author = await actor(request, ["skills:submit", "skills:read"], true);
    const input = parse(updateSchema, request.body);
    validateIdentity(input);
    if (input.kind === "source") await actor(request, ["libraries:read"]);
    return service().write(author, input, id(request), input.expectedRevision);
  });
  app.post("/v1/bundles/:id/library-references", async (request, reply) => {
    const user = await actor(request, ["skills:read", "libraries:write"]);
    const input = parse(
      z
        .object({
          libraryId: identifier,
          expectedRevision: z.number().int().positive(),
        })
        .strict(),
      request.body,
    );
    const result = await service().save(id(request), user, input);
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
}
function validateIdentity(input: z.infer<typeof createSchema>) {
  if (
    (input.kind === "source") !== Boolean(input.sourceEntryId) ||
    (input.visibility === "team" && input.owner.type !== "team")
  )
    throw new AppError(
      "Choose the source and owner appropriate to this bundle.",
      "INVALID_REQUEST_BODY",
      400,
    );
}
