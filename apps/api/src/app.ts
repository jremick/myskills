import Fastify, { type FastifyInstance, type FastifyReply, type FastifyServerOptions } from "fastify";
import { AppError, createArchitectureDiagramArtifact, type ArchitecturePatternMigrationMapping, type ArchitectureSpecV1, type SharingSettings, type SkillRepository, type VisibilityScope } from "@myskills-app/core";
import {
  MAX_PACKAGE_ARCHIVE_BYTES,
  MAX_PACKAGE_FILES,
  loadSkillManifestFromPackageFiles,
  PackageManifestFileError,
  parseSkillManifest,
  readPackageFilesFromZipBuffer,
  type PackageInputFile,
} from "@myskills-app/skill-package";
import type { ApiTokenScope } from "./auth/types.js";
import { MemoryAuthRateLimiter, type AuthRateLimiter } from "./auth/rate-limit.js";
import type {
  AuthContext,
  AuthService,
  AdminUserActionInput,
  AdminUserRoleUpdateInput,
  ChangePasswordInput,
  ConfirmEmailChangeInput,
  ConfirmEmailVerificationInput,
  ConfirmPasswordResetInput,
  ConfirmTotpEnrollmentInput,
  CreateApiTokenRequest,
  CreateRegistrationInvitationInput,
  DisableTotpMfaInput,
  ListAdminAuditEventsInput,
  LoginInput,
  RegisterInput,
  RequestEmailChangeInput,
  RequestEmailVerificationInput,
  RequestPasswordResetInput,
  StartTotpEnrollmentInput,
  UpdateRegistrationSettingsInput,
  UpsertProviderConfigRequest,
  VerifyMfaChallengeInput,
} from "./auth/service.js";
import type {
  ReleaseLifecycleAction,
  ReviewAction,
  SkillLifecycleAction,
  SkillMetadataUpdate,
  StoredSubmission,
  SubmissionActor,
  SubmissionOwnerAction,
} from "./submissions/types.js";
import type { SubmissionService } from "./submissions/service.js";
import type { TeamService } from "./teams/service.js";
import type { OrganizationService } from "./organizations/service.js";
import type { ArchitectureOrganizationGrantService } from "./architectures/organization-grant-service.js";
import type {
  ArchitecturePatternMigrationCreateResult,
  ArchitecturePatternMigrationService,
} from "./architectures/pattern-migration-service.js";
import type {
  OrganizationMembershipRole,
  OrganizationPolicyV1Input,
} from "./organizations/types.js";
import type { ArchitectureRecord, ArchitectureStore } from "./architectures/types.js";
import type { ArchitectureTargetService } from "./targets/service.js";
import type {
  ArchitectureTargetAdapterDescriptor,
  ArchitectureTargetCapabilities,
  ArchitectureTargetConsentDecision,
  ArchitectureTargetHealth,
  ArchitectureTargetMetadata,
  ArchitectureTargetObservationInput,
  ArchitectureTargetOwnerReference,
  RegisterArchitectureTargetInput,
} from "./targets/types.js";
import {
  ARCHITECTURE_PATTERNS,
  compileArchitecture,
  graphForCompiledArchitecture,
  outlineForArchitecture,
  planSync,
  validateArchitecturePattern,
  validateArchitectureSpec,
} from "./architectures/service.js";
import {
  resolveAuthorizedArchitectureRegistry,
  type ArchitectureResolutionScope,
} from "./architectures/exact-release-authorizer.js";
import { freezeArchitectureRevisionAuthorizationSnapshot } from "./architectures/revision-authorization.js";
import { API_VERSION } from "./version.js";

const SESSION_COOKIE_NAME = "myskills_session";
const COOKIE_SESSION_RESPONSE_HEADER = "x-myskills-session-response";
const REVIEW_ARTIFACT_HASH_HEADER = "x-myskills-artifact-sha256";
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
export const SUBMISSION_BODY_LIMIT_BYTES = 14 * 1024 * 1024;
const MCP_SESSION_REQUIRED_SCOPES: readonly ApiTokenScope[] = ["skills:read", "architectures:read"];
type TrustProxyOption = NonNullable<FastifyServerOptions["trustProxy"]>;

export interface ReadinessProbes {
  postgres: () => Promise<void>;
  /** Required when the Postgres-backed Phase 2 architecture services are configured. */
  phase2Architecture?: () => Promise<void>;
  artifactStorage?: () => Promise<void>;
  artifactStorageRequired?: boolean;
}

