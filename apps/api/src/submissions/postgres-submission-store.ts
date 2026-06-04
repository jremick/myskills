import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { AppError } from "@ai-skills-share/core";
import { parseSkillManifest } from "@ai-skills-share/skill-package";
import { sanitizeAuditDetails, sanitizeAuditValue } from "../audit/sanitize.js";
import type { Database } from "../db/client.js";
import {
  auditEvents,
  scanFindings,
  scanRuns,
  skillArtifacts,
  skillPlatformVariants,
  skills,
  skillTags,
  skillVersions,
} from "../db/schema.js";
import type {
  ArtifactPayload,
  CreateSubmissionInput,
  PublicBundle,
  PublicReleaseMetadata,
  ReviewActionResult,
  ReviewSubmissionSummary,
  StoredSubmission,
  SubmissionStore,
} from "./types.js";

export class PostgresSubmissionStore implements SubmissionStore {
  constructor(private readonly db: Database) {}

  async createSubmission(input: CreateSubmissionInput & {
    artifact: StoredSubmission["artifact"];
    findings: StoredSubmission["scan"]["findings"];
    securityStatus: StoredSubmission["securityStatus"];
  }): Promise<StoredSubmission> {
    return this.db.transaction(async (tx) => {
      const [existingSkill] = await tx
        .select()
        .from(skills)
        .where(eq(skills.slug, input.manifest.name))
        .limit(1);

      if (existingSkill?.ownerUserId && existingSkill.ownerUserId !== input.actor.id) {
        throw new AppError("Package slug is unavailable.", "PACKAGE_SLUG_UNAVAILABLE", 409);
      }

      const skill = existingSkill ?? (await tx
        .insert(skills)
        .values({
          slug: input.manifest.name,
          title: input.manifest.title,
          summary: input.manifest.summary,
          lifecycleStatus: "submitted",
          visibility: input.manifest.visibility,
          ownerUserId: input.actor.id,
        })
        .returning())[0];

      if (!skill) {
        throw new Error("Skill submission insert failed.");
      }

      if (existingSkill) {
        const nextLifecycle = existingSkill.lifecycleStatus === "approved" ? existingSkill.lifecycleStatus : "submitted";
        await tx.update(skills).set({
          title: nextLifecycle === "approved" ? existingSkill.title : input.manifest.title,
          summary: nextLifecycle === "approved" ? existingSkill.summary : input.manifest.summary,
          lifecycleStatus: nextLifecycle,
          updatedAt: new Date(),
        }).where(eq(skills.id, skill.id));
      }

      const [existingVersion] = await tx
        .select({ id: skillVersions.id })
        .from(skillVersions)
        .where(and(eq(skillVersions.skillId, skill.id), eq(skillVersions.version, input.manifest.version)))
        .limit(1);

      if (existingVersion) {
        throw new AppError("Package version already exists.", "PACKAGE_VERSION_EXISTS", 409);
      }

      const [version] = await tx.insert(skillVersions).values({
        skillId: skill.id,
        version: input.manifest.version,
        reviewStatus: "unreviewed",
        securityStatus: input.securityStatus,
      }).returning();

      if (!version) {
        throw new Error("Skill version submission insert failed.");
      }

      for (const platform of input.manifest.platforms) {
        await tx.insert(skillPlatformVariants).values({
          skillVersionId: version.id,
          name: platform.name,
          installTarget: platform.install_target,
          status: platform.status,
        });
      }

      for (const tag of input.manifest.tags) {
        await tx.insert(skillTags).values({ skillId: skill.id, tag }).onConflictDoNothing();
      }

      await tx.insert(skillArtifacts).values({
        skillVersionId: version.id,
        storageKey: input.artifact.storageKey,
        sha256: input.artifact.sha256,
        byteSize: input.artifact.byteSize,
        contentType: input.artifact.contentType,
        payload: input.artifact.payload,
      });

      const now = new Date();
      const [scanRun] = await tx.insert(scanRuns).values({
        skillVersionId: version.id,
        status: "succeeded",
        startedAt: now,
        completedAt: now,
      }).returning();

      if (!scanRun) {
        throw new Error("Scan run insert failed.");
      }

      if (input.findings.length > 0) {
        await tx.insert(scanFindings).values(input.findings.map((finding) => ({
          scanRunId: scanRun.id,
          category: finding.category,
          severity: finding.severity,
          message: finding.message,
          path: finding.path ?? null,
        })));
      }

      await tx.insert(auditEvents).values({
        actorUserId: input.actor.id,
        action: "submission.create",
        decision: "allow",
        resourceType: "skill_version",
        resourceId: version.id,
        details: {
          slug: input.manifest.name,
          version: input.manifest.version,
          sha256: input.artifact.sha256,
          byteSize: input.artifact.byteSize,
          fileCount: input.files.length,
          findingCount: input.findings.length,
          securityStatus: input.securityStatus,
        },
      });

      return {
        id: version.id,
        skillSlug: skill.slug,
        title: skill.title,
        summary: skill.summary,
        version: version.version,
        visibility: skill.visibility,
        platforms: input.manifest.platforms.map((platform) => ({
          name: platform.name,
          installTarget: platform.install_target,
          status: platform.status,
        })),
        reviewStatus: version.reviewStatus,
        securityStatus: version.securityStatus,
        publishedAt: version.publishedAt?.toISOString() ?? null,
        artifact: input.artifact,
        scan: {
          status: "succeeded",
          findings: input.findings,
        },
      };
    });
  }

