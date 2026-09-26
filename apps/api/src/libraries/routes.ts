import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AppError,
  LIBRARY_LIMITS,
  libraryCandidateStates,
  libraryEventKinds,
  librarySourceRefKinds,
  libraryTrackingModes,
  parseGithubSourceUrl,
  parseSemanticVersion,
  type LibraryCandidateState,
  type LibraryEventKind,
  type LibrarySourceRef,
  type LibrarySourceRefKind,
  type LibraryTrackingMode,
} from "@myskills-app/core";
import { MemoryAuthRateLimiter, type AuthRateLimiter } from "../auth/rate-limit.js";
import type { AuthContext, AuthService } from "../auth/service.js";
import type { ApiTokenScope } from "../auth/types.js";
import type { SubmissionService } from "../submissions/service.js";
import type { MappingOverrides } from "./packaging.js";
import { decodeCursor, type LibraryActor, type LibraryService } from "./service.js";

export interface LibraryRouteOptions {
  authService?: AuthService;
  libraryService?: LibraryService;
  submissionService?: SubmissionService;
  /** Per-user bound on provider-backed source requests: add source, discover, preview, check now. */
  librarySourceLimiter?: AuthRateLimiter;
}

/** Existing app.ts auth helpers, passed in to keep one authentication path. */
export interface LibraryRouteHelpers {
  requestAuthorization(request: { headers: { authorization?: string | string[]; cookie?: string | string[] } }): string | undefined;
  authFailureReply(authService: AuthService, authorization: string | undefined, reply: FastifyReply): Promise<unknown>;
  requireScope(context: AuthContext, scope: ApiTokenScope): void;
  requiresMfaForRole(context: AuthContext): boolean;
  artifactHashHeader: string;
}

interface AuthNeed {
  scopes: ApiTokenScope[];
  sessionOnly?: boolean;
  mfa?: "always" | "privileged";
}