export interface BuildAppOptions {
  skillRepository: SkillRepository;
  authService?: AuthService;
  submissionService?: SubmissionService;
  teamService?: TeamService;
  organizationService?: OrganizationService;
  architectureStore?: ArchitectureStore;
  architectureTargetService?: ArchitectureTargetService;
  architectureOrganizationGrantService?: ArchitectureOrganizationGrantService;
  architecturePatternMigrationService?: ArchitecturePatternMigrationService;
  architectureProjectionLimiter?: AuthRateLimiter;
  architectureProjectionMaxInFlight?: number;
  allowedOrigins?: string[];
  trustProxy?: TrustProxyOption;
  requestLimiter?: AuthRateLimiter;
  readinessProbes?: ReadinessProbes;
  readinessTimeoutMs?: number;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
    ...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}),
  });
  const allowedOrigins = options.allowedOrigins ?? ["http://localhost:3000", "http://127.0.0.1:3000"];
  const requestLimiter = options.requestLimiter ?? new MemoryAuthRateLimiter({ maxAttempts: 600, windowMs: 60_000 });
  const architectureProjectionLimiter = options.architectureProjectionLimiter
    ?? new MemoryAuthRateLimiter({ maxAttempts: 30, windowMs: 60_000 });
  const architectureProjectionInFlight = new Map<string, number>();
  const architectureProjectionMaxInFlight = options.architectureProjectionMaxInFlight ?? 2;
  const probeLimiter = new MemoryAuthRateLimiter({ maxAttempts: 1_200, windowMs: 60_000 });
  const readinessTimeoutMs = Math.min(Math.max(options.readinessTimeoutMs ?? 2_000, 50), 10_000);

  app.addHook("onRequest", async (request, reply) => {
    setSecurityHeaders(reply);
    const origin = request.headers.origin;
    if (typeof origin === "string" && allowedOrigins.includes(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "Origin");
      reply.header("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
      reply.header("access-control-allow-headers", `authorization,content-type,${COOKIE_SESSION_RESPONSE_HEADER}`);
      reply.header("access-control-expose-headers", REVIEW_ARTIFACT_HASH_HEADER);
    }
    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
    if (
      !isSafeRequestMethod(request.method)
      && !firstHeader(request.headers.authorization)
      && sessionCookieToken(request.headers.cookie)
      && (typeof origin !== "string" || !allowedOrigins.includes(origin))
    ) {
      return reply.code(403).send({
        error: {
          code: "COOKIE_ORIGIN_REJECTED",
          message: "Cookie-authenticated changes require an allowed Origin header.",
        },
      });
    }
    const limiter = request.url === "/health" || request.url === "/ready" ? probeLimiter : requestLimiter;
    const result = await limiter.consume(`api:ip:${request.ip}`);
    if (!result.allowed) {
      return reply
        .header("retry-after", String(result.retryAfterSeconds))
        .code(429)
        .send({
          error: {
            code: "API_RATE_LIMITED",
            message: "Too many requests.",
            details: { retryAfterSeconds: result.retryAfterSeconds },
          },
        });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      const body: { error: { code: string; message: string; details?: unknown } } = {
        error: {
          code: error.code,
          message: error.message,
        },
      };
      if (error.details !== undefined) {
        body.error.details = error.details;
      }
      return reply.code(error.statusCode).send({
        ...body,
      });
    }
    const statusCode = httpStatusCode(error);
    if (statusCode === 413 && request.routeOptions.url === "/v1/submissions") {
      return reply.code(413).send({
        error: {
          code: "SUBMISSION_BODY_TOO_LARGE",
          message: `Submission body exceeds ${SUBMISSION_BODY_LIMIT_BYTES} bytes.`,
        },
      });
    }
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({
        error: {
          code: "INVALID_REQUEST",
          message: "Invalid request.",
        },
      });
    }
    return reply.code(500).send({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error.",
      },
    });
  });

  app.get("/health", async () => ({
    ok: true,
    service: "myskills-app-api",
  }));

  app.get("/ready", async (_request, reply) => {
    const [postgres, artifactStorage] = await Promise.all([
      readinessCheck(options.readinessProbes?.postgres, readinessTimeoutMs),
      options.readinessProbes?.artifactStorageRequired
        ? readinessCheck(options.readinessProbes.artifactStorage, readinessTimeoutMs)
        : Promise.resolve("not-required" as const),
    ]);
    const phase2Architecture = options.readinessProbes?.phase2Architecture
      ? await readinessCheck(options.readinessProbes.phase2Architecture, readinessTimeoutMs)
      : undefined;
    const checks = {
      postgres,
      artifactStorage,
      ...(phase2Architecture ? { phase2Architecture } : {}),
    };
    const ok = postgres === "ready"
      && artifactStorage !== "unready"
      && phase2Architecture !== "unready";
    return reply.code(ok ? 200 : 503).send({
      ok,
      service: "myskills-app-api",
      checks,
    });
  });

  app.get("/v1/capabilities", async () => {
    // In-memory fixtures do not configure this probe. A Postgres Phase 2
    // server does, so a partial migration cannot advertise unusable features.
    const phase2ArchitectureReady = options.readinessProbes?.phase2Architecture
      ? await readinessCheck(options.readinessProbes.phase2Architecture, readinessTimeoutMs) === "ready"
      : true;
    return {
      version: API_VERSION,
      capabilities: {
        auth: Boolean(options.authService),
        search: true,
        export: Boolean(options.submissionService),
        install: Boolean(options.submissionService),
        review: Boolean(options.authService && options.submissionService),
        lifecycle: Boolean(options.authService && options.submissionService),
        tokens: Boolean(options.authService),
        teams: Boolean(options.authService && options.teamService),
        organizations: phase2ArchitectureReady && Boolean(options.authService && options.organizationService),
        sharing: Boolean(options.authService),
        architectures: phase2ArchitectureReady && Boolean(options.authService && options.architectureStore && options.submissionService),
        architectureTargets: phase2ArchitectureReady && Boolean(options.authService && options.architectureTargetService),
        architectureOrganizationGrants: phase2ArchitectureReady && Boolean(options.authService && options.architectureOrganizationGrantService),
        architecturePatternMigrations: phase2ArchitectureReady && Boolean(options.authService && options.architecturePatternMigrationService),
      },
    };
  });

  app.get("/v1/architecture-patterns", async () => ({
    patterns: ARCHITECTURE_PATTERNS,
  }));

  app.get("/v1/architectures", async (request, reply) => {
    const user = await authenticateArchitectureReader(options, request, reply);
    if (!user) return;
    return {
      architectures: await requireArchitectureStore(options).listArchitectures(user.id),
    };
  });

  app.post("/v1/architectures", async (request, reply) => {
    const user = await authenticateArchitectureSession(options, request, reply, { mfaRequired: true });
    if (!user) return;
    const store = requireArchitectureStore(options);
    const input = parseCreateArchitectureInput(request.body);
    const owner = input.owner?.type === "team"
      ? { type: "team" as const, id: input.owner.id }
      : { type: "user" as const, id: user.id };
    if (owner.type === "team") requireMfaForSession(user);
    const architecture = await store.createArchitecture(user.id, { ...input, owner }, {
      actorUserId: user.id,
      action: "architecture.create",
      resourceType: "skill_architecture",
      details: {
        patternId: input.patternId,
        ownerType: owner.type,
      },
    });
    return reply.code(201).send({ architecture });
  });

  app.get("/v1/architectures/:id", async (request, reply) => {
    const user = await authenticateArchitectureReader(options, request, reply);
    if (!user) return;
    const store = requireArchitectureStore(options);
    const architectureId = parseArchitectureIdParam(request.params);
    const architecture = await store.getArchitecture(user.id, architectureId);
    if (!architecture) return architectureNotFound(reply);
    const revisions = await store.listRevisions(user.id, architectureId);
    if (!revisions) return architectureNotFound(reply);
    const latestRevision = architectureAccessIsOrganizationOnly(architecture)
      ? null
      : await store.getRevision(
        user.id,
        architectureId,
        architecture.currentRevisionId ?? undefined,
      );
    return {
      architecture,
      revisions: revisions.map(toArchitectureRevisionSummary),
      latestRevision,
    };
  });

  app.get("/v1/architectures/:id/revisions", async (request, reply) => {
    const user = await authenticateArchitectureReader(options, request, reply);
    if (!user) return;
    const store = requireArchitectureStore(options);
    const architectureId = parseArchitectureIdParam(request.params);
    const revisions = await store.listRevisions(user.id, architectureId);
    if (!revisions) return architectureNotFound(reply);
    return { revisions: revisions.map(toArchitectureRevisionSummary) };
  });

  app.post("/v1/architectures/:id/revisions", async (request, reply) => {
    const user = await authenticateArchitectureSession(options, request, reply, { mfaRequired: true });
    if (!user) return;
    const store = requireArchitectureStore(options);
    const architectureId = parseArchitectureIdParam(request.params);
    const architecture = await store.getArchitecture(user.id, architectureId);
    if (!architecture) return architectureNotFound(reply);
    if (!architecture.access.canAppend) {
      throw new AppError(
        architecture.owner.type === "team" ? "Team owner access is required." : "Architecture owner access is required.",
        architecture.owner.type === "team" ? "TEAM_OWNER_REQUIRED" : "ARCHITECTURE_OWNER_REQUIRED",
        403,
      );
    }
    if (architecture.owner.type === "team") requireMfaForSession(user);
    const input = parseCreateArchitectureRevisionInput(request.body, architecture);
    const authorizedRegistry = await resolveAuthorizedArchitectureRegistry(
      architectureReleaseDependencies(options),
      user.id,
      input.spec,
      architectureResolutionScope(architecture),
    );
    const authorizationSnapshot = freezeArchitectureRevisionAuthorizationSnapshot({
      actorId: user.id,
      architectureId,
      owner: architecture.owner,
      organizationIds: architecture.access.allowedOrganizationIds,
      releases: authorizedRegistry.map((release) => ({
        id: release.id,
        slug: release.slug,
        version: release.version,
        digest: release.digest,
        // Preserve the requested reference visibility in the intent. The
        // registry's resolved visibility is separately rechecked by the
        // persistence adapter; legacy fixtures may return a broader public
        // projection for a private reference.
        packageVisibility: input.spec.skills.find((skill) => skill.id === release.id)?.packageVisibility
          ?? release.packageVisibility,
      })),
    });
    const revision = await store.createRevision(user.id, {
      owner: architecture.owner,
      architectureId,
      ...input,
      authorizationSnapshot,
    }, {
      actorUserId: user.id,
      action: "architecture.revision.create",
      resourceType: "skill_architecture",
      resourceId: architectureId,
      details: {
        patternId: input.spec.pattern.id,
        nodeCount: input.spec.nodes.length,
        profileCount: input.spec.profiles.length,
        environmentCount: input.spec.environments.length,
      },
    });
    if (!revision) return architectureNotFound(reply);
    return reply.code(201).send({ revision });
  });

  app.post("/v1/architectures/:id/draft-preview", async (request, reply) => {
    const user = await authenticateArchitectureSession(options, request, reply, { mfaRequired: true });
    if (!user) return;
    if (!await enforceArchitectureProjectionRateLimit(architectureProjectionLimiter, user.id, reply)) return;
    if (!acquireArchitectureProjectionSlot(architectureProjectionInFlight, architectureProjectionMaxInFlight, user.id, reply)) return;
    try {
      const store = requireArchitectureStore(options);
      const architectureId = parseArchitectureIdParam(request.params);
      const architecture = await store.getArchitecture(user.id, architectureId);
      if (!architecture) return architectureNotFound(reply);
      if (!architecture.access.canAppend) {
        throw new AppError(
          architecture.owner.type === "team" ? "Team owner access is required." : "Architecture owner access is required.",
          architecture.owner.type === "team" ? "TEAM_OWNER_REQUIRED" : "ARCHITECTURE_OWNER_REQUIRED",
          403,
        );
      }
      if (architecture.owner.type === "team") requireMfaForSession(user);
      const draft = parseArchitectureDraftPreviewInput(request.body, architecture);
      if (draft.expectedCurrentRevisionId !== architecture.currentRevisionId) {
        throw new AppError(
          "The architecture changed after this draft was opened.",
          "ARCHITECTURE_REVISION_CONFLICT",
          409,
          { currentRevisionId: architecture.currentRevisionId },
        );
      }
      // Compile exactly once. The returned graph, outline, and optional plan
      // all describe this unsaved draft and its authorized registry snapshot.
      const compiled = await compileAuthorizedArchitecture(
        options,
        user.id,
        draft.spec,
        draft,
        architectureResolutionScope(architecture),
      );
      const response: {
        draft: {
          expectedCurrentRevisionId: string | null;
          spec: typeof draft.spec;
        };
        compiled: typeof compiled;
        graph: ReturnType<typeof graphForCompiledArchitecture>;
        outline: ReturnType<typeof outlineForArchitecture>;
        diagram: ReturnType<typeof createArchitectureDiagramArtifact>;
        plan?: ReturnType<typeof planSync>;
      } = {
        draft: {
          expectedCurrentRevisionId: draft.expectedCurrentRevisionId,
          spec: draft.spec,
        },
        compiled,
        graph: graphForCompiledArchitecture(compiled),
        outline: outlineForArchitecture(compiled),
        diagram: createArchitectureDiagramArtifact(compiled),
      };
      if (draft.fixtureProvided) {
        response.plan = planSync(compiled, draft.fixture);
        await store.recordAuditEvent({
          actorUserId: user.id,
          action: "architecture.draft_preview.dry_run",
          resourceType: "skill_architecture",
          resourceId: architectureId,
          details: {
            expectedCurrentRevisionId: draft.expectedCurrentRevisionId,
            profileId: compiled.profileId,
            environmentId: compiled.environmentId,
            changeCount: response.plan.items.length,
          },
        });
      }
      return response;
    } finally {
      releaseArchitectureProjectionSlot(architectureProjectionInFlight, user.id);
    }
  });

  app.get("/v1/architectures/:id/organization-grants", async (request, reply) => {
    const user = await authenticateArchitectureSession(options, request, reply);
    if (!user) return;
    const service = requireArchitectureOrganizationGrantService(options);
    return service.listOrganizationGrants({
      actor: { id: user.id, roles: user.roles },
      architectureId: parseArchitectureIdParam(request.params),
    });
  });

  app.put("/v1/architectures/:id/organization-grants", async (request, reply) => {
    const user = await authenticateArchitectureSession(options, request, reply);
    if (!user) return;
    requireMfaForSession(user);
    const service = requireArchitectureOrganizationGrantService(options);
    const architectureId = parseArchitectureIdParam(request.params);
    const input = parseReplaceArchitectureOrganizationGrantsInput(request.body);
    return service.replaceOrganizationGrants({
      actor: { id: user.id, roles: user.roles },
      architectureId,
      ...input,
    });
  });

  app.post("/v1/architectures/:id/pattern-migrations/preview", async (request, reply) => {
    const user = await authenticateArchitectureSession(options, request, reply);
    if (!user) return;
    if (!await enforceArchitectureProjectionRateLimit(architectureProjectionLimiter, user.id, reply)) return;
    if (!acquireArchitectureProjectionSlot(architectureProjectionInFlight, architectureProjectionMaxInFlight, user.id, reply)) return;
    try {
      const service = requireArchitecturePatternMigrationService(options);
      const input = parseArchitecturePatternMigrationPreviewInput(request.body);
      return await service.preview({
        actor: { id: user.id, roles: user.roles },
        architectureId: parseArchitectureIdParam(request.params),
        ...input,
      });
    } finally {
      releaseArchitectureProjectionSlot(architectureProjectionInFlight, user.id);
    }
  });

  app.post("/v1/architectures/:id/pattern-migrations", async (request, reply) => {
    const user = await authenticateArchitectureSession(options, request, reply);
    if (!user) return;
    requireMfaForSession(user);
    const service = requireArchitecturePatternMigrationService(options);
    const input = parseArchitecturePatternMigrationCreateInput(request.body);
    const result = await service.create({
      actor: { id: user.id, roles: user.roles },
      architectureId: parseArchitectureIdParam(request.params),
      ...input,
    });
    return reply.code(result.created ? 201 : 200).send(toArchitecturePatternMigrationResponse(result));
  });

  app.get("/v1/architectures/:id/revisions/:revisionId", async (request, reply) => {
    const user = await authenticateArchitectureReader(options, request, reply);
    if (!user) return;
    const store = requireArchitectureStore(options);
    const params = parseArchitectureRevisionParams(request.params);
    const architecture = await store.getArchitecture(user.id, params.architectureId);
    if (!architecture || architectureAccessIsOrganizationOnly(architecture)) return architectureNotFound(reply);
    const revision = await store.getRevision(user.id, params.architectureId, params.revisionId);
    if (!revision) return architectureNotFound(reply);
    return { revision };
  });

  app.post("/v1/architectures/:id/preview", async (request, reply) => {
    const user = await authenticateArchitectureReader(options, request, reply);
    if (!user) return;
    if (!await enforceArchitectureProjectionRateLimit(architectureProjectionLimiter, user.id, reply)) return;
    if (!acquireArchitectureProjectionSlot(architectureProjectionInFlight, architectureProjectionMaxInFlight, user.id, reply)) return;
    try {
      const store = requireArchitectureStore(options);
      const architectureId = parseArchitectureIdParam(request.params);
      const architecture = await store.getArchitecture(user.id, architectureId);
      if (!architecture) return architectureNotFound(reply);
      const preview = parseArchitectureProjectionInput(request.body);
      const organizationId = architectureProjectionOrganizationId(architecture, preview.organizationId);
      const revision = await store.getRevisionForPreview(
        user.id,
        architectureId,
        preview.revisionId,
        organizationId,
      );
      if (!revision) return architectureNotFound(reply);
      // Compile exactly once. Graph, outline, and the optional dry-run plan must
      // all describe this same authorized registry projection.
      const compiled = await compileAuthorizedArchitecture(
        options,
        user.id,
        revision.spec,
        preview,
        architectureResolutionScope(architecture, organizationId),
      );
      const response: {
        revision?: typeof revision;
        compiled: typeof compiled;
        graph: ReturnType<typeof graphForCompiledArchitecture>;
        outline: ReturnType<typeof outlineForArchitecture>;
        diagram: ReturnType<typeof createArchitectureDiagramArtifact>;
        plan?: ReturnType<typeof planSync>;
      } = {
        ...(architectureAccessIsOrganizationOnly(architecture) ? {} : { revision }),
        compiled,
        graph: graphForCompiledArchitecture(compiled),
        outline: outlineForArchitecture(compiled),
        diagram: createArchitectureDiagramArtifact(compiled),
      };
      if (preview.fixtureProvided) {
        response.plan = planSync(compiled, preview.fixture);
        await store.recordAuditEvent({
          actorUserId: user.id,
          action: "architecture.preview.dry_run",
          resourceType: "skill_architecture",
          resourceId: architectureId,
          details: {
            revisionId: revision.id,
            profileId: compiled.profileId,
            environmentId: compiled.environmentId,
            changeCount: response.plan.items.length,
          },
        });
      }
      return response;
    } finally {
      releaseArchitectureProjectionSlot(architectureProjectionInFlight, user.id);
    }
  });

  app.get("/v1/architecture-targets", async (request, reply) => {
    const user = await authenticateArchitectureTargetSession(options, request, reply);
    if (!user) return;
    return {
      targets: await requireArchitectureTargetService(options).listTargets(user.id),
    };
  });

  app.post("/v1/architecture-targets", async (request, reply) => {
    const user = await authenticateArchitectureTargetSession(options, request, reply, { mfaRequired: true });
    if (!user) return;
    requireMfaForSession(user);
    const target = await requireArchitectureTargetService(options).registerTarget({
      actor: user.id,
      ...parseRegisterArchitectureTargetInput(request.body),
    });
    return reply.code(201).send({ target });
  });

  app.get("/v1/architecture-targets/:id", async (request, reply) => {
    const user = await authenticateArchitectureTargetSession(options, request, reply);
    if (!user) return;
    const target = await requireArchitectureTargetService(options).getTarget(
      user.id,
      parseArchitectureTargetIdParam(request.params),
    );
    if (!target) return architectureTargetNotFound(reply);
    return { target };
  });

  app.post("/v1/architecture-targets/:id/consent", async (request, reply) => {
    const user = await authenticateArchitectureTargetSession(options, request, reply, { mfaRequired: true });
    if (!user) return;
    requireMfaForSession(user);
    const targetId = parseArchitectureTargetIdParam(request.params);
    const { decision } = parseArchitectureTargetConsentInput(request.body);
    return {
      target: await requireArchitectureTargetService(options).setConsent({
        actor: user.id,
        targetId,
        decision,
      }),
    };
  });

  app.get("/v1/architecture-targets/:id/observations", async (request, reply) => {
    const user = await authenticateArchitectureTargetSession(options, request, reply);
    if (!user) return;
    const targetId = parseArchitectureTargetIdParam(request.params);
    return {
      observations: await requireArchitectureTargetService(options).listObservations(
        user.id,
        targetId,
        parseArchitectureTargetObservationQuery(request.query).limit,
      ),
    };
  });

  app.post("/v1/architecture-targets/:id/observations", async (request, reply) => {
    const user = await authenticateArchitectureTargetSession(options, request, reply);
    if (!user) return;
    const targetId = parseArchitectureTargetIdParam(request.params);
    const observation = await requireArchitectureTargetService(options).appendObservation({
      actor: user.id,
      targetId,
      observation: parseArchitectureTargetObservationInput(request.body, targetId),
    });
    return reply.code(201).send({ observation });
  });

  app.post("/v1/architecture-targets/:id/health", async (request, reply) => {
    const user = await authenticateArchitectureTargetSession(options, request, reply);
    if (!user) return;
    const targetId = parseArchitectureTargetIdParam(request.params);
    return {
      target: await requireArchitectureTargetService(options).updateHealth({
        actor: user.id,
        targetId,
        health: parseArchitectureTargetHealthInput(request.body),
      }),
    };
  });

  app.delete("/v1/architecture-targets/:id", async (request, reply) => {
    const user = await authenticateArchitectureTargetSession(options, request, reply, { mfaRequired: true });
    if (!user) return;
    requireMfaForSession(user);
    return {
      target: await requireArchitectureTargetService(options).revokeTarget({
        actor: user.id,
        targetId: parseArchitectureTargetIdParam(request.params),
      }),
    };
  });

  app.get("/v1/skills", async (request) => {
    const query = parseQuery(request.query);
    const user = await authenticateOptionalRegistryReader(options.authService, requestAuthorization(request));
    const skills = await options.skillRepository.searchVisibleSkills({
      query: query.q,
      limit: query.limit,
      actorId: user?.id ?? null,
    });
    return { skills };
  });

  app.get("/v1/skills/:slug/releases", async (request) => {
    if (!options.submissionService) {
      throw new AppError("Submission service is not configured.", "SUBMISSION_SERVICE_UNAVAILABLE", 503);
    }
    const actor = await authenticateOptionalActor(options.authService, requestAuthorization(request), "skills:read");
    return {
      releases: await options.submissionService.listSkillReleases({
        slug: parseSlugParam(request.params),
        actor,
      }),
    };
  });

  app.get("/v1/skills/:slug/releases/:version", async (request, reply) => {
    if (!options.submissionService) {
      throw new AppError("Submission service is not configured.", "SUBMISSION_SERVICE_UNAVAILABLE", 503);
    }
    const params = parseReleaseParams(request.params);
    const user = await authenticateOptionalRegistryReader(options.authService, requestAuthorization(request));
    const release = await options.submissionService.getPublicRelease({
      ...params,
      actorId: user?.id ?? null,
    });
    if (!release) {
      return reply.code(404).send({
        error: {
          code: "RELEASE_NOT_FOUND",
          message: "Release not found.",
        },
      });
    }
    return { release };
  });

  app.get("/v1/skills/:slug/releases/:version/bundle", async (request, reply) => {
    if (!options.submissionService) {
      throw new AppError("Submission service is not configured.", "SUBMISSION_SERVICE_UNAVAILABLE", 503);
    }
    const params = parseReleaseParams(request.params);
    const query = parseBundleQuery(request.query);
    const user = await authenticateOptionalRegistryReader(options.authService, requestAuthorization(request));
    const bundle = await options.submissionService.getPublicBundle({
      ...params,
      platform: query.platform,
      actorId: user?.id ?? null,
    });
    if (!bundle) {
      return reply.code(404).send({
        error: {
          code: "RELEASE_NOT_FOUND",
          message: "Release not found.",
        },
      });
    }
    return reply
      .type(bundle.artifact.contentType)
      .send(bundle.payload);
  });

  app.get("/v1/skills/:slug", async (request, reply) => {
    const slug = parseSlugParam(request.params);
    const user = await authenticateOptionalRegistryReader(options.authService, requestAuthorization(request));
    const skill = await options.skillRepository.getVisibleSkillBySlug(slug, user?.id ?? null);
    if (!skill) {
      return reply.code(404).send({
        error: {
          code: "SKILL_NOT_FOUND",
          message: "Skill not found.",
        },
      });
    }
    return { skill };
  });

  app.put("/v1/skills/:slug", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.submissionService) {
      throw new AppError("Submission service is not configured.", "SUBMISSION_SERVICE_UNAVAILABLE", 503);
    }
    const actor = await authenticateActor(options.authService, requestAuthorization(request), "review:write", { mfaRequired: true });
    if (!actor) {
      return reply.code(401).send({
        error: {
          code: "AUTHENTICATION_REQUIRED",
          message: "Authentication is required.",
        },
      });
    }
    const slug = parseSlugParam(request.params);
    const input = parseSkillMetadataUpdateInput(request.body);
    // beta.2 clients sent visibility through the metadata route. Keep that
    // input working, but route the access-control change through the
    // canonical sharing boundary. Omitted grant fields are preserved by the
    // repository, including grants outside the actor's visible memberships.
    if (input.visibility !== undefined) {
      // Visibility is an access-control mutation, even when it arrives from
      // the deprecated metadata route. Keep the beta.2 field compatible, but
      // use the same session-only, MFA-verified boundary as canonical sharing
      // before reading or replacing any resource grants. In particular, an
      // API token must never widen a private skill through this shim.
      const sessionUser = await authenticateSessionUser(options.authService, requestAuthorization(request));
      if (!sessionUser) {
        return authFailureReply(options.authService, requestAuthorization(request), reply);
      }
      requireMfaForSession(sessionUser);
      const sharingActor = {
        id: sessionUser.id,
        roles: sessionUser.roles,
      };
      await options.skillRepository.updateSkillSharing({
        actor: sharingActor,
        slug,
        visibility: input.visibility,
      });
    }
    const skill = Object.keys(input.update).length > 0
      ? await options.submissionService.updateSkillMetadata({
        actor,
        slug,
        update: input.update,
        ...(input.reason ? { reason: input.reason } : {}),
      })
      : await options.submissionService.getSkillManagement({ actor, slug });
    if (!skill) {
      throw new AppError("Skill not found.", "SKILL_NOT_FOUND", 404);
    }
    return {
      skill: input.visibility === undefined ? skill : { ...skill, visibility: input.visibility },
    };
  });

  app.post("/v1/skills/:slug/actions", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.submissionService) {
      throw new AppError("Submission service is not configured.", "SUBMISSION_SERVICE_UNAVAILABLE", 503);
    }
    const actor = await authenticateActor(options.authService, requestAuthorization(request), "review:write", { mfaRequired: true });
    if (!actor) {
      return reply.code(401).send({
        error: {
          code: "AUTHENTICATION_REQUIRED",
          message: "Authentication is required.",
        },
      });
    }
    return {
      skill: await options.submissionService.performSkillAction({
        actor,
        slug: parseSlugParam(request.params),
        ...parseSkillLifecycleActionInput(request.body),
      }),
    };
  });

  app.post("/v1/skills/:slug/releases/:version/actions", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.submissionService) {
      throw new AppError("Submission service is not configured.", "SUBMISSION_SERVICE_UNAVAILABLE", 503);
    }
    const actor = await authenticateActor(options.authService, requestAuthorization(request), "review:write", { mfaRequired: true });
    if (!actor) {
      return reply.code(401).send({
        error: {
          code: "AUTHENTICATION_REQUIRED",
          message: "Authentication is required.",
        },
      });
    }
    const params = parseReleaseParams(request.params);
    return {
      release: await options.submissionService.performReleaseAction({
        actor,
        ...params,
        ...parseReleaseLifecycleActionInput(request.body),
      }),
    };
  });

  app.get("/v1/skills/:slug/sharing", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    requireMfaForPrivilegedSession(user);
    return {
      sharing: await options.skillRepository.getSkillSharing(parseSlugParam(request.params), {
        id: user.id,
        roles: user.roles,
      }),
    };
  });

  app.put("/v1/skills/:slug/sharing", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    const input = parseUpdateSkillSharingInput(request.body);
    if (skillSharingExpandsTeamOrOrganizationVisibility(input)) {
      requireMfaForSession(user);
    } else {
      requireMfaForPrivilegedSession(user);
    }
    const slug = parseSlugParam(request.params);
    return {
      sharing: await options.skillRepository.updateSkillSharing({
        actor: {
          id: user.id,
          roles: user.roles,
        },
        slug,
        ...input,
      }),
    };
  });

  app.post("/v1/auth/register", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const result = await options.authService.register({
      ...parseRegisterInput(request.body),
      ip: request.ip,
    });
    return reply.code(202).send(result);
  });

  app.post("/v1/auth/login", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const result = await options.authService.login({
      ...parseLoginInput(request.body),
      ip: request.ip,
    });
    if (!result.mfaRequired) {
      setSessionCookie(reply, result.token, result.expiresAt);
    }
    return cookieSessionResponse(request, result);
  });

  app.post("/v1/auth/email-verification/request", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const result = await options.authService.requestEmailVerification({
      ...parseEmailVerificationRequestInput(request.body),
      ip: request.ip,
    });
    return reply.code(202).send(result);
  });

  app.post("/v1/auth/email-verification/confirm", async (request) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    return options.authService.confirmEmailVerification({
      ...parseEmailVerificationConfirmInput(request.body),
      ip: request.ip,
    });
  });

  app.post("/v1/auth/password-reset/request", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const result = await options.authService.requestPasswordReset({
      ...parsePasswordResetRequestInput(request.body),
      ip: request.ip,
    });
    return reply.code(202).send(result);
  });

  app.post("/v1/auth/password-reset/confirm", async (request) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    return options.authService.confirmPasswordReset({
      ...parsePasswordResetConfirmInput(request.body),
      ip: request.ip,
    });
  });

  app.post("/v1/auth/email-change/confirm", async (request) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    return options.authService.confirmEmailChange({
      ...parseEmailChangeConfirmInput(request.body),
      ip: request.ip,
    });
  });

  app.post("/v1/auth/mfa/verify", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const result = await options.authService.verifyMfaChallenge({
      ...parseVerifyMfaChallengeInput(request.body),
      ip: request.ip,
    });
    setSessionCookie(reply, result.token, result.expiresAt);
    return cookieSessionResponse(request, result);
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    if (options.authService) {
      await options.authService.logout(requestAuthorization(request));
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.post("/v1/auth/account/password", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return options.authService.changePassword(user, {
      ...parseChangePasswordInput(request.body),
      ip: request.ip,
    });
  });

  app.post("/v1/auth/account/email-change", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    const result = await options.authService.requestEmailChange(user, {
      ...parseEmailChangeRequestInput(request.body),
      ip: request.ip,
    });
    return reply.code(202).send(result);
  });

  app.get("/v1/auth/mfa", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return { mfa: await options.authService.getMfaStatus(user) };
  });

  app.post("/v1/auth/mfa/totp/enroll", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    const enrollment = await options.authService.startTotpEnrollment(user, parseStartTotpEnrollmentInput(request.body));
    return reply.code(201).send({ enrollment });
  });

  app.post("/v1/auth/mfa/totp/confirm", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return { mfa: await options.authService.confirmTotpEnrollment(user, parseConfirmTotpEnrollmentInput(request.body)) };
  });

  app.delete("/v1/auth/mfa/totp", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return { mfa: await options.authService.disableTotpMfa(user, parseDisableTotpMfaInput(request.body)) };
  });

  app.get("/v1/auth/api-tokens", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return { tokens: await options.authService.listApiTokens(user) };
  });

  app.post("/v1/auth/api-tokens", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    const token = await options.authService.createApiToken(user, parseCreateApiTokenInput(request.body));
    return reply.code(201).send({ token });
  });

  app.delete("/v1/auth/api-tokens/:id", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    const token = await options.authService.revokeApiToken(user, parseTokenIdParam(request.params));
    return { token };
  });

  app.get("/v1/admin/registration", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return { registration: await options.authService.getRegistrationSettings(user) };
  });

  app.put("/v1/admin/registration", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return {
      registration: await options.authService.updateRegistrationSettings(
        user,
        parseUpdateRegistrationSettingsInput(request.body),
      ),
    };
  });

  app.post("/v1/admin/registration/invitations", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    const invitation = await options.authService.createRegistrationInvitation(
      user,
      parseCreateRegistrationInvitationInput(request.body),
    );
    return reply.code(201).send({ invitation });
  });

  app.get("/v1/admin/sharing", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    if (!isAdminResponseUser(user)) {
      return reply.code(403).send({
        error: {
          code: "ADMIN_ROLE_REQUIRED",
          message: "Admin access is required.",
        },
      });
    }
    requireMfaForPrivilegedSession(user);
    return { sharing: await options.skillRepository.getSharingSettings() };
  });

  app.put("/v1/admin/sharing", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    requireMfaForPrivilegedSession(user);
    const input = parseSharingSettingsInput(request.body);
    // The organization switch was added after the original five-field
    // contract. Preserve its current value when an older client omits it;
    // otherwise a legacy update would silently disable organization sharing.
    const settings = input.organizationVisibilityEnabled === undefined
      ? { ...(await options.skillRepository.getSharingSettings()), ...input }
      : input;
    return {
      sharing: await options.skillRepository.updateSharingSettings(
        { id: user.id, roles: user.roles },
        settings,
      ),
    };
  });

  app.get("/v1/admin/providers", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return { providers: await options.authService.listAdminProviderConfigs(user) };
  });

  app.put("/v1/admin/providers/:key", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return {
      provider: await options.authService.upsertAdminProviderConfig(
        user,
        parseProviderConfigInput(request.params, request.body),
      ),
    };
  });

  app.get("/v1/admin/users", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return { users: await options.authService.listAdminUsers(user) };
  });

  app.post("/v1/admin/users/:id/actions", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return {
      user: await options.authService.performAdminUserAction(
        user,
        parseAdminUserActionInput(request.params, request.body),
      ),
    };
  });

  app.put("/v1/admin/users/:id/roles", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return {
      user: await options.authService.updateAdminUserRoles(
        user,
        parseAdminUserRoleUpdateInput(request.params, request.body),
      ),
    };
  });

  app.get("/v1/admin/api-tokens", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return { tokens: await options.authService.listAdminApiTokens(user) };
  });

  app.delete("/v1/admin/api-tokens/:id", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return { token: await options.authService.revokeAdminApiToken(user, parseTokenIdParam(request.params)) };
  });

  app.get("/v1/admin/audit", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return { events: await options.authService.listAdminAuditEvents(user, parseAdminAuditQuery(request.query)) };
  });

  app.get("/v1/me", async (request, reply) => {
    const context = await options.authService?.authenticateRequest(requestAuthorization(request));
    if (context) {
      requireScope(context, "profile:read");
      return { user: context.user };
    }
    return reply.code(401).send({
      error: {
        code: "AUTHENTICATION_REQUIRED",
        message: "Authentication is required.",
      },
    });
  });

  app.get("/v1/organizations", async (request, reply) => {
    const service = requireOrganizationService(options);
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return {
      organizations: await service.listOrganizations({ id: user.id, email: user.email, name: user.name }),
    };
  });

  app.post("/v1/organizations", async (request, reply) => {
    const service = requireOrganizationService(options);
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    requireMfaForOrganizationSession(user);
    const input = parseCreateOrganizationInput(request.body);
    const organization = await service.createOrganization({
      actor: { id: user.id, email: user.email, name: user.name },
      ...input,
    });
    return reply.code(201).send({ organization });
  });

  // Keep the collection route before /:id so a pending-invitation lookup
  // cannot be interpreted as an organization ID.
  app.get("/v1/organizations/invitations", async (request, reply) => {
    const service = requireOrganizationService(options);
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return {
      invitations: await service.listPendingInvitations({ id: user.id, email: user.email, name: user.name }),
    };
  });

  app.post("/v1/organizations/invitations/:id/accept", async (request, reply) => {
    const service = requireOrganizationService(options);
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    parseOrganizationEmptyInput(request.body);
    return {
      invitation: await service.acceptInvitation({
        actor: { id: user.id, email: user.email, name: user.name },
        invitationId: parseOpaqueIdParam(request.params, "id"),
      }),
    };
  });

  app.get("/v1/organizations/:id", async (request, reply) => {
    const service = requireOrganizationService(options);
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    const organization = await service.getOrganization(
      { id: user.id, email: user.email, name: user.name },
      parseOrganizationIdParam(request.params),
    );
    if (!organization) return organizationNotFound(reply);
    return { organization };
  });

  app.get("/v1/organizations/:id/members", async (request, reply) => {
    const service = requireOrganizationService(options);
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return {
      members: await service.listMembers(
        { id: user.id, email: user.email, name: user.name },
        parseOrganizationIdParam(request.params),
      ),
    };
  });

  app.get("/v1/organizations/:id/invitations", async (request, reply) => {
    const service = requireOrganizationService(options);
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return {
      invitations: await service.listInvitations(
        { id: user.id, email: user.email, name: user.name },
        parseOrganizationIdParam(request.params),
      ),
    };
  });

  app.post("/v1/organizations/:id/invitations", async (request, reply) => {
    const service = requireOrganizationService(options);
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    requireMfaForOrganizationSession(user);
    const organizationId = parseOrganizationIdParam(request.params);
    const input = parseOrganizationInvitationInput(request.body);
    const invitation = await service.inviteMember({
      actor: { id: user.id, email: user.email, name: user.name },
      organizationId,
      ...input,
    });
    return reply.code(201).send({ invitation });
  });

  app.put("/v1/organizations/:id/members/:memberId", async (request, reply) => {
    const service = requireOrganizationService(options);
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    requireMfaForOrganizationSession(user);
    const input = parseOrganizationMemberRoleInput(request.params, request.body);
    const member = await service.updateMemberRole({
      actor: { id: user.id, email: user.email, name: user.name },
      ...input,
    });
    return { member };
  });

  app.delete("/v1/organizations/:id/members/:memberId", async (request, reply) => {
    const service = requireOrganizationService(options);
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    requireMfaForOrganizationSession(user);
    const params = parseOrganizationMemberParams(request.params);
    const member = await service.removeMember({
      actor: { id: user.id, email: user.email, name: user.name },
      ...params,
    });
    return { member };
  });

  app.get("/v1/organizations/:id/policy-revisions", async (request, reply) => {
    const service = requireOrganizationService(options);
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return {
      revisions: await service.listPolicies(
        { id: user.id, email: user.email, name: user.name },
        parseOrganizationIdParam(request.params),
      ),
    };
  });

  app.post("/v1/organizations/:id/policy-revisions", async (request, reply) => {
    const service = requireOrganizationService(options);
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    requireMfaForOrganizationSession(user);
    const input = parseAppendOrganizationPolicyInput(request.body);
    const result = await service.appendPolicyRevision({
      actor: { id: user.id, email: user.email, name: user.name },
      organizationId: parseOrganizationIdParam(request.params),
      ...input,
    });
    return reply.code(result.created ? 201 : 200).send(result);
  });

  app.post("/v1/organizations/:id/policy-revisions/:revisionId/actions", async (request, reply) => {
    const service = requireOrganizationService(options);
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    requireMfaForOrganizationSession(user);
    const { action } = parseOrganizationPolicyActionInput(request.body);
    if (action !== "activate") {
      throw new AppError("Unsupported organization policy action.", "INVALID_ORGANIZATION_POLICY_ACTION", 400);
    }
    const result = await service.activatePolicyRevision({
      actor: { id: user.id, email: user.email, name: user.name },
      organizationId: parseOrganizationIdParam(request.params),
      revisionId: parseOpaqueIdParam(request.params, "revisionId"),
    });
    return { revision: result.revision, activated: result.activated, changed: result.changed };
  });

  app.post("/v1/organizations/:id/actions", async (request, reply) => {
    const service = requireOrganizationService(options);
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    requireMfaForOrganizationSession(user);
    const { action } = parseOrganizationArchiveActionInput(request.body);
    if (action !== "archive") {
      throw new AppError("Unsupported organization action.", "INVALID_ORGANIZATION_ACTION", 400);
    }
    const organization = await service.archiveOrganization({
      actor: { id: user.id, email: user.email, name: user.name },
      organizationId: parseOrganizationIdParam(request.params),
    });
    return { organization };
  });

  app.get("/v1/organizations/:id/teams", async (request, reply) => {
    const service = requireOrganizationService(options);
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.teamService) {
      throw new AppError("Team service is not configured.", "TEAM_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    const organizationId = parseOrganizationIdParam(request.params);
    const organization = await service.getOrganization(
      { id: user.id, email: user.email, name: user.name },
      organizationId,
    );
    if (!organization) return organizationNotFound(reply);
    const dashboard = await options.teamService.listDashboard({ id: user.id, email: user.email });
    return { teams: dashboard.teams.filter((team) => team.organizationId === organizationId) };
  });

  app.post("/v1/organizations/:id/teams", async (request, reply) => {
    const service = requireOrganizationService(options);
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    requireMfaForOrganizationSession(user);
    const input = parseOrganizationChildTeamInput(request.body);
    const team = await service.createChildTeam({
      actor: { id: user.id, email: user.email },
      organizationId: parseOrganizationIdParam(request.params),
      ...input,
    });
    return reply.code(201).send({ team });
  });

  app.get("/v1/teams", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.teamService) {
      throw new AppError("Team service is not configured.", "TEAM_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return options.teamService.listDashboard({ id: user.id, email: user.email });
  });

  app.post("/v1/teams", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.teamService) {
      throw new AppError("Team service is not configured.", "TEAM_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    const input = parseTeamCreateInput(request.body);
    requireMfaForSession(user);
    const team = await options.teamService.createTeam({
      actor: { id: user.id, email: user.email },
      name: input.name,
      settings: await options.skillRepository.getSharingSettings(),
    });
    return reply.code(201).send({ team });
  });

  app.put("/v1/teams/:id/organization", async (request, reply) => {
    const service = requireOrganizationService(options);
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.teamService) {
      throw new AppError("Team service is not configured.", "TEAM_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    requireMfaForOrganizationSession(user);
    const input = parseOrganizationTeamAdoptionInput(request.body);
    const team = await service.adoptStandaloneTeam({
      actor: { id: user.id, email: user.email },
      teamId: parseOpaqueIdParam(request.params, "id"),
      ...input,
    });
    return { team };
  });

  app.post("/v1/teams/:id/invitations", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.teamService) {
      throw new AppError("Team service is not configured.", "TEAM_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    const teamId = parseOpaqueIdParam(request.params, "id");
    await requireMfaForTeamOwner(options.teamService, user, teamId);
    const invitation = await options.teamService.inviteMember({
      actor: { id: user.id, email: user.email },
      teamId,
      email: parseTeamInviteInput(request.body).email,
      settings: await options.skillRepository.getSharingSettings(),
    });
    return reply.code(201).send({ invitation });
  });

  app.delete("/v1/teams/:teamId/invitations/:invitationId", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.teamService) {
      throw new AppError("Team service is not configured.", "TEAM_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    const params = parseTeamInvitationLifecycleParams(request.params);
    await requireMfaForTeamOwner(options.teamService, user, params.teamId);
    const invitation = await options.teamService.revokeInvitation({
      actor: { id: user.id, email: user.email },
      teamId: params.teamId,
      invitationId: params.invitationId,
      settings: await options.skillRepository.getSharingSettings(),
    });
    return { invitation };
  });

  app.put("/v1/teams/:teamId/members/:memberId", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.teamService) {
      throw new AppError("Team service is not configured.", "TEAM_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    const input = parseTeamMemberRoleInput(request.params, request.body);
    await requireMfaForTeamOwner(options.teamService, user, input.teamId);
    const member = await options.teamService.updateMemberRole({
      actor: { id: user.id, email: user.email },
      ...input,
      settings: await options.skillRepository.getSharingSettings(),
    });
    return { member };
  });

  app.delete("/v1/teams/:teamId/members/:memberId", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.teamService) {
      throw new AppError("Team service is not configured.", "TEAM_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    const params = parseTeamMemberLifecycleParams(request.params);
    await requireMfaForTeamOwner(options.teamService, user, params.teamId);
    const member = await options.teamService.removeMember({
      actor: { id: user.id, email: user.email },
      ...params,
      settings: await options.skillRepository.getSharingSettings(),
    });
    return { member };
  });

  app.post("/v1/teams/invitations/:id/accept", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.teamService) {
      throw new AppError("Team service is not configured.", "TEAM_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return {
      invitation: await options.teamService.acceptInvitation({
        actor: { id: user.id, email: user.email },
        invitationId: parseOpaqueIdParam(request.params, "id"),
        settings: await options.skillRepository.getSharingSettings(),
      }),
    };
  });

  app.get("/v1/teams/shared-skills", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return {
      teams: await options.skillRepository.listTeamSkillGroups({
        id: user.id,
        roles: user.roles,
      }),
    };
  });

  app.get("/v1/mcp/session", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const context = await options.authService.authenticateRequest(requestAuthorization(request));
    if (!context) {
      await options.authService.recordMcpSessionDecision({
        context: null,
        credentialKind: "none",
        decision: "deny",
        reason: hasBearerAuthorization(requestAuthorization(request)) ? "invalid_bearer" : "missing_bearer",
      });
      return reply.code(401).send({
        error: {
          code: "AUTHENTICATION_REQUIRED",
          message: "Authentication is required.",
        },
      });
    }
    if (context.credential.kind !== "api_token") {
      await options.authService.recordMcpSessionDecision({
        context,
        credentialKind: "session",
        decision: "deny",
        reason: "api_credential_required",
      });
      return reply.code(403).send({
        error: {
          code: "API_TOKEN_AUTH_REQUIRED",
          message: "API token authentication is required.",
        },
      });
    }
    if (!MCP_SESSION_REQUIRED_SCOPES.some((scope) => context.credential.scopes.includes(scope))) {
      await options.authService.recordMcpSessionDecision({
        context,
        credentialKind: "api",
        decision: "deny",
        reason: "missing_scope",
      });
      return reply.code(403).send({
        error: {
          code: "API_TOKEN_SCOPE_REQUIRED",
          message: "API token scope is required.",
          // Keep the beta.2 scalar detail stable. MCP tools perform the
          // narrower registry/architecture scope check after this session
          // bootstrap gate.
          details: { scope: "skills:read" },
        },
      });
    }
    await options.authService.recordMcpSessionDecision({
      context,
      credentialKind: "api",
      decision: "allow",
      reason: "authorized",
    });
    return {
      user: context.user,
      credential: {
        kind: context.credential.kind,
        tokenId: context.credential.tokenId,
        scopes: context.credential.scopes,
      },
    };
  });

  app.get("/v1/submissions/mine", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.submissionService) {
      throw new AppError("Submission service is not configured.", "SUBMISSION_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    return {
      submissions: await options.submissionService.listUserSubmissions({
        id: user.id,
        roles: user.roles,
      }),
    };
  });

  app.get("/v1/submissions/:id/bundle", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.submissionService) {
      throw new AppError("Submission service is not configured.", "SUBMISSION_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
    if (!user) {
      return authFailureReply(options.authService, requestAuthorization(request), reply);
    }
    const bundle = await options.submissionService.getUserSubmissionBundle({
      actor: {
        id: user.id,
        roles: user.roles,
      },
      submissionId: parseSubmissionIdParam(request.params),
      ...parseBundleQuery(request.query),
    });
    if (!bundle) {
      return reply.code(404).send({
        error: {
          code: "SUBMISSION_NOT_FOUND",
          message: "Submission not found.",
        },
      });
    }
    return reply
      .type(bundle.artifact.contentType)
      .send(bundle.payload);
  });

  app.post("/v1/submissions/:id/actions", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.submissionService) {
      throw new AppError("Submission service is not configured.", "SUBMISSION_SERVICE_UNAVAILABLE", 503);
    }
    const actor = await authenticateActor(options.authService, requestAuthorization(request), "skills:submit", { mfaRequired: true });
    if (!actor) {
      return reply.code(401).send({
        error: {
          code: "AUTHENTICATION_REQUIRED",
          message: "Authentication is required.",
        },
      });
    }
    return {
      submission: await options.submissionService.performSubmissionOwnerAction({
        actor,
        submissionId: parseSubmissionIdParam(request.params),
        ...parseSubmissionOwnerActionInput(request.body),
      }),
    };
  });

  app.post("/v1/submissions", { bodyLimit: SUBMISSION_BODY_LIMIT_BYTES }, async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.submissionService) {
      throw new AppError("Submission service is not configured.", "SUBMISSION_SERVICE_UNAVAILABLE", 503);
    }
    const actor = await authenticateActor(options.authService, requestAuthorization(request), "skills:submit", { mfaRequired: true });
    if (!actor) {
      return reply.code(401).send({
        error: {
          code: "AUTHENTICATION_REQUIRED",
          message: "Authentication is required.",
        },
      });
    }
    const input = await parseSubmissionInput(request.body);
    const submission = await options.submissionService.createSubmission({
      actor,
      manifest: input.manifest,
      files: input.files,
    });
    return reply.code(202).send(submissionResponse(submission));
  });

  app.get("/v1/review/submissions", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.submissionService) {
      throw new AppError("Submission service is not configured.", "SUBMISSION_SERVICE_UNAVAILABLE", 503);
    }
    const actor = await authenticateActor(options.authService, requestAuthorization(request), "review:read", { mfaRequired: true });
    if (!actor) {
      return reply.code(401).send({
        error: {
          code: "AUTHENTICATION_REQUIRED",
          message: "Authentication is required.",
        },
      });
    }
    const submissions = await options.submissionService.listReviewSubmissions(actor);
    return { submissions };
  });

  app.get("/v1/review/submissions/:id/bundle", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.submissionService) {
      throw new AppError("Submission service is not configured.", "SUBMISSION_SERVICE_UNAVAILABLE", 503);
    }
    const actor = await authenticateActor(options.authService, requestAuthorization(request), "review:read", { mfaRequired: true });
    if (!actor) {
      return reply.code(401).send({
        error: {
          code: "AUTHENTICATION_REQUIRED",
          message: "Authentication is required.",
        },
      });
    }
    const bundle = await options.submissionService.getReviewSubmissionBundle({
      actor,
      submissionId: parseSubmissionIdParam(request.params),
      ...parseBundleQuery(request.query),
    });
    if (!bundle) {
      return reply.code(404).send({
        error: {
          code: "SUBMISSION_NOT_FOUND",
          message: "Submission not found.",
        },
      });
    }
    return reply
      .header(REVIEW_ARTIFACT_HASH_HEADER, bundle.artifact.sha256)
      .type(bundle.artifact.contentType)
      .send(bundle.payload);
  });

  app.post("/v1/review/submissions/:id/actions", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.submissionService) {
      throw new AppError("Submission service is not configured.", "SUBMISSION_SERVICE_UNAVAILABLE", 503);
    }
    const actor = await authenticateActor(options.authService, requestAuthorization(request), "review:write", { mfaRequired: true });
    if (!actor) {
      return reply.code(401).send({
        error: {
          code: "AUTHENTICATION_REQUIRED",
          message: "Authentication is required.",
        },
      });
    }
    const result = await options.submissionService.performReviewAction({
      actor,
      submissionId: parseSubmissionIdParam(request.params),
      ...parseReviewActionInput(request.body),
    });
    return reply.send({ submission: result });
  });

  return app;
}

