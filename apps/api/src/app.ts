import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { AppError } from "@ai-skills-share/core";
import {
  MAX_PACKAGE_ARCHIVE_BYTES,
  loadSkillManifestFromPackageFiles,
  PackageManifestFileError,
  parseSkillManifest,
  readPackageFilesFromZipBuffer,
  type PackageInputFile,
} from "@ai-skills-share/skill-package";
import type { ApiTokenScope } from "./auth/types.js";
import type {
  AuthContext,
  AuthService,
  AdminUserActionInput,
  ConfirmEmailVerificationInput,
  ConfirmPasswordResetInput,
  ConfirmTotpEnrollmentInput,
  CreateApiTokenRequest,
  ListAdminAuditEventsInput,
  LoginInput,
  RegisterInput,
  RequestEmailVerificationInput,
  RequestPasswordResetInput,
  StartTotpEnrollmentInput,
  UpdateRegistrationSettingsInput,
  VerifyMfaChallengeInput,
} from "./auth/service.js";
import type { ReviewAction, StoredSubmission, SubmissionActor } from "./submissions/types.js";
import type { SubmissionService } from "./submissions/service.js";
import type { SkillRepository } from "@ai-skills-share/core";

export interface BuildAppOptions {
  skillRepository: SkillRepository;
  authService?: AuthService;
  submissionService?: SubmissionService;
  allowedOrigins?: string[];
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const allowedOrigins = options.allowedOrigins ?? ["http://localhost:3000", "http://127.0.0.1:3000"];

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && allowedOrigins.includes(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
      reply.header("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
      reply.header("access-control-allow-headers", "authorization,content-type");
    }
    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

  app.setErrorHandler((error, _request, reply) => {
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

  app.get("/v1/skills/:slug/releases/:version", async (request, reply) => {
    if (!options.submissionService) {
      throw new AppError("Submission service is not configured.", "SUBMISSION_SERVICE_UNAVAILABLE", 503);
    }
    const params = parseReleaseParams(request.params);
    const release = await options.submissionService.getPublicRelease(params);
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
    const user = await options.authService?.authenticateAuthorizationHeader(request.headers.authorization);
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
    const skill = await options.skillRepository.getVisibleSkillBySlug(slug);
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

  app.post("/v1/auth/login", async (request) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    return options.authService.login({
      ...parseLoginInput(request.body),
      ip: request.ip,
    });
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

  app.post("/v1/auth/mfa/verify", async (request) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    return options.authService.verifyMfaChallenge({
      ...parseVerifyMfaChallengeInput(request.body),
      ip: request.ip,
    });
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    if (options.authService) {
      await options.authService.logout(request.headers.authorization);
    }
    return reply.code(204).send();
  });

  app.get("/v1/auth/mfa", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, request.headers.authorization);
    if (!user) {
      return authFailureReply(options.authService, request.headers.authorization, reply);
    }
    return { mfa: await options.authService.getMfaStatus(user) };
  });

  app.post("/v1/auth/mfa/totp/enroll", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, request.headers.authorization);
    if (!user) {
      return authFailureReply(options.authService, request.headers.authorization, reply);
    }
    const enrollment = await options.authService.startTotpEnrollment(user, parseStartTotpEnrollmentInput(request.body));
    return reply.code(201).send({ enrollment });
  });

  app.post("/v1/auth/mfa/totp/confirm", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, request.headers.authorization);
    if (!user) {
      return authFailureReply(options.authService, request.headers.authorization, reply);
    }
    return { mfa: await options.authService.confirmTotpEnrollment(user, parseConfirmTotpEnrollmentInput(request.body)) };
  });

  app.get("/v1/auth/api-tokens", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, request.headers.authorization);
    if (!user) {
      return authFailureReply(options.authService, request.headers.authorization, reply);
    }
    return { tokens: await options.authService.listApiTokens(user) };
  });

  app.post("/v1/auth/api-tokens", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, request.headers.authorization);
    if (!user) {
      return authFailureReply(options.authService, request.headers.authorization, reply);
    }
    const token = await options.authService.createApiToken(user, parseCreateApiTokenInput(request.body));
    return reply.code(201).send({ token });
  });

  app.delete("/v1/auth/api-tokens/:id", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, request.headers.authorization);
    if (!user) {
      return authFailureReply(options.authService, request.headers.authorization, reply);
    }
    const token = await options.authService.revokeApiToken(user, parseTokenIdParam(request.params));
    return { token };
  });

  app.get("/v1/admin/registration", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, request.headers.authorization);
    if (!user) {
      return authFailureReply(options.authService, request.headers.authorization, reply);
    }
    return { registration: await options.authService.getRegistrationSettings(user) };
  });

  app.put("/v1/admin/registration", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, request.headers.authorization);
    if (!user) {
      return authFailureReply(options.authService, request.headers.authorization, reply);
    }
    return {
      registration: await options.authService.updateRegistrationSettings(
        user,
        parseUpdateRegistrationSettingsInput(request.body),
      ),
    };
  });

  app.get("/v1/admin/users", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, request.headers.authorization);
    if (!user) {
      return authFailureReply(options.authService, request.headers.authorization, reply);
    }
    return { users: await options.authService.listAdminUsers(user) };
  });

  app.post("/v1/admin/users/:id/actions", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, request.headers.authorization);
    if (!user) {
      return authFailureReply(options.authService, request.headers.authorization, reply);
    }
    return {
      user: await options.authService.performAdminUserAction(
        user,
        parseAdminUserActionInput(request.params, request.body),
      ),
    };
  });

  app.get("/v1/admin/audit", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const user = await authenticateSessionUser(options.authService, request.headers.authorization);
    if (!user) {
      return authFailureReply(options.authService, request.headers.authorization, reply);
    }
    return { events: await options.authService.listAdminAuditEvents(user, parseAdminAuditQuery(request.query)) };
  });

  app.get("/v1/me", async (request, reply) => {
    const context = await options.authService?.authenticateRequest(request.headers.authorization);
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

  app.get("/v1/mcp/session", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    const context = await options.authService.authenticateRequest(request.headers.authorization);
    if (!context) {
      return reply.code(401).send({
        error: {
          code: "AUTHENTICATION_REQUIRED",
          message: "Authentication is required.",
        },
      });
    }
    if (context.credential.kind !== "api_token") {
      return reply.code(403).send({
        error: {
          code: "API_TOKEN_AUTH_REQUIRED",
          message: "API token authentication is required.",
        },
      });
    }
    requireScope(context, "skills:read");
    return {
      user: context.user,
      credential: {
        kind: context.credential.kind,
        tokenId: context.credential.tokenId,
        scopes: context.credential.scopes,
      },
    };
  });

  app.post("/v1/submissions", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.submissionService) {
      throw new AppError("Submission service is not configured.", "SUBMISSION_SERVICE_UNAVAILABLE", 503);
    }
    const context = await options.authService.authenticateRequest(request.headers.authorization);
    if (!context) {
      return reply.code(401).send({
        error: {
          code: "AUTHENTICATION_REQUIRED",
          message: "Authentication is required.",
        },
      });
    }
    requireScope(context, "skills:submit");
    const input = await parseSubmissionInput(request.body);
    const submission = await options.submissionService.createSubmission({
      actor: {
        id: context.user.id,
        roles: context.user.roles,
      },
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
    const actor = await authenticateActor(options.authService, request.headers.authorization, "review:read", { mfaRequired: true });
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

  app.post("/v1/review/submissions/:id/actions", async (request, reply) => {
    if (!options.authService) {
      throw new AppError("Authentication service is not configured.", "AUTH_SERVICE_UNAVAILABLE", 503);
    }
    if (!options.submissionService) {
      throw new AppError("Submission service is not configured.", "SUBMISSION_SERVICE_UNAVAILABLE", 503);
    }
    const actor = await authenticateActor(options.authService, request.headers.authorization, "review:write", { mfaRequired: true });
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

function requiresMfaForRole(context: AuthContext): boolean {
  return context.user.roles.some((role) => role === "owner" || role === "admin" || role === "maintainer");
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

function parseRegisterInput(input: unknown): RegisterInput {
  const body = parseJsonObject(input);
  return {
    email: requiredString(body.email, "email"),
    password: requiredString(body.password, "password"),
    name: optionalString(body.name, "name"),
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

function parseUpdateRegistrationSettingsInput(input: unknown): UpdateRegistrationSettingsInput {
  const body = parseJsonObject(input);
  const mode = requiredString(body.mode, "mode");
  if (mode !== "closed" && mode !== "request" && mode !== "open") {
    throw new AppError("Registration mode is invalid.", "INVALID_REGISTRATION_MODE", 400);
  }
  return { mode };
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
  if (filename !== undefined && !/^[A-Za-z0-9._-]+\.zip$/i.test(filename)) {
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

function parseReviewActionInput(input: unknown): { action: ReviewAction; reason?: string } {
  const body = parseJsonObject(input);
  const action = requiredString(body.action, "action");
  if (action !== "approve" && action !== "publish") {
    throw new AppError("Unsupported review action.", "INVALID_REVIEW_ACTION", 400);
  }
  return {
    action,
    reason: optionalString(body.reason, "reason"),
  };
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

function httpStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("statusCode" in error)) {
    return null;
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : null;
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
  if (platform && !/^[A-Za-z0-9._-]{1,64}$/.test(platform)) {
    throw new AppError("Valid platform is required.", "INVALID_PLATFORM", 400);
  }
  return { platform };
}
