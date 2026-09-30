import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError, parseSemanticVersion, parseSkillReleaseMetadata } from "@myskills-app/core";
import { MAX_PACKAGE_ARCHIVE_BYTES, MAX_PACKAGE_FILES, readPackageFilesFromZipBuffer, type PackageInputFile } from "@myskills-app/skill-package";
import { actionCredential } from "../auth/postgres-action-authority.js";
import type { AuthContext, AuthService } from "../auth/service.js";
import type { ApiTokenScope } from "../auth/types.js";
import type { SubmissionActor } from "../submissions/types.js";
import { assertRevision, assertTitle, type DraftService } from "./service.js";
import type { DraftCreateInput, DraftSourceRequest } from "./types.js";

export interface DraftRouteOptions { authService?: AuthService; draftService?: DraftService }
export interface DraftRouteHelpers {
  requestAuthorization(request: { headers: { authorization?: string | string[]; cookie?: string | string[] } }): string | undefined;
  authFailureReply(auth: AuthService, authorization: string | undefined, reply: FastifyReply): Promise<unknown>;
  requireScope(context: AuthContext, scope: ApiTokenScope): void;
  requiresMfaForRole(context: AuthContext): boolean;
}
const BODY_LIMIT = 14 * 1024 * 1024;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

export function registerDraftRoutes(app: FastifyInstance, options: DraftRouteOptions, helpers: DraftRouteHelpers) {
  const service = () => {
    if (!options.draftService) throw new AppError("Drafts are not configured.", "DRAFT_SERVICE_UNAVAILABLE", 503);
    return options.draftService;
  };
  const actor = async (request: FastifyRequest, reply: FastifyReply, write = false, extraScopes: ApiTokenScope[] = []): Promise<SubmissionActor | null> => {
    if (!options.authService) throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    const authorization = helpers.requestAuthorization(request);
    const context = await options.authService.authenticateRequest(authorization);
    if (!context) { await helpers.authFailureReply(options.authService, authorization, reply); return null; }
    for (const scope of [write ? "skills:submit" as const : "submissions:read" as const, ...extraScopes]) helpers.requireScope(context, scope);
    if (write && helpers.requiresMfaForRole(context) && !context.user.mfaVerified) throw new AppError("MFA verification is required.", "MFA_VERIFICATION_REQUIRED", 403);
    return { id: context.user.id, roles: context.user.roles, mfaVerified: context.user.mfaVerified, credential: actionCredential(context, authorization!) };
  };

  app.get("/v1/drafts", async (request, reply) => {
    const user = await actor(request, reply); if (!user) return;
    return { drafts: await service().list(user) };
  });
  app.post("/v1/drafts", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const input = createInput(request.body);
    const user = await actor(request, reply, true, input.source ? [input.source.kind === "release" ? "skills:read" : "submissions:read"] : []); if (!user) return;
    return reply.code(201).send({ draft: await service().create(user, input) });
  });
  app.post("/v1/drafts/preview", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const user = await actor(request, reply, true); if (!user) return;
    const body = object(request.body, ["files", "archive"]);
    if (("files" in body) === ("archive" in body)) throw invalid();
    let files: PackageInputFile[];
    if ("files" in body) files = fileInput(body.files);
    else {
      const archive = object(body.archive, ["filename", "contentBase64"]);
      if (archive.filename !== undefined && (typeof archive.filename !== "string" || archive.filename.length > 255)) throw invalid();
      const base64 = archive.contentBase64;
      if (typeof base64 !== "string" || !base64.length || base64.length > 4 * Math.ceil(MAX_PACKAGE_ARCHIVE_BYTES / 3)
        || base64.length % 4 !== 0 || !/^[A-Za-z\d+/]*={0,2}$/.test(base64)) throw invalid();
      const bytes = Buffer.from(base64, "base64");
      if (bytes.toString("base64") !== base64) throw invalid();
      try { files = await readPackageFilesFromZipBuffer(bytes); }
      catch (error) { throw new AppError(error instanceof Error ? error.message : "Invalid package archive.", "INVALID_PACKAGE_PAYLOAD", 400); }
    }
    return { preview: service().preview(user, files) };
  });
  app.get("/v1/drafts/:id", async (request, reply) => {
    const user = await actor(request, reply); if (!user) return;
    return { draft: await service().get(user, id(request.params)) };
  });
  app.put("/v1/drafts/:id", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const user = await actor(request, reply, true); if (!user) return;
    const body = object(request.body, ["expectedRevision", "title", "files"]);
    return { draft: await service().save(user, id(request.params), { expectedRevision: revision(body.expectedRevision), title: title(body.title), files: fileInput(body.files) }) };
  });
  app.get("/v1/drafts/:id/history", async (request, reply) => {
    const user = await actor(request, reply); if (!user) return;
    return { revisions: await service().history(user, id(request.params)) };
  });
  app.get("/v1/drafts/:id/revisions/:revision", async (request, reply) => {
    const user = await actor(request, reply); if (!user) return;
    const params = request.params as Record<string, unknown>;
    if (typeof params.revision !== "string" || !/^[1-9]\d*$/.test(params.revision)) throw invalid();
    return { draft: await service().get(user, id(params), revision(Number(params.revision))) };
  });
  app.post("/v1/drafts/:id/validate", async (request, reply) => {
    const user = await actor(request, reply, true); if (!user) return;
    const body = object(request.body, ["expectedRevision"]);
    return { validation: await service().validate(user, id(request.params), revision(body.expectedRevision)) };
  });
  app.post("/v1/drafts/:id/submit", async (request, reply) => {
    const user = await actor(request, reply, true); if (!user) return;
    const body = object(request.body, ["expectedRevision", "release"]);
    const result = await service().submit(user, id(request.params), {
      expectedRevision: revision(body.expectedRevision), ...(body.release === undefined ? {} : { release: release(body.release) }),
    });
    return reply.code(result.replayed ? 200 : 202).send({ draft: result.draft, submission: result.submission });
  });
}