async function authenticateActor(
  authService: AuthService,
  authorization: string | undefined,
  scope: ApiTokenScope,
  options: { mfaRequired?: boolean } = {},
): Promise<SubmissionActor | null> {
  const context = await authService.authenticateRequest(authorization);
  if (!context) {
    return null;
  }
  requireScope(context, scope);
  if (options.mfaRequired && requiresMfaForRole(context) && !context.user.mfaVerified) {
    throw new AppError("MFA verification is required.", "MFA_VERIFICATION_REQUIRED", 403);
  }
  return {
    id: context.user.id,
    roles: context.user.roles,
  };
}

async function authenticateArchitectureSession(
  options: BuildAppOptions,
  request: { headers: { authorization?: string | string[]; cookie?: string | string[] } },
  reply: FastifyReply,
  authOptions: { mfaRequired?: boolean } = {},
) {
  if (!options.authService) {
    throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
  }
  const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
  if (!user) {
    await authFailureReply(options.authService, requestAuthorization(request), reply);
    return null;
  }
  if (authOptions.mfaRequired) {
    requireMfaForPrivilegedSession(user);
  }
  return user;
}

async function authenticateArchitectureTargetSession(
  options: BuildAppOptions,
  request: { headers: { authorization?: string | string[]; cookie?: string | string[] } },
  reply: FastifyReply,
  authOptions: { mfaRequired?: boolean } = {},
) {
  if (!options.authService) {
    throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
  }
  if (!options.architectureTargetService) {
    throw new AppError("Architecture target service is not configured.", "ARCHITECTURE_TARGET_SERVICE_UNAVAILABLE", 503);
  }
  const user = await authenticateSessionUser(options.authService, requestAuthorization(request));
  if (!user) {
    await authFailureReply(options.authService, requestAuthorization(request), reply);
    return null;
  }
  if (authOptions.mfaRequired) {
    requireMfaForPrivilegedSession(user);
  }
  return user;
}