  async listReviewSubmissions(): Promise<ReviewSubmissionSummary[]> {
    const rows = await this.db
      .select({
        id: skillVersions.id,
        slug: skills.slug,
        title: skills.title,
        version: skillVersions.version,
        visibility: skills.visibility,
        reviewStatus: skillVersions.reviewStatus,
        securityStatus: skillVersions.securityStatus,
        platforms: sql<ReviewSubmissionSummary["platforms"]>`
          coalesce(
            json_agg(
              distinct jsonb_build_object(
                'name', ${skillPlatformVariants.name},
                'installTarget', ${skillPlatformVariants.installTarget},
                'status', ${skillPlatformVariants.status}
              )
            ) filter (where ${skillPlatformVariants.id} is not null),
            '[]'::json
          )
        `,
        findingCount: sql<number>`count(distinct ${scanFindings.id})::int`,
        createdAt: skillVersions.createdAt,
      })
      .from(skillVersions)
      .innerJoin(skills, eq(skillVersions.skillId, skills.id))
      .innerJoin(skillArtifacts, eq(skillArtifacts.skillVersionId, skillVersions.id))
      .leftJoin(skillPlatformVariants, eq(skillPlatformVariants.skillVersionId, skillVersions.id))
      .leftJoin(scanRuns, eq(scanRuns.skillVersionId, skillVersions.id))
      .leftJoin(scanFindings, eq(scanFindings.scanRunId, scanRuns.id))
      .where(inArray(skillVersions.reviewStatus, ["unreviewed", "changes-requested"]))
      .groupBy(
        skillVersions.id,
        skills.slug,
        skills.title,
        skillVersions.version,
        skills.visibility,
        skillVersions.reviewStatus,
        skillVersions.securityStatus,
        skillVersions.createdAt,
      )
      .orderBy(sql`${skillVersions.createdAt} desc`)
      .limit(100);

    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async approveSubmission(input: { actorId: string; submissionId: string; reason?: string }): Promise<ReviewActionResult> {
    if (!isUuid(input.submissionId)) {
      await this.insertReviewAudit("review.approve", "deny", input.actorId, input.submissionId, {
        reason: "missing_submission",
      });
      throw new AppError("Submission not found.", "SUBMISSION_NOT_FOUND", 404);
    }

    return this.db.transaction(async (tx) => {
      const row = await selectVersionForReview(tx, input.submissionId);
      if (!row) {
        await this.insertReviewAudit("review.approve", "deny", input.actorId, input.submissionId, {
          reason: "missing_submission",
        }, tx);
        throw new AppError("Submission not found.", "SUBMISSION_NOT_FOUND", 404);
      }
      if (row.securityStatus !== "passed") {
        await this.insertReviewAudit("review.approve", "deny", input.actorId, input.submissionId, {
          slug: row.slug,
          version: row.version,
          reason: "scan_not_passed",
        }, tx);
        throw new AppError("Package scan must pass before approval.", "PACKAGE_SCAN_NOT_PASSED", 422);
      }
      if (!["unreviewed", "changes-requested"].includes(row.reviewStatus)) {
        await this.insertReviewAudit("review.approve", "deny", input.actorId, input.submissionId, {
          slug: row.slug,
          version: row.version,
          reason: "not_reviewable",
        }, tx);
        throw new AppError("Submission is not reviewable.", "SUBMISSION_NOT_REVIEWABLE", 409);
      }

      const [updatedVersion] = await tx.update(skillVersions).set({
        reviewStatus: "approved",
      }).where(eq(skillVersions.id, input.submissionId)).returning();
      if (!updatedVersion) {
        throw new Error("Submission approval failed.");
      }

      await this.insertReviewAudit("review.approve", "allow", input.actorId, input.submissionId, {
        slug: row.slug,
        version: row.version,
        reason: input.reason,
      }, tx);

      return {
        id: updatedVersion.id,
        slug: row.slug,
        version: updatedVersion.version,
        visibility: row.visibility,
        lifecycleStatus: row.lifecycleStatus,
        reviewStatus: updatedVersion.reviewStatus,
        securityStatus: updatedVersion.securityStatus,
        publishedAt: updatedVersion.publishedAt?.toISOString() ?? null,
      };
    });
  }

  async publishSubmission(input: { actorId: string; submissionId: string; reason?: string }): Promise<ReviewActionResult> {
    if (!isUuid(input.submissionId)) {
      await this.insertReviewAudit("release.publish", "deny", input.actorId, input.submissionId, {
        reason: "missing_submission",
      });
      throw new AppError("Submission not found.", "SUBMISSION_NOT_FOUND", 404);
    }

    return this.db.transaction(async (tx) => {
      const row = await selectVersionForReview(tx, input.submissionId);
      if (!row) {
        await this.insertReviewAudit("release.publish", "deny", input.actorId, input.submissionId, {
          reason: "missing_submission",
        }, tx);
        throw new AppError("Submission not found.", "SUBMISSION_NOT_FOUND", 404);
      }
      if (row.securityStatus !== "passed") {
        await this.insertReviewAudit("release.publish", "deny", input.actorId, input.submissionId, {
          slug: row.slug,
          version: row.version,
          reason: "scan_not_passed",
        }, tx);
        throw new AppError("Package scan must pass before publication.", "PACKAGE_SCAN_NOT_PASSED", 422);
      }
      if (row.reviewStatus !== "approved") {
        await this.insertReviewAudit("release.publish", "deny", input.actorId, input.submissionId, {
          slug: row.slug,
          version: row.version,
          reason: "not_approved",
        }, tx);
        throw new AppError("Submission must be approved before publication.", "SUBMISSION_NOT_APPROVED", 409);
      }
      if (row.publishedAt) {
        await this.insertReviewAudit("release.publish", "deny", input.actorId, input.submissionId, {
          slug: row.slug,
          version: row.version,
          reason: "already_published",
        }, tx);
        throw new AppError("Submission is already published.", "SUBMISSION_ALREADY_PUBLISHED", 409);
      }

      if (!row.artifactId) {
        await this.insertReviewAudit("release.publish", "deny", input.actorId, input.submissionId, {
          slug: row.slug,
          version: row.version,
          reason: "missing_artifact",
        }, tx);
        throw new AppError("Submission artifact is required before publication.", "PACKAGE_ARTIFACT_REQUIRED", 422);
      }
      if (row.succeededScanCount < 1) {
        await this.insertReviewAudit("release.publish", "deny", input.actorId, input.submissionId, {
          slug: row.slug,
          version: row.version,
          reason: "missing_succeeded_scan",
        }, tx);
        throw new AppError("A succeeded package scan is required before publication.", "PACKAGE_SCAN_REQUIRED", 422);
      }
      const manifest = manifestFromPayload(row.artifactPayload);
      const now = new Date();
      const [updatedVersion] = await tx.update(skillVersions).set({
        publishedAt: now,
      }).where(eq(skillVersions.id, input.submissionId)).returning();
      if (!updatedVersion) {
        throw new Error("Submission publication failed.");
      }
      await tx.update(skills).set({
        title: manifest.title,
        summary: manifest.summary,
        visibility: manifest.visibility,
        lifecycleStatus: "approved",
        updatedAt: now,
      }).where(eq(skills.id, row.skillId));

      await this.insertReviewAudit("release.publish", "allow", input.actorId, input.submissionId, {
        slug: row.slug,
        version: row.version,
        reason: input.reason,
      }, tx);

      return {
        id: updatedVersion.id,
        slug: row.slug,
        version: updatedVersion.version,
        visibility: row.visibility,
        lifecycleStatus: "approved",
        reviewStatus: updatedVersion.reviewStatus,
        securityStatus: updatedVersion.securityStatus,
        publishedAt: updatedVersion.publishedAt?.toISOString() ?? null,
      };
    });
  }

  async recordReviewDenied(input: {
    actorId: string;
    action: string;
    submissionId?: string;
    reason: string;
  }): Promise<void> {
    await this.insertReviewAudit(input.action, "deny", input.actorId, input.submissionId, {
      reason: input.reason,
    });
  }

  async getPublicRelease(input: { slug: string; version: string }): Promise<PublicReleaseMetadata | null> {
    const row = await selectPublicRelease(this.db, input);
    return row ? publicRelease(row) : null;
  }

  async getPublicBundle(input: { slug: string; version: string; platform?: string }): Promise<PublicBundle | null> {
    const row = await selectPublicRelease(this.db, input);
    if (!row) {
      return null;
    }
    if (input.platform && !row.platforms.some((platform) => (
      platform.name === input.platform &&
      platform.status === "supported"
    ))) {
      return null;
    }
    return {
      ...publicRelease(row),
      payload: parseArtifactPayload(row.payload),
    };
  }

  async recordArtifactAccess(input: {
    actorId?: string | null;
    slug: string;
    version: string;
    platform?: string;
    decision: "allow" | "deny";
    reason?: string;
  }): Promise<void> {
    await this.db.insert(auditEvents).values({
      actorUserId: input.actorId ?? null,
      action: "artifact.bundle",
      decision: input.decision,
      resourceType: "skill_artifact",
      details: sanitizeAuditDetails({
        slug: input.slug,
        version: input.version,
        platform: input.platform,
        reason: input.reason,
      }),
    });
  }

  async recordDenied(input: {
    actorId: string;
    slug: string;
    version: string;
    reason: string;
    findingCount: number;
  }): Promise<void> {
    await this.db.insert(auditEvents).values({
      actorUserId: input.actorId,
      action: "submission.create",
      decision: "deny",
      resourceType: "skill",
      details: {
        slug: input.slug,
        version: input.version,
        reason: sanitizeAuditValue(input.reason),
        findingCount: input.findingCount,
      },
    });
  }

  private async insertReviewAudit(
    action: string,
    decision: "allow" | "deny",
    actorId: string,
    submissionId: string | undefined,
    details: Record<string, unknown>,
    tx: DbLike = this.db,
  ): Promise<void> {
    await tx.insert(auditEvents).values({
      actorUserId: actorId,
      action,
      decision,
      resourceType: "skill_version",
      resourceId: submissionId && isUuid(submissionId) ? submissionId : null,
      details: sanitizeAuditDetails({
        submissionId,
        ...details,
      }),
    });
  }
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DbLike = Database | Transaction;

async function selectVersionForReview(db: DbLike, submissionId: string) {
  const [row] = await db
    .select({
      id: skillVersions.id,
      skillId: skills.id,
      slug: skills.slug,
      version: skillVersions.version,
      visibility: skills.visibility,
      lifecycleStatus: skills.lifecycleStatus,
      reviewStatus: skillVersions.reviewStatus,
      securityStatus: skillVersions.securityStatus,
      publishedAt: skillVersions.publishedAt,
      artifactId: skillArtifacts.id,
      artifactPayload: skillArtifacts.payload,
      succeededScanCount: sql<number>`count(distinct case when ${scanRuns.status} = 'succeeded' then ${scanRuns.id} end)::int`,
    })
    .from(skillVersions)
    .innerJoin(skills, eq(skillVersions.skillId, skills.id))
    .leftJoin(skillArtifacts, eq(skillArtifacts.skillVersionId, skillVersions.id))
    .leftJoin(scanRuns, eq(scanRuns.skillVersionId, skillVersions.id))
    .where(eq(skillVersions.id, submissionId))
    .groupBy(
      skillVersions.id,
      skills.id,
      skills.slug,
      skillVersions.version,
      skills.visibility,
      skills.lifecycleStatus,
      skillVersions.reviewStatus,
      skillVersions.securityStatus,
      skillVersions.publishedAt,
      skillArtifacts.id,
      skillArtifacts.payload,
    )
    .limit(1);
  return row ?? null;
}

function visibleReleasePredicate(): SQL | undefined {
  return and(
    eq(skills.lifecycleStatus, "approved"),
    eq(skills.visibility, "public"),
    eq(skillVersions.reviewStatus, "approved"),
    eq(skillVersions.securityStatus, "passed"),
    isNotNull(skillVersions.publishedAt),
  );
}

async function selectPublicRelease(db: DbLike, input: { slug: string; version: string }) {
  const [row] = await db
    .select({
      slug: skills.slug,
      title: skills.title,
      summary: skills.summary,
      version: skillVersions.version,
      reviewStatus: skillVersions.reviewStatus,
      securityStatus: skillVersions.securityStatus,
      publishedAt: skillVersions.publishedAt,
      platforms: sql<ReviewSubmissionSummary["platforms"]>`
        coalesce(
          json_agg(
            distinct jsonb_build_object(
              'name', ${skillPlatformVariants.name},
              'installTarget', ${skillPlatformVariants.installTarget},
              'status', ${skillPlatformVariants.status}
            )
          ) filter (where ${skillPlatformVariants.id} is not null),
          '[]'::json
        )
      `,
      sha256: skillArtifacts.sha256,
      byteSize: skillArtifacts.byteSize,
      contentType: skillArtifacts.contentType,
      payload: skillArtifacts.payload,
    })
    .from(skills)
    .innerJoin(skillVersions, eq(skillVersions.skillId, skills.id))
    .innerJoin(skillArtifacts, eq(skillArtifacts.skillVersionId, skillVersions.id))
    .leftJoin(skillPlatformVariants, eq(skillPlatformVariants.skillVersionId, skillVersions.id))
    .where(and(
      eq(skills.slug, input.slug),
      eq(skillVersions.version, input.version),
      visibleReleasePredicate(),
    ))
    .groupBy(
      skills.slug,
      skills.title,
      skills.summary,
      skillVersions.version,
      skillVersions.reviewStatus,
      skillVersions.securityStatus,
      skillVersions.publishedAt,
      skillArtifacts.sha256,
      skillArtifacts.byteSize,
      skillArtifacts.contentType,
      skillArtifacts.payload,
    )
    .limit(1);
  return row ?? null;
}

type PublicReleaseRow = NonNullable<Awaited<ReturnType<typeof selectPublicRelease>>>;

function publicRelease(row: PublicReleaseRow): PublicReleaseMetadata {
  if (!row.publishedAt) {
    throw new Error("Visible release query returned an unpublished version.");
  }
  return {
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    version: row.version,
    reviewStatus: "approved",
    securityStatus: "passed",
    publishedAt: row.publishedAt.toISOString(),
    platforms: row.platforms,
    artifact: {
      sha256: row.sha256,
      byteSize: row.byteSize,
      contentType: row.contentType,
    },
  };
}

function parseArtifactPayload(input: unknown): ArtifactPayload {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid artifact payload.");
  }
  const files = (input as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    throw new Error("Invalid artifact payload files.");
  }
  return {
    files: files.map((file) => {
      if (!file || typeof file !== "object" || Array.isArray(file)) {
        throw new Error("Invalid artifact payload file.");
      }
      const record = file as Record<string, unknown>;
      if (typeof record.path !== "string" || typeof record.content !== "string") {
        throw new Error("Invalid artifact payload file.");
      }
      return {
        path: record.path,
        content: record.content,
      };
    }),
  };
}

function manifestFromPayload(input: unknown) {
  const payload = parseArtifactPayload(input);
  const manifestFile = payload.files.find((file) => (
    file.path === "skill.json" ||
    file.path === "skill-manifest.json" ||
    file.path === "ai-skill.json"
  ));
  if (!manifestFile) {
    throw new AppError("Package manifest file is required before publication.", "PACKAGE_MANIFEST_REQUIRED", 422);
  }
  try {
    return parseSkillManifest(JSON.parse(manifestFile.content));
  } catch {
    throw new AppError("Package manifest is invalid.", "INVALID_PACKAGE_MANIFEST", 422);
  }
}

function isUuid(input: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input);
}