const READ: AuthNeed = { scopes: ["libraries:read"] };
const WRITE: AuthNeed = { scopes: ["libraries:write"] };
const ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MUTATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function registerLibraryRoutes(app: FastifyInstance, options: LibraryRouteOptions, helpers: LibraryRouteHelpers): void {
  const libraries = (): LibraryService => {
    if (!options.libraryService) throw new AppError("Libraries are not configured.", "LIBRARY_SERVICE_UNAVAILABLE", 503);
    return options.libraryService;
  };
  const submissions = (): SubmissionService => {
    if (!options.submissionService) throw new AppError("Submission service is not configured.", "SUBMISSION_SERVICE_UNAVAILABLE", 503);
    return options.submissionService;
  };
  const actorFor = async (request: FastifyRequest, reply: FastifyReply, need: AuthNeed): Promise<LibraryActor | null> => {
    const authService = options.authService;
    if (!authService) throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    const authorization = helpers.requestAuthorization(request);
    const context = await authService.authenticateRequest(authorization);
    if (!context) {
      await helpers.authFailureReply(authService, authorization, reply);
      return null;
    }
    if (need.sessionOnly && context.credential.kind !== "session") {
      await reply.code(403).send({ error: { code: "SESSION_AUTH_REQUIRED", message: "Session authentication is required." } });
      return null;
    }
    for (const scope of need.scopes) helpers.requireScope(context, scope);
    if ((need.mfa === "always" || (need.mfa === "privileged" && helpers.requiresMfaForRole(context))) && !context.user.mfaVerified) {
      throw new AppError("MFA verification is required.", "MFA_VERIFICATION_REQUIRED", 403);
    }
    return { id: context.user.id, roles: context.user.roles, mfaVerified: context.user.mfaVerified };
  };
  // Provider requests share the instance's unauthenticated GitHub budget, so one user's
  // source requests are bounded before any provider call.
  const sourceLimiter = options.librarySourceLimiter
    ?? new MemoryAuthRateLimiter({ maxAttempts: LIBRARY_LIMITS.maxSourceOperationsPerHour, windowMs: 3_600_000 });
  const allowSourceRequest = async (actor: LibraryActor, reply: FastifyReply): Promise<boolean> => {
    const result = await sourceLimiter.consume(`library:source:${actor.id}`);
    if (result.allowed) return true;
    await reply.header("retry-after", String(result.retryAfterSeconds)).code(429).send({
      error: {
        code: "LIBRARY_SOURCE_RATE_LIMITED",
        message: "Too many source requests. Try again later.",
        details: { retryAfterSeconds: result.retryAfterSeconds },
      },
    });
    return false;
  };

  // ---- Libraries ----------------------------------------------------------

  app.get("/v1/libraries", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, READ);
    if (!actor) return;
    return service.listLibraries(actor, parsePage(request.query));
  });

  app.post("/v1/libraries", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, WRITE);
    if (!actor) return;
    const body = objectBody(request.body);
    const result = await service.createLibrary(actor, {
      name: boundedText(body.name, "name", 1, 120),
      description: optionalText(body.description, "description", 2000) ?? "",
      owner: parseOwner(body.owner),
      clientMutationId: parseMutationId(body.clientMutationId),
    });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.get("/v1/libraries/:libraryId", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, READ);
    if (!actor) return;
    return service.getLibrary(actor, param(request.params, "libraryId"));
  });

  app.patch("/v1/libraries/:libraryId", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, WRITE);
    if (!actor) return;
    const body = objectBody(request.body);
    return service.updateLibrary(actor, param(request.params, "libraryId"), {
      expectedRevision: positiveInteger(body.expectedRevision, "expectedRevision"),
      ...(body.name !== undefined ? { name: boundedText(body.name, "name", 1, 120) } : {}),
      ...(body.description !== undefined ? { description: optionalText(body.description, "description", 2000) ?? "" } : {}),
    });
  });

  app.delete("/v1/libraries/:libraryId", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, WRITE);
    if (!actor) return;
    const query = queryObject(request.query);
    return service.deleteLibrary(actor, param(request.params, "libraryId"), positiveInteger(Number(query.expectedRevision), "expectedRevision"));
  });

  app.get("/v1/libraries/:libraryId/entries", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, READ);
    if (!actor) return;
    const query = queryObject(request.query);
    const kind = query.kind === "source" || query.kind === "skill" ? query.kind : undefined;
    if (query.kind !== undefined && !kind) throw invalid("kind must be source or skill.");
    return service.listEntries(actor, param(request.params, "libraryId"), { ...parsePage(request.query), ...(kind ? { kind } : {}) });
  });

  app.post("/v1/libraries/:libraryId/entries", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, WRITE);
    if (!actor) return;
    const body = objectBody(request.body);
    const clientMutationId = parseMutationId(body.clientMutationId);
    const libraryId = param(request.params, "libraryId");
    if (body.kind === "source") {
      const input = {
        kind: "source" as const,
        url: boundedText(body.url, "url", 1, 2000),
        ...(body.ref !== undefined ? { ref: parseRef(body.ref) } : {}),
        ...(body.path !== undefined ? { path: optionalText(body.path, "path", 1024) ?? "" } : {}),
        clientMutationId,
      };
      // Unsupported URLs are refused before any provider request and do not spend the budget.
      if (parseGithubSourceUrl(input.url).ok && !await allowSourceRequest(actor, reply)) return;
      const result = await service.createEntry(actor, libraryId, input);
      return reply.code(result.replayed ? 200 : 201).send(result);
    }
    if (body.kind !== "skill") throw invalid("kind must be source or skill.");
    const result = await service.createEntry(actor, libraryId, { kind: "skill", slug: boundedText(body.slug, "slug", 1, 64), clientMutationId });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.put("/v1/libraries/:libraryId/subscription", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, WRITE);
    if (!actor) return;
    const body = request.body === undefined || request.body === null ? {} : objectBody(request.body);
    return service.subscribe(actor, param(request.params, "libraryId"), { events: body.events === undefined ? null : parseEventKinds(body.events) });
  });

  app.delete("/v1/libraries/:libraryId/subscription", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, WRITE);
    if (!actor) return;
    return service.unsubscribe(actor, param(request.params, "libraryId"));
  });

  // ---- Entries ------------------------------------------------------------

  app.get("/v1/library-entries/:entryId", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, READ);
    if (!actor) return;
    return service.getEntry(actor, param(request.params, "entryId"));
  });

  app.delete("/v1/library-entries/:entryId", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, WRITE);
    if (!actor) return;
    return service.removeEntry(actor, param(request.params, "entryId"));
  });

  app.patch("/v1/library-entries/:entryId/tracking", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, WRITE);
    if (!actor) return;
    const body = objectBody(request.body);
    if (typeof body.mode !== "string" || !(libraryTrackingModes as readonly string[]).includes(body.mode)) {
      throw invalid(`mode must be one of: ${libraryTrackingModes.join(", ")}.`);
    }
    return service.updateTracking(actor, param(request.params, "entryId"), {
      expectedRevision: positiveInteger(body.expectedRevision, "expectedRevision"),
      mode: body.mode as LibraryTrackingMode,
      acknowledgeIdentityChange: optionalBoolean(body.acknowledgeIdentityChange, "acknowledgeIdentityChange") ?? false,
    });
  });

  app.post("/v1/library-entries/:entryId/checks", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, WRITE);
    if (!actor) return;
    const entryId = param(request.params, "entryId");
    if (!await allowSourceRequest(actor, reply)) return;
    return service.checkNow(actor, entryId);
  });

  app.post("/v1/library-entries/:entryId/discoveries", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, WRITE);
    if (!actor) return;
    const entryId = param(request.params, "entryId");
    if (!await allowSourceRequest(actor, reply)) return;
    return service.discover(actor, entryId);
  });

  app.post("/v1/library-entries/:entryId/previews", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, WRITE);
    if (!actor) return;
    const body = objectBody(request.body);
    if (!Array.isArray(body.paths) || body.paths.some((path) => typeof path !== "string")) throw invalid("paths must be an array of strings.");
    const entryId = param(request.params, "entryId");
    const input = {
      snapshotId: boundedText(body.snapshotId, "snapshotId", 1, 128),
      paths: body.paths as string[],
      mappings: parseMappings(body.mappings),
    };
    if (!await allowSourceRequest(actor, reply)) return;
    return service.preview(actor, entryId, input);
  });

  app.get("/v1/library-entries/:entryId/candidates", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, READ);
    if (!actor) return;
    const query = queryObject(request.query);
    if (query.state !== undefined && !(libraryCandidateStates as readonly string[]).includes(String(query.state))) {
      throw invalid(`state must be one of: ${libraryCandidateStates.join(", ")}.`);
    }
    return service.listCandidates(actor, param(request.params, "entryId"), {
      ...parsePage(request.query),
      ...(query.state !== undefined ? { state: query.state as LibraryCandidateState } : {}),
    });
  });

  app.post("/v1/library-entries/:entryId/adoptions", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, WRITE);
    if (!actor) return;
    const body = objectBody(request.body);
    if (!("expectedCurrentAdoptionId" in body)) throw invalid("expectedCurrentAdoptionId is required (null for the first adoption).");
    const version = boundedText(body.version, "version", 1, 128);
    if (!parseSemanticVersion(version)) throw invalid("version must be a semantic version.");
    const result = await service.adopt(actor, param(request.params, "entryId"), {
      version,
      artifactSha256: sha256(body.artifactSha256, "artifactSha256"),
      expectedCurrentAdoptionId: body.expectedCurrentAdoptionId === null ? null : boundedText(body.expectedCurrentAdoptionId, "expectedCurrentAdoptionId", 1, 128),
      reason: optionalText(body.reason, "reason", 500) ?? "",
    });
    return reply.code(201).send(result);
  });

  app.get("/v1/library-entries/:entryId/adoptions", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, READ);
    if (!actor) return;
    return service.listAdoptions(actor, param(request.params, "entryId"));
  });

  app.get("/v1/library-entries/:entryId/resolution", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, READ);
    if (!actor) return;
    return service.resolveEntry(actor, param(request.params, "entryId"));
  });

  app.post("/v1/library-entries/:entryId/bindings", async (request, reply) => {
    const service = libraries();
    // MFA is enforced by the service after entry authorization, so outsiders get a generic 404.
    const actor = await actorFor(request, reply, { scopes: [], sessionOnly: true });
    if (!actor) return;
    const body = objectBody(request.body);
    const result = await service.createBinding(actor, param(request.params, "entryId"), {
      targetId: boundedText(body.targetId, "targetId", 1, 128),
      replaceConflicting: optionalBoolean(body.replaceConflicting, "replaceConflicting") ?? false,
    });
    return reply.code(result.created ? 201 : 200).send({ binding: result.binding });
  });

  app.get("/v1/library-entries/:entryId/bindings", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, READ);
    if (!actor) return;
    return service.listBindings(actor, param(request.params, "entryId"));
  });

  app.delete("/v1/library-bindings/:bindingId", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, { scopes: [], sessionOnly: true });
    if (!actor) return;
    return service.detachBinding(actor, param(request.params, "bindingId"));
  });

  // ---- Candidates ---------------------------------------------------------

  app.get("/v1/library-candidates/:candidateId", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, READ);
    if (!actor) return;
    const query = queryObject(request.query);
    return service.getCandidate(actor, param(request.params, "candidateId"), query.includeContent === "true");
  });

  app.post("/v1/library-candidates/:candidateId/import", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, { scopes: ["libraries:write", "skills:submit"], mfa: "privileged" });
    if (!actor) return;
    const body = objectBody(request.body);
    let acknowledgeUnverifiedOrder: { reason: string } | null = null;
    if (body.acknowledgeUnverifiedOrder !== undefined) {
      const acknowledgement = objectBody(body.acknowledgeUnverifiedOrder);
      acknowledgeUnverifiedOrder = { reason: boundedText(acknowledgement.reason, "acknowledgeUnverifiedOrder.reason", 1, 500) };
    }
    const result = await service.importCandidate(actor, param(request.params, "candidateId"), {
      expectedPackageDigest: sha256(body.expectedPackageDigest, "expectedPackageDigest"),
      release: body.release,
      acknowledgeUnverifiedOrder,
      clientMutationId: parseMutationId(body.clientMutationId),
    });
    return reply.code(result.replayed ? 200 : 202).send(result);
  });

  app.post("/v1/library-candidates/:candidateId/ignore", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, WRITE);
    if (!actor) return;
    return service.ignoreCandidate(actor, param(request.params, "candidateId"));
  });

  app.post("/v1/library-candidates/:candidateId/self-review", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, { scopes: ["libraries:write", "skills:submit"] });
    if (!actor) return;
    const body = objectBody(request.body);
    const reason = optionalText(body.reason, "reason", 500);
    return service.selfReview(actor, param(request.params, "candidateId"), {
      artifactSha256: sha256(body.artifactSha256, "artifactSha256"),
      ...(reason ? { reason } : {}),
    });
  });

  app.post("/v1/library-candidates/:candidateId/instance-review-requests", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, { scopes: ["libraries:write", "skills:submit"] });
    if (!actor) return;
    return service.requestInstanceReview(actor, param(request.params, "candidateId"));
  });

  // ---- Inbox --------------------------------------------------------------

  app.get("/v1/library-inbox", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, READ);
    if (!actor) return;
    const query = queryObject(request.query);
    return service.listInbox(actor, { ...parsePage(request.query), unread: query.unread === "true" });
  });

  app.post("/v1/library-inbox/read", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, WRITE);
    if (!actor) return;
    const body = objectBody(request.body);
    if (!Array.isArray(body.eventIds) || body.eventIds.length > 200 || body.eventIds.some((id) => typeof id !== "string")) {
      throw invalid("eventIds must be an array of at most 200 ids.");
    }
    return service.markInboxRead(actor, body.eventIds as string[]);
  });

  // ---- Admin settings -----------------------------------------------------

  app.get("/v1/admin/library-settings", async (request, reply) => {
    const service = libraries();
    const actor = await actorFor(request, reply, { scopes: [], sessionOnly: true, mfa: "privileged" });
    if (!actor) return;
    return service.getAdminSettings(actor);
  });

  app.put("/v1/admin/library-settings", async (request, reply) => {
    const service = libraries();
    // Role is checked before MFA so a non-admin always sees ADMIN_ROLE_REQUIRED.
    const actor = await actorFor(request, reply, { scopes: [], sessionOnly: true });
    if (!actor) return;
    const body = objectBody(request.body);
    if (typeof body.privateSelfReviewEnabled !== "boolean") throw invalid("privateSelfReviewEnabled must be a boolean.");
    const reason = optionalText(body.reason, "reason", 500);
    return service.updateAdminSettings(actor, { privateSelfReviewEnabled: body.privateSelfReviewEnabled, ...(reason ? { reason } : {}) });
  });

  // ---- Instance elevation of self-reviewed releases -----------------------

  app.get("/v1/review/self-reviewed-releases", async (request, reply) => {
    const service = submissions();
    const actor = await actorFor(request, reply, { scopes: ["review:read"], mfa: "privileged" });
    if (!actor) return;
    return { releases: await service.listRequestedSelfReviewedReleases(actor) };
  });

  app.get("/v1/review/self-reviewed-releases/:submissionId/bundle", async (request, reply) => {
    const service = submissions();
    const actor = await actorFor(request, reply, { scopes: ["review:read"], mfa: "privileged" });
    if (!actor) return;
    const bundle = await service.getSelfReviewedReleaseBundle({ actor, submissionId: param(request.params, "submissionId") });
    if (!bundle) return reply.code(404).send({ error: { code: "SUBMISSION_NOT_FOUND", message: "Submission not found." } });
    return reply.header(helpers.artifactHashHeader, bundle.artifact.sha256).type(bundle.artifact.contentType).send(bundle.payload);
  });

  app.post("/v1/review/self-reviewed-releases/:submissionId/elevate", async (request, reply) => {
    const service = submissions();
    const actor = await actorFor(request, reply, { scopes: ["review:write"], mfa: "privileged" });
    if (!actor) return;
    const body = objectBody(request.body);
    const reason = optionalText(body.reason, "reason", 500);
    const release = await service.elevateSelfReviewedRelease({
      actor,
      submissionId: param(request.params, "submissionId"),
      artifactSha256: sha256(body.artifactSha256, "artifactSha256"),
      ...(reason ? { reason } : {}),
    });
    return { release };
  });
}