function requireArchitectureStore(options: BuildAppOptions): ArchitectureStore {
  if (!options.architectureStore) {
    throw new AppError("Architecture service is not configured.", "ARCHITECTURE_SERVICE_UNAVAILABLE", 503);
  }
  return options.architectureStore;
}

function requireArchitectureTargetService(options: BuildAppOptions): ArchitectureTargetService {
  if (!options.architectureTargetService) {
    throw new AppError("Architecture target service is not configured.", "ARCHITECTURE_TARGET_SERVICE_UNAVAILABLE", 503);
  }
  return options.architectureTargetService;
}

function requireArchitectureOrganizationGrantService(options: BuildAppOptions): ArchitectureOrganizationGrantService {
  if (!options.architectureOrganizationGrantService) {
    throw new AppError(
      "Architecture organization grant service is not configured.",
      "ARCHITECTURE_ORGANIZATION_GRANT_SERVICE_UNAVAILABLE",
      503,
    );
  }
  return options.architectureOrganizationGrantService;
}

function requireArchitecturePatternMigrationService(options: BuildAppOptions): ArchitecturePatternMigrationService {
  if (!options.architecturePatternMigrationService) {
    throw new AppError(
      "Architecture pattern migration service is not configured.",
      "ARCHITECTURE_PATTERN_MIGRATION_SERVICE_UNAVAILABLE",
      503,
    );
  }
  return options.architecturePatternMigrationService;
}

function requireOrganizationService(options: BuildAppOptions): OrganizationService {
  if (!options.organizationService) {
    throw new AppError("Organization service is not configured.", "ORGANIZATION_SERVICE_UNAVAILABLE", 503);
  }
  return options.organizationService;
}

async function authenticateArchitectureReader(
  options: BuildAppOptions,
  request: { headers: { authorization?: string | string[]; cookie?: string | string[] } },
  reply: FastifyReply,
) {
  if (!options.authService) {
    throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
  }
  if (!options.architectureStore) {
    throw new AppError("Architecture service is not configured.", "ARCHITECTURE_SERVICE_UNAVAILABLE", 503);
  }
  const authorization = requestAuthorization(request);
  const context = await options.authService.authenticateRequest(authorization);
  if (!context) {
    await authFailureReply(options.authService, authorization, reply);
    return null;
  }
  requireScope(context, "architectures:read");
  return context.user;
}

async function enforceArchitectureProjectionRateLimit(
  limiter: AuthRateLimiter,
  userId: string,
  reply: FastifyReply,
): Promise<boolean> {
  const result = await limiter.consume(`architecture:projection:${userId}`);
  if (result.allowed) return true;
  reply
    .header("retry-after", String(result.retryAfterSeconds))
    .code(429)
    .send({
      error: {
        code: "ARCHITECTURE_RATE_LIMITED",
        message: "Architecture projection rate limit exceeded.",
        details: { retryAfterSeconds: result.retryAfterSeconds },
      },
    });
  return false;
}

function acquireArchitectureProjectionSlot(
  inFlight: Map<string, number>,
  maximum: number,
  userId: string,
  reply: FastifyReply,
): boolean {
  const current = inFlight.get(userId) ?? 0;
  if (current >= maximum) {
    reply.code(429).send({
      error: {
        code: "ARCHITECTURE_CONCURRENCY_LIMITED",
        message: "Too many architecture projections are already running.",
      },
    });
    return false;
  }
  inFlight.set(userId, current + 1);
  return true;
}

function releaseArchitectureProjectionSlot(inFlight: Map<string, number>, userId: string): void {
  const remaining = (inFlight.get(userId) ?? 1) - 1;
  if (remaining <= 0) inFlight.delete(userId);
  else inFlight.set(userId, remaining);
}

