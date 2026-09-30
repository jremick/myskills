import { AppError } from "@myskills-app/core";
import type { AuthService } from "../auth/service.js";
import type { SubmissionService } from "../submissions/service.js";
import type { PublicReleaseMetadata } from "../submissions/types.js";
import { assertArtifactBodyMatchesMetadata } from "./package-payload.js";

const DELIVERY_WINDOW_MS = 15_000;

/** Private object storage stays behind the API; no reusable object URL is issued. */
export async function readAuthorizedArtifactBundle(input: {
  authService?: AuthService;
  submissionService: SubmissionService;
  authorization?: string;
  slug: string;
  version: string;
  platform?: string;
  expectedSha256?: unknown;
}) {
  const expiresAt = Date.now() + DELIVERY_WINDOW_MS;
  if (input.expectedSha256 !== undefined && (typeof input.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedSha256))) {
    throw new AppError("Expected SHA-256 must be a lowercase digest.", "INVALID_ARTIFACT_DIGEST", 400);
  }
  const authenticate = async () => {
    // A supplied credential never falls back to public anonymous access.
    if (!input.authorization) return null;
    const context = await input.authService?.authenticateRequest(input.authorization);
    if (!context) throw new AppError("Authentication is required.", "AUTHENTICATION_REQUIRED", 401);
    if (context.credential.kind !== "session" && !context.credential.scopes.includes("skills:read")) {
      throw new AppError("API token scope is required.", "API_TOKEN_SCOPE_REQUIRED", 403, { scope: "skills:read" });
    }
    return context.user.id;
  };
  const actorId = await authenticate();
  const releaseInput = { slug: input.slug, version: input.version, actorId };
  const before = await input.submissionService.getPublicRelease(releaseInput);
  if (!before || !supportsPlatform(before, input.platform)) return null;
  if (input.expectedSha256 !== undefined && input.expectedSha256 !== before.artifact.sha256) {
    throw new AppError("Artifact digest no longer matches the requested release.", "ARTIFACT_DIGEST_CHANGED", 409);
  }
  const bundle = await input.submissionService.getPublicBundle({ ...releaseInput, platform: input.platform });
  if (!bundle) return null;
  const body = JSON.stringify(bundle.payload);
  assertArtifactBodyMatchesMetadata(body, before.artifact);
  if (!sameArtifact(before, bundle)) throw new AppError("Artifact identity changed during delivery.", "ARTIFACT_DIGEST_CHANGED", 409);
  // Reauthorize after the slow object read and before sending any bytes.
  const current = await input.submissionService.getPublicRelease(releaseInput);
  if (!current || !supportsPlatform(current, input.platform)) return null;
  if (!sameArtifact(before, current)) throw new AppError("Artifact identity changed during delivery.", "ARTIFACT_DIGEST_CHANGED", 409);
  // This is the last awaited operation. Revocation during the metadata query
  // must also fail before bytes enter the response.
  const currentActorId = await authenticate();
  if (currentActorId !== actorId) throw new AppError("Authentication is required.", "AUTHENTICATION_REQUIRED", 401);
  if (Date.now() >= expiresAt) throw new AppError("Artifact delivery authorization expired.", "ARTIFACT_DELIVERY_EXPIRED", 504);
  return { body, artifact: current.artifact };
}

function supportsPlatform(release: PublicReleaseMetadata, platform?: string) {
  return !platform || release.platforms.some(item => item.name === platform && item.status === "supported");
}

function sameArtifact(a: PublicReleaseMetadata, b: PublicReleaseMetadata) {
  return a.slug === b.slug && a.version === b.version
    && a.artifact.sha256 === b.artifact.sha256 && a.artifact.byteSize === b.artifact.byteSize
    && a.artifact.contentType === b.artifact.contentType;
}