function invalid(message: string): AppError {
  return new AppError(message, "INVALID_REQUEST_BODY", 400);
}

function objectBody(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("JSON object body is required.");
  return input as Record<string, unknown>;
}

function queryObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? input as Record<string, unknown> : {};
}

function param(input: unknown, field: string): string {
  const value = queryObject(input)[field];
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw invalid(`${field} is invalid.`);
  return value;
}

function boundedText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw invalid(`${field} is required.`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) {
    throw invalid(`${field} must be ${min}-${max} characters of plain text.`);
  }
  return trimmed;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalid(`${field} must be a string.`);
  return value.trim() ? boundedText(value, field, 1, max) : "";
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalid(`${field} must be a boolean.`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1_000_000_000) throw invalid(`${field} must be a positive integer.`);
  return value;
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value.trim().toLowerCase())) throw invalid(`${field} must be a sha256 hex digest.`);
  return value.trim().toLowerCase();
}

function parseMutationId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !MUTATION_ID_PATTERN.test(value)) throw invalid("clientMutationId is invalid.");
  return value;
}

function parsePage(input: unknown): { limit: number; cursor: ReturnType<typeof decodeCursor> } {
  const query = queryObject(input);
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid("limit must be an integer from 1 to 100.");
  return { limit, cursor: decodeCursor(query.cursor) };
}