async function compileAuthorizedArchitecture(
  options: BuildAppOptions,
  actorId: string,
  spec: ArchitectureSpecV1,
  selection: { profileId?: string; environmentId?: string },
  scope?: ArchitectureResolutionScope,
) {
  const registry = await resolveAuthorizedArchitectureRegistry(
    architectureReleaseDependencies(options),
    actorId,
    spec,
    scope,
  );
  return compileArchitecture(spec, registry, selection);
}

function architectureReleaseDependencies(options: BuildAppOptions) {
  if (!options.submissionService) {
    throw new AppError("Architecture release resolution is not configured.", "ARCHITECTURE_REGISTRY_RESOLVER_UNAVAILABLE", 503);
  }
  return {
    skillRepository: options.skillRepository,
    submissionService: options.submissionService,
  };
}

function architectureResolutionScope(
  architecture: Pick<ArchitectureRecord, "owner" | "access">,
  organizationId?: string,
): ArchitectureResolutionScope {
  return {
    ...(architecture.owner.type === "team" ? { teamId: architecture.owner.id } : {}),
    organizationIds: organizationId === undefined
      ? architecture.access.allowedOrganizationIds ?? []
      : [organizationId],
  };
}

function architectureProjectionOrganizationId(
  architecture: Pick<ArchitectureRecord, "access">,
  requestedOrganizationId: string | undefined,
): string | undefined {
  const allowedOrganizationIds = architecture.access.allowedOrganizationIds ?? [];
  if (requestedOrganizationId !== undefined && !allowedOrganizationIds.includes(requestedOrganizationId)) {
    throw new AppError(
      "The organization context is unavailable for this architecture.",
      "ARCHITECTURE_ORGANIZATION_CONTEXT_NOT_AVAILABLE",
      404,
    );
  }
  if (architectureAccessIsOrganizationOnly(architecture) && requestedOrganizationId === undefined) {
    throw new AppError(
      "An organization context is required for this architecture preview.",
      "ARCHITECTURE_ORGANIZATION_CONTEXT_REQUIRED",
      400,
    );
  }
  return requestedOrganizationId;
}

function toArchitectureRevisionSummary(revision: {
  id: string;
  architectureId: string;
  revisionNumber: number;
  message: string;
  spec: ArchitectureSpecV1;
  createdAt: string;
}) {
  return {
    id: revision.id,
    architectureId: revision.architectureId,
    revisionNumber: revision.revisionNumber,
    message: revision.message,
    patternId: revision.spec.pattern.id,
    nodeCount: revision.spec.nodes.length,
    skillCount: revision.spec.skills.length,
    createdAt: revision.createdAt,
  };
}

/** Keep persistence internals and a full target revision out of the HTTP DTO. */
function toArchitecturePatternMigrationResponse(result: ArchitecturePatternMigrationCreateResult) {
  if (!result.persisted) return result;
  return {
    ...result,
    persisted: {
      targetArchitecture: result.persisted.targetArchitecture,
      targetRevision: toArchitectureRevisionSummary(result.persisted.targetRevision),
      lineage: result.persisted.lineage,
    },
  };
}

function architectureNotFound(reply: FastifyReply) {
  return reply.code(404).send({
    error: {
      code: "ARCHITECTURE_NOT_FOUND",
      message: "Architecture not found.",
    },
  });
}

function architectureAccessIsOrganizationOnly(architecture: Pick<ArchitectureRecord, "access">): boolean {
  return architecture.access.reasons.length === 1 && architecture.access.reasons[0] === "organization";
}

function architectureTargetNotFound(reply: FastifyReply) {
  return reply.code(404).send({
    error: {
      code: "ARCHITECTURE_TARGET_NOT_FOUND",
      message: "Architecture target not found.",
    },
  });
}

function organizationNotFound(reply: FastifyReply) {
  return reply.code(404).send({
    error: {
      code: "ORGANIZATION_NOT_FOUND",
      message: "Organization not found.",
    },
  });
}

async function authenticateOptionalActor(
  authService: AuthService | undefined,
  authorization: string | undefined,
  scope: ApiTokenScope,
): Promise<SubmissionActor | null> {
  if (!authService || !hasBearerAuthorization(authorization)) {
    return null;
  }
  const context = await authService.authenticateRequest(authorization);
  if (!context) {
    return null;
  }
  requireScope(context, scope);
  return {
    id: context.user.id,
    roles: context.user.roles,
  };
}

function requiresMfaForRole(context: AuthContext): boolean {
  return context.user.roles.some((role) => role === "owner" || role === "admin" || role === "maintainer");
}

function requireMfaForPrivilegedSession(user: { roles: string[]; mfaVerified: boolean }): void {
  if (user.roles.some((role) => role === "owner" || role === "admin" || role === "maintainer") && !user.mfaVerified) {
    throw new AppError("MFA verification is required.", "MFA_VERIFICATION_REQUIRED", 403);
  }
}

function requireMfaForSession(user: { mfaVerified: boolean }): void {
  if (!user.mfaVerified) {
    throw new AppError("MFA verification is required.", "MFA_VERIFICATION_REQUIRED", 403);
  }
}

async function requireMfaForTeamOwner(
  teamService: TeamService,
  user: { id: string; email: string; mfaVerified: boolean },
  teamId: string,
): Promise<void> {
  const dashboard = await teamService.listDashboard({ id: user.id, email: user.email });
  const team = dashboard.teams.find((candidate) => candidate.id === teamId);
  if (team?.role === "owner") requireMfaForSession(user);
}

function skillSharingExpandsTeamOrOrganizationVisibility(input: {
  visibility: VisibilityScope;
  teamIds?: readonly string[];
  organizationIds?: readonly string[];
}): boolean {
  return input.visibility === "team"
    || input.visibility === "organization"
    || (input.teamIds?.length ?? 0) > 0
    || (input.organizationIds?.length ?? 0) > 0;
}

function requireMfaForOrganizationSession(user: { mfaVerified: boolean }): void {
  if (!user.mfaVerified) {
    throw new AppError("MFA verification is required.", "MFA_VERIFICATION_REQUIRED", 403);
  }
}

async function authenticateOptionalRegistryReader(authService: AuthService | undefined, authorization: string | undefined) {
  if (!authService || !hasBearerAuthorization(authorization)) {
    return null;
  }
  const context = await authService.authenticateRequest(authorization);
  if (!context) {
    return null;
  }
  requireScope(context, "skills:read");
  return context.user;
}

async function authenticateSessionUser(authService: AuthService, authorization: string | undefined) {
  return authService.authenticateSessionAuthorizationHeader(authorization);
}

async function authFailureReply(authService: AuthService, authorization: string | undefined, reply: FastifyReply) {
  const context = await authService.authenticateRequest(authorization);
  if (context?.credential.kind === "api_token") {
    return reply.code(403).send({
      error: {
        code: "SESSION_AUTH_REQUIRED",
        message: "Session authentication is required.",
      },
    });
  }
  return reply.code(401).send({
    error: {
      code: "AUTHENTICATION_REQUIRED",
      message: "Authentication is required.",
    },
  });
}

function requireScope(context: AuthContext, scope: ApiTokenScope): void {
  if (context.credential.kind === "session") {
    return;
  }
  if (!context.credential.scopes.includes(scope)) {
    throw new AppError("API token scope is required.", "API_TOKEN_SCOPE_REQUIRED", 403, { scope });
  }
}

function hasBearerAuthorization(authorization: string | undefined): boolean {
  if (!authorization || authorization.length < 8 || authorization.length > 7 + 256) {
    return false;
  }
  if (authorization.slice(0, 6).toLowerCase() !== "bearer" || !isAsciiWhitespace(authorization.charCodeAt(6))) {
    return false;
  }
  let index = 6;
  while (index < authorization.length && isAsciiWhitespace(authorization.charCodeAt(index))) {
    index += 1;
  }
  return index < authorization.length;
}

function isAsciiWhitespace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

function isSafeRequestMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function requestAuthorization(request: { headers: { authorization?: string | string[]; cookie?: string | string[] } }): string | undefined {
  const authorization = firstHeader(request.headers.authorization);
  if (authorization) {
    return authorization;
  }
  const token = sessionCookieToken(request.headers.cookie);
  return token ? `Bearer ${token}` : undefined;
}

function cookieSessionResponse<T extends object>(
  request: { headers: Record<string, string | string[] | undefined> },
  result: T,
): T | Omit<T & { token: string }, "token"> {
  const token = (result as { token?: unknown }).token;
  if (firstHeader(request.headers[COOKIE_SESSION_RESPONSE_HEADER])?.toLowerCase() !== "cookie" || typeof token !== "string") {
    return result;
  }
  const { token: _token, ...response } = result as T & { token: string };
  return response;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.find((item) => item.trim())?.trim();
  }
  return value?.trim() || undefined;
}

function sessionCookieToken(cookieHeader: string | string[] | undefined): string | null {
  const header = Array.isArray(cookieHeader) ? cookieHeader.join(";") : cookieHeader;
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const [rawName, ...rawValueParts] = part.trim().split("=");
    if (rawName !== SESSION_COOKIE_NAME) {
      continue;
    }
    const rawValue = rawValueParts.join("=");
    if (!rawValue) {
      return null;
    }
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return null;
}

function setSessionCookie(reply: FastifyReply, token: string, expiresAt: string): void {
  const expires = new Date(expiresAt);
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
  ];
  if (!Number.isNaN(expires.getTime())) {
    attributes.push(`Expires=${expires.toUTCString()}`);
    attributes.push(`Max-Age=${Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000))}`);
  }
  if (process.env.NODE_ENV === "production") {
    attributes.push("Secure");
  }
  reply.header("set-cookie", attributes.join("; "));
}

function clearSessionCookie(reply: FastifyReply): void {
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (process.env.NODE_ENV === "production") {
    attributes.push("Secure");
  }
  reply.header("set-cookie", attributes.join("; "));
}

function parseRegisterInput(input: unknown): RegisterInput {
  const body = parseJsonObject(input);
  return {
    email: requiredString(body.email, "email"),
    password: requiredString(body.password, "password"),
    name: optionalString(body.name, "name"),
    inviteToken: optionalString(body.inviteToken, "inviteToken"),
  };
}

function parseLoginInput(input: unknown): LoginInput {
  const body = parseJsonObject(input);
  return {
    email: requiredString(body.email, "email"),
    password: requiredString(body.password, "password"),
  };
}

function parseEmailVerificationRequestInput(input: unknown): RequestEmailVerificationInput {
  const body = parseJsonObject(input);
  return {
    email: requiredString(body.email, "email"),
  };
}

function parseEmailVerificationConfirmInput(input: unknown): ConfirmEmailVerificationInput {
  const body = parseJsonObject(input);
  return {
    token: requiredString(body.token, "token"),
  };
}

function parsePasswordResetRequestInput(input: unknown): RequestPasswordResetInput {
  const body = parseJsonObject(input);
  return {
    email: requiredString(body.email, "email"),
  };
}

function parsePasswordResetConfirmInput(input: unknown): ConfirmPasswordResetInput {
  const body = parseJsonObject(input);
  return {
    token: requiredString(body.token, "token"),
    password: requiredString(body.password, "password"),
  };
}

function parseChangePasswordInput(input: unknown): ChangePasswordInput {
  const body = parseJsonObject(input);
  return {
    currentPassword: requiredString(body.currentPassword, "currentPassword"),
    password: requiredString(body.password, "password"),
  };
}

function parseEmailChangeRequestInput(input: unknown): RequestEmailChangeInput {
  const body = parseJsonObject(input);
  return {
    email: requiredString(body.email, "email"),
    password: requiredString(body.password, "password"),
  };
}

function parseEmailChangeConfirmInput(input: unknown): ConfirmEmailChangeInput {
  const body = parseJsonObject(input);
  return {
    token: requiredString(body.token, "token"),
  };
}

function parseVerifyMfaChallengeInput(input: unknown): VerifyMfaChallengeInput {
  const body = parseJsonObject(input);
  const code = optionalString(body.code, "code");
  const recoveryCode = optionalString(body.recoveryCode, "recoveryCode");
  if (Boolean(code) === Boolean(recoveryCode)) {
    throw new AppError("Exactly one MFA code is required.", "INVALID_MFA_REQUEST", 400);
  }
  return {
    challengeToken: requiredString(body.challengeToken, "challengeToken"),
    code,
    recoveryCode,
  };
}

function parseStartTotpEnrollmentInput(input: unknown): StartTotpEnrollmentInput {
  const body = parseJsonObject(input);
  return {
    password: requiredString(body.password, "password"),
    label: optionalString(body.label, "label"),
  };
}

function parseConfirmTotpEnrollmentInput(input: unknown): ConfirmTotpEnrollmentInput {
  const body = parseJsonObject(input);
  return {
    factorId: requiredString(body.factorId, "factorId"),
    code: requiredString(body.code, "code"),
  };
}

function parseDisableTotpMfaInput(input: unknown): DisableTotpMfaInput {
  const body = parseJsonObject(input);
  return {
    password: requiredString(body.password, "password"),
  };
}

function parseUpdateRegistrationSettingsInput(input: unknown): UpdateRegistrationSettingsInput {
  const body = parseJsonObject(input);
  const mode = requiredString(body.mode, "mode");
  if (mode !== "closed" && mode !== "request" && mode !== "open") {
    throw new AppError("Registration mode is invalid.", "INVALID_REGISTRATION_MODE", 400);
  }
  return { mode };
}

function parseCreateRegistrationInvitationInput(input: unknown): CreateRegistrationInvitationInput {
  const body = parseJsonObject(input);
  return {
    email: requiredString(body.email, "email"),
    name: optionalString(body.name, "name"),
  };
}

function parseSharingSettingsInput(input: unknown): Omit<SharingSettings, "organizationVisibilityEnabled"> & {
  organizationVisibilityEnabled?: boolean;
} {
  const body = parseJsonObject(input);
  rejectFields(body, [
    "publicVisibilityEnabled",
    "authenticatedVisibilityEnabled",
    "teamsEnabled",
    "teamVisibilityEnabled",
    "userVisibilityEnabled",
    "organizationVisibilityEnabled",
  ], "SHARING_SETTINGS_FIELD");
  return {
    publicVisibilityEnabled: requiredBoolean(body.publicVisibilityEnabled, "publicVisibilityEnabled"),
    authenticatedVisibilityEnabled: requiredBoolean(body.authenticatedVisibilityEnabled, "authenticatedVisibilityEnabled"),
    teamsEnabled: requiredBoolean(body.teamsEnabled, "teamsEnabled"),
    teamVisibilityEnabled: requiredBoolean(body.teamVisibilityEnabled, "teamVisibilityEnabled"),
    userVisibilityEnabled: requiredBoolean(body.userVisibilityEnabled, "userVisibilityEnabled"),
    ...(Object.prototype.hasOwnProperty.call(body, "organizationVisibilityEnabled")
      ? { organizationVisibilityEnabled: requiredBoolean(body.organizationVisibilityEnabled, "organizationVisibilityEnabled") }
      : {}),
  };
}

function parseUpdateSkillSharingInput(input: unknown): {
  visibility: VisibilityScope;
  teamIds?: string[];
  userEmails?: string[];
  organizationIds?: string[];
} {
  const body = parseJsonObject(input);
  rejectFields(body, ["visibility", "teamIds", "userEmails", "organizationIds"], "SKILL_SHARING_FIELD");
  return {
    visibility: parseVisibilityScope(body.visibility),
    ...(Object.prototype.hasOwnProperty.call(body, "teamIds")
      ? { teamIds: parseStringArray(body.teamIds, "teamIds") }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(body, "userEmails")
      ? { userEmails: parseStringArray(body.userEmails, "userEmails") }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(body, "organizationIds")
      ? { organizationIds: parseStringArray(body.organizationIds, "organizationIds") }
      : {}),
  };
}