function createInput(input: unknown): DraftCreateInput {
  const body = object(input, ["title", "files", "source"]);
  if (("files" in body) === ("source" in body)) throw invalid();
  if ("files" in body) return { title: title(body.title), files: fileInput(body.files) };
  const source = object(body.source, ["kind", "slug", "version", "platform", "submissionId"]);
  let parsed: DraftSourceRequest;
  if (source.kind === "release") {
    object(source, ["kind", "slug", "version", "platform"]);
    if (typeof source.slug !== "string" || source.slug.length > 128 || !/^[a-z\d]+(?:-[a-z\d]+)*$/.test(source.slug)
      || typeof source.version !== "string") throw invalid();
    if (source.version.length > 64 || !parseSemanticVersion(source.version)) throw invalid();
    if (source.platform !== undefined && (typeof source.platform !== "string" || source.platform.length > 80)) throw invalid();
    parsed = { kind: "release", slug: source.slug, version: source.version, ...(source.platform === undefined ? {} : { platform: source.platform as string }) };
  } else if (source.kind === "submission") {
    object(source, ["kind", "submissionId"]);
    if (typeof source.submissionId !== "string" || !UUID.test(source.submissionId)) throw invalid();
    parsed = { kind: "submission", submissionId: source.submissionId };
  } else throw invalid();
  return { source: parsed, ...(body.title === undefined ? {} : { title: title(body.title) }) };
}
function fileInput(input: unknown): PackageInputFile[] {
  if (!Array.isArray(input)) throw invalid();
  if (input.length > MAX_PACKAGE_FILES) throw new AppError("Package contains too many files.", "INVALID_PACKAGE_PAYLOAD", 400);
  return input.map((item) => {
    const file = object(item, ["path", "content"]);
    if (typeof file.path !== "string" || typeof file.content !== "string") throw invalid();
    return { path: file.path, content: file.content };
  });
}
function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const result = input as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) throw invalid();
  return result;
}
function title(input: unknown): string { if (typeof input !== "string") throw invalid(); assertTitle(input); return input; }
function release(input: unknown) {
  try { return parseSkillReleaseMetadata(input); }
  catch { throw invalid(); }
}
function revision(input: unknown): number { if (typeof input !== "number") throw invalid(); assertRevision(input); return input; }
function id(params: unknown): string {
  const value = (params as Record<string, unknown>).id;
  if (typeof value !== "string" || !UUID.test(value)) throw invalid();
  return value;
}
function invalid() { return new AppError("Invalid draft input.", "INVALID_DRAFT_INPUT", 400); }