function parseOwner(input: unknown): { type: "user" } | { type: "team"; id: string } {
  if (input === undefined) return { type: "user" };
  const owner = objectBody(input);
  if (owner.type === "user") return { type: "user" };
  if (owner.type === "team") return { type: "team", id: boundedText(owner.id, "owner.id", 1, 128) };
  throw invalid("owner.type must be user or team.");
}

function parseRef(input: unknown): LibrarySourceRef {
  const ref = objectBody(input);
  if (typeof ref.kind !== "string" || !(librarySourceRefKinds as readonly string[]).includes(ref.kind)) {
    throw new AppError(`ref.kind must be one of: ${librarySourceRefKinds.join(", ")}.`, "SOURCE_REF_INVALID", 400);
  }
  if (ref.value !== undefined && typeof ref.value !== "string") throw new AppError("ref.value must be a string.", "SOURCE_REF_INVALID", 400);
  return ref.value === undefined ? { kind: ref.kind as LibrarySourceRefKind } : { kind: ref.kind as LibrarySourceRefKind, value: ref.value };
}

function parseMappings(input: unknown): Record<string, MappingOverrides> {
  if (input === undefined || input === null) return {};
  const mappings = objectBody(input);
  const result: Record<string, MappingOverrides> = {};
  for (const [path, value] of Object.entries(mappings).slice(0, 20)) {
    const mapping = objectBody(value);
    const unknown = Object.keys(mapping).find((key) => key !== "title" && key !== "summary" && key !== "license");
    if (unknown) throw invalid(`Mapping field is not accepted: ${unknown}`);
    const title = optionalText(mapping.title, "title", 120);
    const summary = optionalText(mapping.summary, "summary", 500);
    const license = optionalText(mapping.license, "license", 80);
    result[path] = {
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      ...(license ? { license } : {}),
    };
  }
  return result;
}

function parseEventKinds(input: unknown): LibraryEventKind[] {
  if (!Array.isArray(input) || input.some((kind) => typeof kind !== "string" || !(libraryEventKinds as readonly string[]).includes(kind))) {
    throw invalid(`events must be a list of: ${libraryEventKinds.join(", ")}.`);
  }
  return [...new Set(input as LibraryEventKind[])];
}