function parseCreateOrganizationInput(input: unknown): {
  name: string;
  slug?: string;
  policy?: OrganizationPolicyV1Input;
  reason?: string;
} {
  const body = parseJsonObject(input);
  rejectFields(body, ["name", "slug", "policy", "reason"], "ORGANIZATION_FIELD");
  return {
    name: requiredString(body.name, "name"),
    slug: optionalString(body.slug, "slug"),
    policy: body.policy === undefined ? undefined : parseJsonObject(body.policy),
    reason: optionalString(body.reason, "reason"),
  };
}

function parseOrganizationInvitationInput(input: unknown): {
  email: string;
  role?: OrganizationMembershipRole;
} {
  const body = parseJsonObject(input);
  rejectFields(body, ["email", "role"], "ORGANIZATION_INVITATION_FIELD");
  const role = body.role === undefined ? undefined : parseOrganizationMembershipRole(body.role);
  return {
    email: requiredString(body.email, "email"),
    ...(role === undefined ? {} : { role }),
  };
}

function parseOrganizationMemberRoleInput(paramsInput: unknown, bodyInput: unknown): {
  organizationId: string;
  memberId: string;
  role: OrganizationMembershipRole;
} {
  const body = parseJsonObject(bodyInput);
  rejectFields(body, ["role"], "ORGANIZATION_MEMBER_FIELD");
  return {
    organizationId: parseOrganizationIdParam(paramsInput),
    memberId: parseOpaqueIdParam(paramsInput, "memberId"),
    role: parseOrganizationMembershipRole(body.role),
  };
}

function parseOrganizationMemberParams(input: unknown): {
  organizationId: string;
  memberId: string;
} {
  return {
    organizationId: parseOrganizationIdParam(input),
    memberId: parseOpaqueIdParam(input, "memberId"),
  };
}

function parseAppendOrganizationPolicyInput(input: unknown): {
  policy: OrganizationPolicyV1Input;
  reason?: string;
} {
  const body = parseJsonObject(input);
  rejectFields(body, ["policy", "reason"], "ORGANIZATION_POLICY_FIELD");
  return {
    policy: parseJsonObject(body.policy),
    reason: optionalString(body.reason, "reason"),
  };
}

function parseOrganizationPolicyActionInput(input: unknown): { action: "activate" } {
  const body = parseJsonObject(input);
  rejectFields(body, ["action"], "ORGANIZATION_POLICY_ACTION_FIELD");
  const action = requiredString(body.action, "action");
  if (action !== "activate") {
    throw new AppError("Organization policy action must be activate.", "INVALID_ORGANIZATION_POLICY_ACTION", 400);
  }
  return { action };
}

function parseOrganizationArchiveActionInput(input: unknown): { action: "archive" } {
  const body = parseJsonObject(input);
  rejectFields(body, ["action"], "ORGANIZATION_ACTION_FIELD");
  const action = requiredString(body.action, "action");
  if (action !== "archive") {
    throw new AppError("Organization action must be archive.", "INVALID_ORGANIZATION_ACTION", 400);
  }
  return { action };
}

function parseOrganizationChildTeamInput(input: unknown): { name: string; slug?: string } {
  const body = parseJsonObject(input);
  rejectFields(body, ["name", "slug"], "ORGANIZATION_TEAM_FIELD");
  return {
    name: requiredString(body.name, "name"),
    slug: optionalString(body.slug, "slug"),
  };
}

function parseOrganizationTeamAdoptionInput(input: unknown): { organizationId: string } {
  const body = parseJsonObject(input);
  rejectFields(body, ["organizationId"], "ORGANIZATION_TEAM_ADOPTION_FIELD");
  return { organizationId: parseOrganizationIdentifier(body.organizationId, "organizationId") };
}

function parseOrganizationEmptyInput(input: unknown): void {
  if (input === undefined) return;
  const body = parseJsonObject(input);
  rejectFields(body, [], "ORGANIZATION_ACCEPT_FIELD");
}

function parseOrganizationMembershipRole(input: unknown): OrganizationMembershipRole {
  const role = requiredString(input, "role");
  if (role !== "owner" && role !== "admin" && role !== "member") {
    throw new AppError("Organization member role is invalid.", "INVALID_ORGANIZATION_MEMBER_ROLE", 400);
  }
  return role;
}

function rejectFields(body: Record<string, unknown>, allowed: readonly string[], codePrefix: string): void {
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(body).find((key) => !allowedSet.has(key));
  if (unsupported) {
    throw new AppError(`Request field is not accepted: ${unsupported}.`, `UNSUPPORTED_${codePrefix}`, 400);
  }
}

function parseSkillMetadataUpdateInput(input: unknown): { update: SkillMetadataUpdate; visibility?: VisibilityScope; reason?: string } {
  const body = parseJsonObject(input);
  const visibility = "visibility" in body ? parseVisibilityScope(body.visibility) : undefined;
  const update: SkillMetadataUpdate = {};
  if ("title" in body) {
    update.title = requiredString(body.title, "title").trim();
  }
  if ("summary" in body) {
    update.summary = requiredString(body.summary, "summary").trim();
  }
  if ("tags" in body) {
    update.tags = parseStringArray(body.tags, "tags").map((tag) => tag.trim()).filter(Boolean);
  }
  if (Object.keys(update).length === 0 && visibility === undefined) {
    throw new AppError("At least one skill metadata field is required.", "SKILL_METADATA_UPDATE_REQUIRED", 400);
  }
  return {
    update,
    ...(visibility === undefined ? {} : { visibility }),
    reason: optionalString(body.reason, "reason"),
  };
}

function parseSubmissionOwnerActionInput(input: unknown): { action: SubmissionOwnerAction; reason?: string } {
  const body = parseJsonObject(input);
  const action = requiredString(body.action, "action");
  if (action !== "withdraw") {
    throw new AppError("Unsupported submission action.", "INVALID_SUBMISSION_ACTION", 400);
  }
  return {
    action,
    reason: optionalString(body.reason, "reason"),
  };
}

function parseSkillLifecycleActionInput(input: unknown): { action: SkillLifecycleAction; reason?: string } {
  const body = parseJsonObject(input);
  const action = requiredString(body.action, "action");
  if (action !== "archive" && action !== "restore" && action !== "delete") {
    throw new AppError("Unsupported skill action.", "INVALID_SKILL_ACTION", 400);
  }
  return {
    action,
    reason: optionalString(body.reason, "reason"),
  };
}

function parseReleaseLifecycleActionInput(input: unknown): { action: ReleaseLifecycleAction; reason?: string; replacement?: string } {
  const body = parseJsonObject(input);
  const action = requiredString(body.action, "action");
  if (action !== "deprecate" && action !== "unpublish" && action !== "revoke" && action !== "restore" && action !== "delete") {
    throw new AppError("Unsupported release action.", "INVALID_RELEASE_ACTION", 400);
  }
  return {
    action,
    reason: optionalString(body.reason, "reason"),
    replacement: optionalString(body.replacement, "replacement"),
  };
}

function parseCreateArchitectureInput(input: unknown): {
  name: string;
  description: string;
  patternId: ReturnType<typeof validateArchitecturePattern>;
  owner?: { type: "user" } | { type: "team"; id: string };
} {
  const body = parseJsonObject(input);
  rejectArchitectureFields(body, ["name", "description", "patternId", "owner"]);
  const name = requiredString(body.name, "name").trim();
  const description = optionalString(body.description, "description")?.trim() ?? "";
  if (name.length > 120 || description.length > 500) {
    throw new AppError("Architecture name or description is too long.", "INVALID_ARCHITECTURE_METADATA", 400);
  }
  return {
    name,
    description,
    patternId: validateArchitecturePattern(body.patternId),
    owner: parseCreateArchitectureOwner(body.owner),
  };
}

function parseCreateArchitectureOwner(input: unknown): { type: "user" } | { type: "team"; id: string } | undefined {
  if (input === undefined) return undefined;
  const owner = parseJsonObject(input);
  const type = requiredString(owner.type, "owner.type");
  if (type === "user") {
    rejectArchitectureFields(owner, ["type"]);
    return { type };
  }
  if (type === "team") {
    rejectArchitectureFields(owner, ["type", "id"]);
    return { type, id: optionalArchitectureIdentifier(owner.id, "owner.id") ?? "" };
  }
  throw new AppError("Architecture owner type must be user or team.", "INVALID_ARCHITECTURE_OWNER", 400);
}

function parseCreateArchitectureRevisionInput(
  input: unknown,
  architecture: Pick<ArchitectureRecord, "id" | "name" | "description" | "patternId" | "currentRevisionId">,
): {
  message: string;
  spec: ReturnType<typeof validateArchitectureSpec>;
  expectedCurrentRevisionId: string | null;
} {
  const body = parseJsonObject(input);
  rejectArchitectureFields(body, ["message", "spec", "expectedCurrentRevisionId"]);
  if (!Object.prototype.hasOwnProperty.call(body, "expectedCurrentRevisionId")) {
    throw new AppError("expectedCurrentRevisionId is required.", "INVALID_REQUEST_BODY", 400);
  }
  const message = optionalString(body.message, "message")?.trim() ?? "";
  if (message.length > 500) {
    throw new AppError("Revision message is too long.", "INVALID_ARCHITECTURE_METADATA", 400);
  }
  const rawSpec = body.spec && typeof body.spec === "object" && !Array.isArray(body.spec)
    ? body.spec as Record<string, unknown>
    : body.spec;
  const result: {
    message: string;
    spec: ReturnType<typeof validateArchitectureSpec>;
    expectedCurrentRevisionId: string | null;
  } = {
    message,
    expectedCurrentRevisionId: null,
    spec: validateArchitectureSpec(
      rawSpec && typeof rawSpec === "object"
        ? {
          ...rawSpec,
          id: architecture.id,
          name: architecture.name,
          description: architecture.description || undefined,
          pattern: { id: architecture.patternId, version: 1 },
        }
        : rawSpec,
      architecture.patternId,
    ),
  };
  const expectedCurrentRevisionId = body.expectedCurrentRevisionId === null
    ? null
    : optionalArchitectureIdentifier(body.expectedCurrentRevisionId, "expectedCurrentRevisionId");
  if (expectedCurrentRevisionId === undefined) {
    throw new AppError("expectedCurrentRevisionId must be null or a valid identifier.", "INVALID_REQUEST_BODY", 400);
  }
  result.expectedCurrentRevisionId = expectedCurrentRevisionId;
  if (result.expectedCurrentRevisionId === null && architecture.currentRevisionId) {
    // A null token describes an empty shell. Once a revision exists, require
    // the caller to echo the current pointer so stale drafts fail explicitly.
    throw new AppError(
      "expectedCurrentRevisionId must match the current revision.",
      "ARCHITECTURE_REVISION_CONFLICT",
      409,
      { currentRevisionId: architecture.currentRevisionId },
    );
  }
  return result;
}

function parseArchitectureDraftPreviewInput(
  input: unknown,
  architecture: Pick<ArchitectureRecord, "id" | "name" | "description" | "patternId">,
): {
  expectedCurrentRevisionId: string | null;
  spec: ReturnType<typeof validateArchitectureSpec>;
  profileId?: string;
  environmentId?: string;
  fixture?: unknown;
  fixtureProvided: boolean;
} {
  const body = parseJsonObject(input);
  rejectArchitectureFields(body, ["spec", "expectedCurrentRevisionId", "profileId", "environmentId", "fixture"]);
  if (!Object.prototype.hasOwnProperty.call(body, "spec")) {
    throw new AppError("spec is required.", "INVALID_REQUEST_BODY", 400);
  }
  if (!Object.prototype.hasOwnProperty.call(body, "expectedCurrentRevisionId")) {
    throw new AppError("expectedCurrentRevisionId is required.", "INVALID_REQUEST_BODY", 400);
  }
  const expectedCurrentRevisionId = body.expectedCurrentRevisionId === null
    ? null
    : optionalArchitectureIdentifier(body.expectedCurrentRevisionId, "expectedCurrentRevisionId");
  if (expectedCurrentRevisionId === undefined) {
    throw new AppError("expectedCurrentRevisionId must be null or a valid identifier.", "INVALID_REQUEST_BODY", 400);
  }
  const rawSpec = body.spec && typeof body.spec === "object" && !Array.isArray(body.spec)
    ? body.spec as Record<string, unknown>
    : body.spec;
  return {
    expectedCurrentRevisionId,
    spec: validateArchitectureSpec(
      rawSpec && typeof rawSpec === "object"
        ? {
          ...rawSpec,
          id: architecture.id,
          name: architecture.name,
          description: architecture.description || undefined,
          pattern: { id: architecture.patternId, version: 1 },
        }
        : rawSpec,
      architecture.patternId,
    ),
    profileId: optionalArchitectureIdentifier(body.profileId, "profileId"),
    environmentId: optionalArchitectureIdentifier(body.environmentId, "environmentId"),
    fixture: body.fixture,
    fixtureProvided: Object.prototype.hasOwnProperty.call(body, "fixture"),
  };
}

function parseArchitectureProjectionInput(input: unknown): {
  revisionId?: string;
  profileId?: string;
  environmentId?: string;
  organizationId?: string;
  fixture?: unknown;
  fixtureProvided: boolean;
} {
  if (input === undefined) return { fixtureProvided: false };
  const body = parseJsonObject(input);
  rejectArchitectureFields(body, ["revisionId", "profileId", "environmentId", "organizationId", "fixture"]);
  return {
    revisionId: optionalArchitectureIdentifier(body.revisionId, "revisionId"),
    profileId: optionalArchitectureIdentifier(body.profileId, "profileId"),
    environmentId: optionalArchitectureIdentifier(body.environmentId, "environmentId"),
    organizationId: optionalArchitectureIdentifier(body.organizationId, "organizationId"),
    fixture: body.fixture,
    fixtureProvided: Object.prototype.hasOwnProperty.call(body, "fixture"),
  };
}

function parseReplaceArchitectureOrganizationGrantsInput(input: unknown): {
  expectedCurrentRevisionId: string | null;
  organizationIds: string[];
} {
  const body = parseJsonObject(input);
  rejectArchitectureFields(body, ["expectedCurrentRevisionId", "organizationIds"]);
  if (!Object.prototype.hasOwnProperty.call(body, "expectedCurrentRevisionId")) {
    throw new AppError("expectedCurrentRevisionId is required.", "INVALID_REQUEST_BODY", 400);
  }
  if (!Object.prototype.hasOwnProperty.call(body, "organizationIds")) {
    throw new AppError("organizationIds is required.", "INVALID_REQUEST_BODY", 400);
  }
  const expectedCurrentRevisionId = body.expectedCurrentRevisionId === null
    ? null
    : optionalArchitectureIdentifier(body.expectedCurrentRevisionId, "expectedCurrentRevisionId");
  if (expectedCurrentRevisionId === undefined) {
    throw new AppError(
      "expectedCurrentRevisionId must be null or a valid identifier.",
      "INVALID_REQUEST_BODY",
      400,
    );
  }
  if (!Array.isArray(body.organizationIds) || body.organizationIds.length > 500) {
    throw new AppError("organizationIds must be a bounded array.", "INVALID_REQUEST_BODY", 400);
  }
  const organizationIds = body.organizationIds.map((value) => {
    return parseOrganizationIdentifier(value, "organizationId");
  });
  if (new Set(organizationIds).size !== organizationIds.length) {
    throw new AppError("organizationIds must not contain duplicates.", "INVALID_REQUEST_BODY", 400);
  }
  return { expectedCurrentRevisionId, organizationIds };
}

function parseArchitecturePatternMigrationPreviewInput(input: unknown): {
  expectedCurrentRevisionId: string;
  targetPatternId: ReturnType<typeof validateArchitecturePattern>;
  mapping?: ArchitecturePatternMigrationMapping;
} {
  const body = parseJsonObject(input);
  rejectArchitectureFields(body, ["expectedCurrentRevisionId", "targetPatternId", "mapping"]);
  const expectedCurrentRevisionId = optionalArchitectureIdentifier(body.expectedCurrentRevisionId, "expectedCurrentRevisionId");
  if (!expectedCurrentRevisionId) {
    throw new AppError("expectedCurrentRevisionId is required.", "INVALID_REQUEST_BODY", 400);
  }
  const targetPatternId = validateArchitecturePattern(body.targetPatternId);
  const mapping = body.mapping === undefined ? undefined : parseArchitecturePatternMigrationMapping(body.mapping);
  return {
    expectedCurrentRevisionId,
    targetPatternId,
    ...(mapping === undefined ? {} : { mapping }),
  };
}

function parseArchitecturePatternMigrationCreateInput(input: unknown): {
  expectedCurrentRevisionId: string;
  targetPatternId: ReturnType<typeof validateArchitecturePattern>;
  mapping?: ArchitecturePatternMigrationMapping;
  idempotencyKey: string;
  name: string;
  description?: string;
  message?: string;
} {
  const body = parseJsonObject(input);
  rejectArchitectureFields(body, [
    "expectedCurrentRevisionId",
    "targetPatternId",
    "mapping",
    "idempotencyKey",
    "name",
    "description",
    "message",
  ]);
  const preview = parseArchitecturePatternMigrationPreviewInput({
    expectedCurrentRevisionId: body.expectedCurrentRevisionId,
    targetPatternId: body.targetPatternId,
    ...(body.mapping === undefined ? {} : { mapping: body.mapping }),
  });
  const idempotencyKey = optionalArchitectureIdentifier(body.idempotencyKey, "idempotencyKey");
  if (!idempotencyKey) {
    throw new AppError("idempotencyKey is required.", "INVALID_REQUEST_BODY", 400);
  }
  const name = parseArchitectureMigrationText(body.name, "name", 120, true);
  const description = body.description === undefined
    ? undefined
    : parseArchitectureMigrationText(body.description, "description", 500, false);
  const message = body.message === undefined
    ? undefined
    : parseArchitectureMigrationText(body.message, "message", 500, false);
  return {
    ...preview,
    idempotencyKey,
    name,
    ...(description === undefined ? {} : { description }),
    ...(message === undefined ? {} : { message }),
  };
}

function parseArchitecturePatternMigrationMapping(input: unknown): ArchitecturePatternMigrationMapping {
  const body = parseJsonObject(input);
  rejectArchitectureFields(body, ["rootRouterId", "rootLabel", "routerGroups", "allowUnassignedLeafFallback"]);
  const rootRouterId = optionalArchitectureIdentifier(body.rootRouterId, "mapping.rootRouterId");
  const rootLabel = body.rootLabel === undefined
    ? undefined
    : parseArchitectureMigrationText(body.rootLabel, "mapping.rootLabel", 160, false);
  const allowUnassignedLeafFallback = optionalBoolean(
    body.allowUnassignedLeafFallback,
    "mapping.allowUnassignedLeafFallback",
  );
  let routerGroups: ArchitecturePatternMigrationMapping["routerGroups"] | undefined;
  if (body.routerGroups !== undefined) {
    if (!Array.isArray(body.routerGroups) || body.routerGroups.length > 500) {
      throw new AppError("mapping.routerGroups must be a bounded array.", "INVALID_REQUEST_BODY", 400);
    }
    routerGroups = body.routerGroups.map((value, index) => parseArchitecturePatternMigrationRouterGroup(value, index));
  }
  const mapping: ArchitecturePatternMigrationMapping = {
    ...(rootRouterId === undefined ? {} : { rootRouterId }),
    ...(rootLabel === undefined ? {} : { rootLabel }),
    ...(routerGroups === undefined ? {} : { routerGroups }),
    ...(allowUnassignedLeafFallback === undefined ? {} : { allowUnassignedLeafFallback }),
  };
  if (Buffer.byteLength(JSON.stringify(mapping), "utf8") > 32_768) {
    throw new AppError("Pattern migration mapping is too large.", "INVALID_REQUEST_BODY", 413);
  }
  return mapping;
}

function parseArchitecturePatternMigrationRouterGroup(
  input: unknown,
  index: number,
): NonNullable<ArchitecturePatternMigrationMapping["routerGroups"]>[number] {
  const body = parseJsonObject(input);
  const prefix = `mapping.routerGroups[${index}]`;
  rejectArchitectureFields(body, ["id", "label", "parentRouterId", "leafNodeIds"]);
  const id = optionalArchitectureIdentifier(body.id, `${prefix}.id`);
  if (!id) throw new AppError(`${prefix}.id is required.`, "INVALID_REQUEST_BODY", 400);
  const label = parseArchitectureMigrationText(body.label, `${prefix}.label`, 160, true);
  const parentRouterId = body.parentRouterId === null
    ? null
    : optionalArchitectureIdentifier(body.parentRouterId, `${prefix}.parentRouterId`);
  if (body.parentRouterId !== undefined && body.parentRouterId !== null && parentRouterId === undefined) {
    throw new AppError(`${prefix}.parentRouterId is invalid.`, "INVALID_REQUEST_BODY", 400);
  }
  if (!Array.isArray(body.leafNodeIds) || body.leafNodeIds.length > 500) {
    throw new AppError(`${prefix}.leafNodeIds must be a bounded array.`, "INVALID_REQUEST_BODY", 400);
  }
  const leafNodeIds = body.leafNodeIds.map((value) => {
    const leafNodeId = optionalArchitectureIdentifier(value, `${prefix}.leafNodeIds`);
    if (!leafNodeId) throw new AppError(`${prefix}.leafNodeIds contains an invalid identifier.`, "INVALID_REQUEST_BODY", 400);
    return leafNodeId;
  });
  return {
    id,
    label,
    leafNodeIds,
    ...(parentRouterId === undefined ? {} : { parentRouterId }),
  };
}

function parseArchitectureMigrationText(value: unknown, field: string, maxLength: number, required: boolean): string {
  if (typeof value !== "string") {
    throw new AppError(`${field} must be a string.`, "INVALID_REQUEST_BODY", 400);
  }
  const normalized = value.trim();
  if ((required && normalized.length === 0) || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new AppError(`${field} is invalid.`, "INVALID_REQUEST_BODY", 400);
  }
  return normalized;
}

function parseRegisterArchitectureTargetInput(input: unknown): Omit<RegisterArchitectureTargetInput, "actor"> {
  const body = parseJsonObject(input);
  rejectFields(body, [
    "name",
    "owner",
    "architectureId",
    "environmentId",
    "profileId",
    "adapter",
    "capabilities",
    "identityDigest",
    "credentialReference",
    "metadata",
  ], "ARCHITECTURE_TARGET_FIELD");
  const owner = body.owner === undefined ? undefined : parseArchitectureTargetOwner(body.owner);
  const identityDigest = optionalString(body.identityDigest, "identityDigest");
  const credentialReference = body.credentialReference === null
    ? null
    : optionalString(body.credentialReference, "credentialReference");
  const metadata = body.metadata === undefined ? undefined : parseArchitectureTargetMetadata(body.metadata);
  return {
    name: requiredString(body.name, "name"),
    ...(owner === undefined ? {} : { owner }),
    architectureId: parseArchitectureTargetIdentifier(body.architectureId, "architectureId"),
    environmentId: parseArchitectureTargetIdentifier(body.environmentId, "environmentId"),
    profileId: parseArchitectureTargetIdentifier(body.profileId, "profileId"),
    adapter: parseArchitectureTargetAdapter(body.adapter),
    capabilities: parseArchitectureTargetCapabilities(body.capabilities),
    ...(identityDigest === undefined ? {} : { identityDigest }),
    ...(credentialReference === undefined ? {} : { credentialReference }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function parseArchitectureTargetOwner(input: unknown): ArchitectureTargetOwnerReference {
  const owner = parseJsonObject(input);
  rejectFields(owner, ["type", "id"], "ARCHITECTURE_TARGET_OWNER_FIELD");
  const type = requiredString(owner.type, "owner.type");
  if (type !== "user" && type !== "team" && type !== "organization") {
    throw new AppError("Architecture target owner type is invalid.", "INVALID_ARCHITECTURE_TARGET_OWNER", 400);
  }
  return {
    type,
    id: parseArchitectureTargetIdentifier(owner.id, "owner.id"),
  };
}

function parseArchitectureTargetAdapter(input: unknown): ArchitectureTargetAdapterDescriptor {
  const adapter = parseJsonObject(input);
  rejectFields(adapter, ["kind", "version", "contractVersion"], "ARCHITECTURE_TARGET_ADAPTER_FIELD");
  if (adapter.contractVersion !== 1) {
    throw new AppError("Architecture target adapter contract version must be 1.", "INVALID_ARCHITECTURE_TARGET_ADAPTER", 400);
  }
  return {
    kind: requiredString(adapter.kind, "adapter.kind").trim(),
    version: requiredString(adapter.version, "adapter.version").trim(),
    contractVersion: 1,
  };
}

function parseArchitectureTargetCapabilities(input: unknown): ArchitectureTargetCapabilities {
  const capabilities = parseJsonObject(input);
  rejectFields(capabilities, [
    "inventory.read",
    "health.read",
    "plan.read",
    "apply",
    "rollback",
    "sync.write",
  ], "ARCHITECTURE_TARGET_CAPABILITY_FIELD");
  for (const [key, value] of Object.entries(capabilities)) {
    if (typeof value !== "boolean") {
      throw new AppError(`Architecture target capability '${key}' must be boolean.`, "INVALID_ARCHITECTURE_TARGET_CAPABILITY", 400);
    }
  }
  return Object.fromEntries(Object.entries(capabilities)) as ArchitectureTargetCapabilities;
}

function parseArchitectureTargetMetadata(input: unknown): ArchitectureTargetMetadata {
  return structuredClone(parseJsonObject(input)) as ArchitectureTargetMetadata;
}

function parseArchitectureTargetConsentInput(input: unknown): { decision: ArchitectureTargetConsentDecision } {
  const body = parseJsonObject(input);
  rejectFields(body, ["decision"], "ARCHITECTURE_TARGET_CONSENT_FIELD");
  const decision = requiredString(body.decision, "decision");
  if (decision !== "grant" && decision !== "deny") {
    throw new AppError("Target consent decision must be grant or deny.", "INVALID_TARGET_CONSENT_DECISION", 400);
  }
  return { decision };
}

function parseArchitectureTargetObservationInput(
  input: unknown,
  routeTargetId: string,
): ArchitectureTargetObservationInput {
  const body = parseJsonObject(input);
  rejectFields(body, [
    "schemaVersion",
    "id",
    "targetId",
    "targetGeneration",
    "adapterDigest",
    "capabilitiesDigest",
    "observedAt",
    "skills",
    "configFindings",
    "promptAwareness",
    "metadata",
    "observedDigest",
  ], "ARCHITECTURE_TARGET_OBSERVATION_FIELD");
  return {
    ...(structuredClone(body) as Record<string, unknown>),
    targetId: body.targetId === undefined ? routeTargetId : body.targetId,
  } as ArchitectureTargetObservationInput;
}

function parseArchitectureTargetHealthInput(input: unknown): ArchitectureTargetHealth {
  const body = parseJsonObject(input);
  rejectFields(body, ["status", "checkedAt", "metadata"], "ARCHITECTURE_TARGET_HEALTH_FIELD");
  return structuredClone(body) as unknown as ArchitectureTargetHealth;
}

function parseArchitectureTargetObservationQuery(input: unknown): { limit?: number } {
  const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const rawLimit = params.limit;
  if (rawLimit === undefined) return {};
  const limit = typeof rawLimit === "string" ? Number.parseInt(rawLimit, 10) : rawLimit;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
    throw new AppError("Observation limit is invalid.", "INVALID_REQUEST_BODY", 400);
  }
  return { limit };
}

function parseArchitectureTargetIdParam(input: unknown): string {
  const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return parseArchitectureTargetIdentifier(params.id, "id");
}

function parseArchitectureTargetIdentifier(value: unknown, field: string): string {
  const id = requiredString(value, field).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new AppError(`${field} is invalid.`, "INVALID_ARCHITECTURE_TARGET_IDENTIFIER", 400);
  }
  return id;
}

function rejectArchitectureFields(body: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(body).find((key) => !allowedSet.has(key));
  if (unsupported) {
    throw new AppError(`Architecture field is not accepted: ${unsupported}.`, "UNSUPPORTED_ARCHITECTURE_FIELD", 400);
  }
}

function optionalArchitectureIdentifier(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const id = requiredString(value, field).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new AppError(`${field} is invalid.`, "INVALID_ARCHITECTURE_IDENTIFIER", 400);
  }
  return id;
}

function parseArchitectureIdParam(input: unknown): string {
  const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return optionalArchitectureIdentifier(params.id, "id") ?? "";
}

function parseArchitectureRevisionParams(input: unknown): { architectureId: string; revisionId: string } {
  const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return {
    architectureId: optionalArchitectureIdentifier(params.id, "id") ?? "",
    revisionId: optionalArchitectureIdentifier(params.revisionId, "revisionId") ?? "",
  };
}

function parseTeamCreateInput(input: unknown): { name: string } {
  const body = parseJsonObject(input);
  const organizationField = ["organizationId", "organizationSlug", "parentOrganizationId"]
    .find((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (organizationField) {
    throw new AppError(
      "Organization teams must be created through the organization teams route.",
      "ORGANIZATION_TEAM_ROUTE_REQUIRED",
      400,
    );
  }
  rejectFields(body, ["name"], "TEAM_FIELD");
  return {
    name: requiredString(body.name, "name"),
  };
}

function parseTeamInviteInput(input: unknown): { email: string } {
  const body = parseJsonObject(input);
  return {
    email: requiredString(body.email, "email"),
  };
}

function parseTeamInvitationLifecycleParams(input: unknown): { teamId: string; invitationId: string } {
  return {
    teamId: parseOpaqueIdParam(input, "teamId"),
    invitationId: parseOpaqueIdParam(input, "invitationId"),
  };
}

function parseTeamMemberLifecycleParams(input: unknown): { teamId: string; memberId: string } {
  return {
    teamId: parseOpaqueIdParam(input, "teamId"),
    memberId: parseOpaqueIdParam(input, "memberId"),
  };
}

function parseTeamMemberRoleInput(paramsInput: unknown, bodyInput: unknown): {
  teamId: string;
  memberId: string;
  role: "owner" | "member";
} {
  const body = parseJsonObject(bodyInput);
  const unsupported = Object.keys(body).find((key) => key !== "role");
  if (unsupported) {
    throw new AppError(`Team member field is not accepted: ${unsupported}.`, "UNSUPPORTED_TEAM_MEMBER_FIELD", 400);
  }
  const role = requiredString(body.role, "role");
  if (role !== "owner" && role !== "member") {
    throw new AppError("Team member role must be owner or member.", "INVALID_TEAM_MEMBER_ROLE", 400);
  }
  return {
    ...parseTeamMemberLifecycleParams(paramsInput),
    role,
  };
}

function parseAdminUserActionInput(paramsInput: unknown, bodyInput: unknown): AdminUserActionInput {
  const body = parseJsonObject(bodyInput);
  const action = requiredString(body.action, "action");
  if (action !== "approve" && action !== "activate" && action !== "disable" && action !== "delete") {
    throw new AppError("User action is invalid.", "INVALID_ADMIN_USER_ACTION", 400);
  }
  return {
    userId: parseUserIdParam(paramsInput),
    action,
    reason: optionalString(body.reason, "reason"),
  };
}

function parseAdminUserRoleUpdateInput(paramsInput: unknown, bodyInput: unknown): AdminUserRoleUpdateInput {
  const body = parseJsonObject(bodyInput);
  const roles = body.roles;
  if (!Array.isArray(roles)) {
    throw new AppError("User roles are invalid.", "INVALID_ADMIN_USER_ROLES", 400);
  }
  return {
    userId: parseUserIdParam(paramsInput),
    roles: roles.map((role) => {
      if (typeof role !== "string") {
        throw new AppError("User roles are invalid.", "INVALID_ADMIN_USER_ROLES", 400);
      }
      return role as AdminUserRoleUpdateInput["roles"][number];
    }),
    reason: optionalString(body.reason, "reason"),
  };
}

function parseProviderConfigInput(paramsInput: unknown, bodyInput: unknown): UpsertProviderConfigRequest {
  const body = parseJsonObject(bodyInput);
  rejectProviderSecretFields(body);
  rejectUnsupportedProviderFields(body);
  return {
    key: parseProviderKeyParam(paramsInput),
    type: requiredString(body.type, "type"),
    displayName: requiredString(body.displayName, "displayName"),
    issuer: optionalString(body.issuer, "issuer"),
    clientId: optionalString(body.clientId, "clientId"),
    enabled: optionalBoolean(body.enabled, "enabled"),
    roleMappings: parseProviderRoleMappings(body.roleMappings),
  };
}

function parseAdminAuditQuery(input: unknown): ListAdminAuditEventsInput {
  const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const rawLimit = typeof params.limit === "string" ? Number.parseInt(params.limit, 10) : undefined;
  return {
    limit: rawLimit !== undefined && Number.isFinite(rawLimit) ? rawLimit : undefined,
  };
}

function parseCreateApiTokenInput(input: unknown): CreateApiTokenRequest {
  const body = parseJsonObject(input);
  const rawScopes = body.scopes;
  if (!Array.isArray(rawScopes)) {
    throw new AppError("Token scopes are required.", "INVALID_TOKEN_SCOPES", 400);
  }
  return {
    name: requiredString(body.name, "name"),
    scopes: rawScopes.map((scope, index) => {
      if (typeof scope !== "string") {
        throw new AppError(`scopes[${index}] must be a string.`, "INVALID_TOKEN_SCOPES", 400);
      }
      return scope as ApiTokenScope;
    }),
    expiresAt: optionalString(body.expiresAt, "expiresAt"),
  };
}

async function parseSubmissionInput(input: unknown): Promise<{
  manifest: ReturnType<typeof parseSkillManifest>;
  files: PackageInputFile[];
}> {
  const body = parseJsonObject(input);
  rejectServerManagedSubmissionFields(body);

  const hasFiles = "files" in body;
  const hasArchive = "archive" in body;
  if (hasFiles === hasArchive) {
    throw new AppError("Submit exactly one package source: files or archive.", "INVALID_SUBMISSION_PACKAGE_SOURCE", 400);
  }

  if (hasArchive) {
    const archive = parseSubmissionArchive(body.archive);
    let files: PackageInputFile[];
    try {
      files = await readPackageFilesFromZipBuffer(archive.content);
    } catch (error) {
      throw new AppError(error instanceof Error ? error.message : "Invalid package archive.", "INVALID_PACKAGE_ARCHIVE", 400);
    }
    return {
      manifest: parseSubmissionManifest(body.manifest, files, { optional: true }),
      files,
    };
  }

  if (!Array.isArray(body.files)) {
    throw new AppError("Package files are required.", "PACKAGE_FILES_REQUIRED", 400);
  }
  if (body.files.length > MAX_PACKAGE_FILES) {
    throw new AppError(`Package contains more than ${MAX_PACKAGE_FILES} files.`, "INVALID_PACKAGE_PAYLOAD", 400);
  }

  const files = body.files.map((file, index) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new AppError(`Package file ${index + 1} must be an object.`, "INVALID_PACKAGE_FILE", 400);
    }
    const record = file as Record<string, unknown>;
    if (typeof record.content !== "string") {
      throw new AppError(`files[${index}].content must be a string.`, "INVALID_PACKAGE_FILE", 400);
    }
    return {
      path: requiredString(record.path, `files[${index}].path`),
      content: record.content,
    };
  });

  return {
    manifest: parseSubmissionManifest(body.manifest, files, { optional: false }),
    files,
  };
}

function parseSubmissionManifest(input: unknown, files: PackageInputFile[], options: { optional: boolean }): ReturnType<typeof parseSkillManifest> {
  if (input === undefined && options.optional) {
    return manifestFromPackageFiles(files);
  }
  try {
    return parseSkillManifest(input);
  } catch {
    throw new AppError("Invalid package manifest.", "INVALID_PACKAGE_MANIFEST", 400);
  }
}

function manifestFromPackageFiles(files: PackageInputFile[]): ReturnType<typeof parseSkillManifest> {
  try {
    return loadSkillManifestFromPackageFiles(files);
  } catch (error) {
    if (error instanceof PackageManifestFileError) {
      throw new AppError(error.message, error.code, 400);
    }
    throw new AppError(error instanceof Error ? error.message : "Invalid package archive.", "INVALID_PACKAGE_ARCHIVE", 400);
  }
}

function parseSubmissionArchive(input: unknown): { filename?: string; content: Buffer } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("Package archive must be an object.", "INVALID_PACKAGE_ARCHIVE", 400);
  }
  const record = input as Record<string, unknown>;
  const filename = optionalString(record.filename, "archive.filename");
  if (filename !== undefined && (filename.length > 255 || !/^[A-Za-z0-9._-]+\.zip$/i.test(filename))) {
    throw new AppError("Package archive filename must be a .zip basename.", "INVALID_PACKAGE_ARCHIVE", 400);
  }
  const contentBase64 = requiredString(record.contentBase64, "archive.contentBase64");
  if (contentBase64.length > Math.ceil(MAX_PACKAGE_ARCHIVE_BYTES / 3) * 4) {
    throw new AppError(`Package archive exceeds ${MAX_PACKAGE_ARCHIVE_BYTES} bytes.`, "INVALID_PACKAGE_ARCHIVE", 400);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64) || contentBase64.length % 4 !== 0) {
    throw new AppError("Package archive content must be base64 encoded.", "INVALID_PACKAGE_ARCHIVE", 400);
  }
  const content = Buffer.from(contentBase64, "base64");
  if (content.length === 0) {
    throw new AppError("Package archive content is required.", "INVALID_PACKAGE_ARCHIVE", 400);
  }
  if (content.byteLength > MAX_PACKAGE_ARCHIVE_BYTES) {
    throw new AppError(`Package archive exceeds ${MAX_PACKAGE_ARCHIVE_BYTES} bytes.`, "INVALID_PACKAGE_ARCHIVE", 400);
  }
  if (content.toString("base64") !== contentBase64) {
    throw new AppError("Package archive content must be canonical base64.", "INVALID_PACKAGE_ARCHIVE", 400);
  }
  return { filename, content };
}

function rejectServerManagedSubmissionFields(body: Record<string, unknown>): void {
  const forbidden = [
    "path",
    "packagePath",
    "url",
    "ownerUserId",
    "reviewStatus",
    "securityStatus",
    "publishedAt",
    "storageKey",
    "sha256",
    "byteSize",
    "contentType",
  ];
  const present = forbidden.find((field) => field in body);
  if (present) {
    throw new AppError(`Submission field is not accepted: ${present}`, "UNSUPPORTED_SUBMISSION_FIELD", 400);
  }
}

function submissionResponse(submission: StoredSubmission) {
  return {
    submission: {
      id: submission.id,
      slug: submission.skillSlug,
      version: submission.version,
      reviewStatus: submission.reviewStatus,
      securityStatus: submission.securityStatus,
    },
    scan: {
      status: submission.scan.status,
      findingCount: submission.scan.findings.length,
      findings: submission.scan.findings,
    },
  };
}

function parseReviewActionInput(input: unknown): { action: ReviewAction; artifactSha256?: string; reason?: string } {
  const body = parseJsonObject(input);
  const action = requiredString(body.action, "action");
  if (action !== "approve" && action !== "request-changes" && action !== "reject" && action !== "publish") {
    throw new AppError("Unsupported review action.", "INVALID_REVIEW_ACTION", 400);
  }
  const artifactSha256 = "artifactSha256" in body
    ? parseArtifactSha256(body.artifactSha256)
    : undefined;
  return {
    action,
    artifactSha256,
    reason: optionalString(body.reason, "reason"),
  };
}

function parseArtifactSha256(input: unknown): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new AppError("Approval artifact hash is required.", "APPROVAL_ARTIFACT_HASH_REQUIRED", 400);
  }
  const hash = input.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new AppError("Approval artifact hash must be a sha256 hex digest.", "INVALID_ARTIFACT_HASH", 400);
  }
  return hash;
}

function parseSlugParam(input: unknown): string {
  const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const slug = params.slug;
  if (typeof slug !== "string" || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) || slug.includes("--")) {
    throw new AppError("Valid skill slug is required.", "INVALID_SKILL_SLUG", 400);
  }
  return slug;
}

function parseReleaseParams(input: unknown): { slug: string; version: string } {
  const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const slug = parseSlugParam(params);
  const version = requiredString(params.version, "version");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new AppError("Valid release version is required.", "INVALID_RELEASE_VERSION", 400);
  }
  return { slug, version };
}

function parseSubmissionIdParam(input: unknown): string {
  const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const id = requiredString(params.id, "id");
  if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) {
    throw new AppError("Valid submission id is required.", "INVALID_SUBMISSION_ID", 400);
  }
  return id;
}

function parseTokenIdParam(input: unknown): string {
  const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const id = requiredString(params.id, "id");
  if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) {
    throw new AppError("Valid API token id is required.", "INVALID_API_TOKEN_ID", 400);
  }
  return id;
}

function parseUserIdParam(input: unknown): string {
  const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const id = requiredString(params.id, "id");
  if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) {
    throw new AppError("Valid user id is required.", "INVALID_USER_ID", 400);
  }
  return id;
}

function parseOpaqueIdParam(input: unknown, field: string): string {
  const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const id = requiredString(params[field], field);
  if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) {
    throw new AppError(`${field} is invalid.`, "INVALID_REQUEST_BODY", 400);
  }
  return id;
}

function parseOrganizationIdParam(input: unknown): string {
  const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return parseOrganizationIdentifier(params.id, "id");
}

function parseOrganizationIdentifier(value: unknown, field: string): string {
  const id = requiredString(value, field).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new AppError(`${field} is invalid.`, "INVALID_ORGANIZATION_IDENTIFIER", 400);
  }
  return id;
}

function parseProviderKeyParam(input: unknown): string {
  const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return requiredString(params.key, "key");
}

function httpStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("statusCode" in error)) {
    return null;
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : null;
}

async function readinessCheck(
  probe: (() => Promise<void>) | undefined,
  timeoutMs: number,
): Promise<"ready" | "unready"> {
  if (!probe) {
    return "unready";
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Readiness probe timed out.")), timeoutMs);
      }),
    ]);
    return "ready";
  } catch {
    return "unready";
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function setSecurityHeaders(reply: FastifyReply): void {
  reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  reply.header("x-frame-options", "DENY");
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "no-referrer");
  reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
}

function parseJsonObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("JSON object body is required.", "INVALID_REQUEST_BODY", 400);
  }
  return input as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError(`${field} is required.`, "INVALID_REQUEST_BODY", 400);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError(`${field} must be a string.`, "INVALID_REQUEST_BODY", 400);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new AppError(`${field} must be a boolean.`, "INVALID_REQUEST_BODY", 400);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new AppError(`${field} must be a boolean.`, "INVALID_REQUEST_BODY", 400);
  }
  return value;
}

function parseVisibilityScope(value: unknown): VisibilityScope {
  const visibility = requiredString(value, "visibility");
  if (
    visibility !== "public" &&
    visibility !== "authenticated" &&
    visibility !== "organization" &&
    visibility !== "team" &&
    visibility !== "private" &&
    visibility !== "explicit-users"
  ) {
    throw new AppError("Visibility scope is invalid.", "INVALID_VISIBILITY_SCOPE", 400);
  }
  return visibility;
}

function parseStringArray(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new AppError(`${field} must be an array.`, "INVALID_REQUEST_BODY", 400);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new AppError(`${field}[${index}] must be a string.`, "INVALID_REQUEST_BODY", 400);
    }
    return item;
  });
}

function isAdminResponseUser(user: { roles: string[] }): boolean {
  return user.roles.includes("owner") || user.roles.includes("admin");
}

function rejectProviderSecretFields(input: unknown): void {
  if (!input || typeof input !== "object") {
    return;
  }
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (/secret|password|token|private[-_ ]?key|api[-_ ]?key/i.test(key)) {
      throw new AppError("Provider secrets must be configured through the deployment secret store.", "UNSUPPORTED_PROVIDER_SECRET_FIELD", 400);
    }
    rejectProviderSecretFields(value);
  }
}

function rejectUnsupportedProviderFields(body: Record<string, unknown>): void {
  const allowed = new Set(["type", "displayName", "issuer", "clientId", "enabled", "roleMappings"]);
  const unsupported = Object.keys(body).find((key) => !allowed.has(key));
  if (unsupported) {
    throw new AppError(`Provider field is not accepted: ${unsupported}`, "UNSUPPORTED_PROVIDER_FIELD", 400);
  }
}

function parseProviderRoleMappings(input: unknown): UpsertProviderConfigRequest["roleMappings"] {
  if (input === undefined) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw new AppError("Provider role mappings must be an array.", "INVALID_PROVIDER_ROLE_MAPPING", 400);
  }
  return input.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AppError(`Provider role mapping ${index + 1} must be an object.`, "INVALID_PROVIDER_ROLE_MAPPING", 400);
    }
    const record = item as Record<string, unknown>;
    const allowed = new Set(["claim", "value", "role"]);
    const unsupported = Object.keys(record).find((key) => !allowed.has(key));
    if (unsupported) {
      throw new AppError(`Provider role mapping field is not accepted: ${unsupported}`, "UNSUPPORTED_PROVIDER_FIELD", 400);
    }
    return {
      claim: requiredString(record.claim, `roleMappings[${index}].claim`),
      value: requiredString(record.value, `roleMappings[${index}].value`),
      role: requiredString(record.role, `roleMappings[${index}].role`),
    };
  });
}

function parseQuery(input: unknown): { q?: string; limit?: number } {
  const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const q = typeof params.q === "string" ? params.q : undefined;
  const rawLimit = typeof params.limit === "string" ? Number.parseInt(params.limit, 10) : undefined;
  const limit = rawLimit && Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : undefined;
  return { q, limit };
}

function parseBundleQuery(input: unknown): { platform?: string } {
  const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const platform = typeof params.platform === "string" && params.platform.trim() ? params.platform.trim() : undefined;
  if (platform && (platform.length > 64 || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(platform))) {
    throw new AppError("Valid platform is required.", "INVALID_PLATFORM", 400);
  }
  return { platform };
}
