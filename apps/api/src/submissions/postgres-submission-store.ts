import { and, eq, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { AppError, type SharingSettings, type SkillLifecycleStatus } from "@myskills-app/core";
import {
  loadSkillManifestFromPackageFiles,
  PackageManifestFileError,
} from "@myskills-app/skill-package";
import { assertArtifactBodyMatchesMetadata, parseArtifactPayload, readArtifactPayload } from "../artifacts/package-payload.js";
import { sanitizeAuditDetails, sanitizeAuditValue } from "../audit/sanitize.js";
import type { Database } from "../db/client.js";
import type { ArtifactObjectStorage } from "../artifacts/storage.js";
import {
  auditEvents,
  artifactWriteIntents,
  instanceSettings,
  organizationMemberships,
  organizationPolicyRevisions,
  organizations,
  scanFindings,
  scanRuns,
  skillArtifacts,
  skillOrganizationGrants,
  skillPlatformVariants,
  skills,
  skillTags,
  skillTeamGrants,
  skillUserGrants,
  skillVersions,
  teamMemberships,
  teams,
} from "../db/schema.js";
import type {
  CreateSubmissionInput,
  PublicBundle,
  PublicReleaseMetadata,
  ReleaseLifecycleAction,
  ReviewActionResult,
  ReviewSubmissionSummary,
  ReviewSubmissionBundle,
  SkillLifecycleAction,
  SkillManagementSummary,
  SkillMetadataUpdate,
  SkillReleaseSummary,
  StoredSubmission,
  SubmissionActor,
  SubmissionOwnerAction,
  SubmissionStore,
  UserSubmissionBundle,
  UserSubmissionSummary,
} from "./types.js";
import { assertNoVisibilityMetadataUpdate } from "./types.js";
import { artifactPayloadSha256 } from "./artifact-hash.js";

const DEFAULT_SHARING_SETTINGS: SharingSettings = {
  publicVisibilityEnabled: true,
  authenticatedVisibilityEnabled: true,
  teamsEnabled: true,
  teamVisibilityEnabled: true,
  userVisibilityEnabled: true,
  organizationVisibilityEnabled: false,
};

export class PostgresSubmissionStore implements SubmissionStore {
  constructor(
    private readonly db: Database,
    private readonly options: { artifactStorage?: ArtifactObjectStorage } = {},
  ) {}

  async createSubmission(input: CreateSubmissionInput & {
    artifact: StoredSubmission["artifact"];
    findings: StoredSubmission["scan"]["findings"];
    securityStatus: StoredSubmission["securityStatus"];
  }): Promise<StoredSubmission> {
    const recoveryTracked = await this.prepareArtifactWrite(input.artifact);
    try {
      const submission: StoredSubmission = await this.db.transaction(async (tx) => {
      const sharing = await getSharingSettings(tx);
      if (input.manifest.visibility === "organization" && !sharing.organizationVisibilityEnabled) {
        throw new AppError("Organization sharing is disabled for this instance.", "ORGANIZATION_SHARING_DISABLED", 403);
      }
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
          ownerUserId: existingSkill.ownerUserId ?? input.actor.id,
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
        lifecycleStatus: "submitted",
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
        payload: this.options.artifactStorage ? { files: [] } : input.artifact.payload,
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
        lifecycleStatus: version.lifecycleStatus,
        platforms: input.manifest.platforms.map((platform) => ({
          name: platform.name,
          installTarget: platform.install_target,
          status: platform.status,
        })),
        reviewStatus: version.reviewStatus,
        securityStatus: version.securityStatus,
        approvedArtifactSha256: version.approvedArtifactSha256,
        publishedAt: version.publishedAt?.toISOString() ?? null,
        ownerUserId: input.actor.id,
        createdAt: version.createdAt.toISOString(),
        artifact: input.artifact,
        scan: {
          status: "succeeded",
          findings: input.findings,
        },
      };
      });
      if (recoveryTracked) {
        try {
          await this.db.delete(artifactWriteIntents).where(eq(artifactWriteIntents.storageKey, input.artifact.storageKey));
        } catch {
          // The durable intent is safe to leave for startup reconciliation after the DB commit.
        }
      }
      return submission;
    } catch (error) {
      if (recoveryTracked) {
        await this.compensateArtifactWrite(input.artifact.storageKey, error);
      }
      throw error;
    }
  }

  async reconcilePendingArtifactWrites(options: { staleIntentMs?: number; limit?: number } = {}): Promise<{
    recovered: number;
    retained: number;
  }> {
    if (!this.options.artifactStorage) {
      return { recovered: 0, retained: 0 };
    }
    const staleBefore = new Date(Date.now() - (options.staleIntentMs ?? 15 * 60 * 1000));
    const rows = await this.db
      .select()
      .from(artifactWriteIntents)
      .where(and(
        inArray(artifactWriteIntents.state, ["reserved", "object_written"]),
        lt(artifactWriteIntents.updatedAt, staleBefore),
      ))
      .orderBy(artifactWriteIntents.updatedAt)
      .limit(Math.min(Math.max(options.limit ?? 100, 1), 1000));
    let recovered = 0;
    let retained = 0;
    for (const intent of rows) {
      const [referenced] = await this.db
        .select({ id: skillArtifacts.id })
        .from(skillArtifacts)
        .where(eq(skillArtifacts.storageKey, intent.storageKey))
        .limit(1);
      try {
        if (!referenced) {
          await this.options.artifactStorage.deleteObject(intent.storageKey);
        }
        await this.db.delete(artifactWriteIntents).where(eq(artifactWriteIntents.storageKey, intent.storageKey));
        recovered += 1;
      } catch {
        retained += 1;
        await this.db.update(artifactWriteIntents).set({
          state: "object_written",
          attempts: sql`${artifactWriteIntents.attempts} + 1`,
          lastError: "artifact_delete_failed",
          updatedAt: new Date(),
        }).where(eq(artifactWriteIntents.storageKey, intent.storageKey));
      }
    }
    return { recovered, retained };
  }

  async listUserSubmissions(userId: string): Promise<UserSubmissionSummary[]> {
    const rows = await selectUserSubmissions(this.db, userId);
    return rows.map(userSubmissionSummary);
  }

  async getUserSubmissionBundle(input: { userId: string; submissionId: string; platform?: string }): Promise<UserSubmissionBundle | null> {
    if (!isUuid(input.submissionId)) {
      return null;
    }
    const [row] = await selectUserSubmissions(this.db, input.userId, input.submissionId);
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
      ...userSubmissionSummary(row),
      payload: await readArtifactPayload({
        artifactStorage: this.options.artifactStorage,
        artifact: row,
      }),
    };
  }

  async performSubmissionOwnerAction(input: { actorId: string; submissionId: string; action: SubmissionOwnerAction; reason?: string }): Promise<UserSubmissionSummary> {
    if (input.action !== "withdraw") {
      throw new AppError("Unsupported submission action.", "INVALID_SUBMISSION_ACTION", 400);
    }
    if (!isUuid(input.submissionId)) {
      await this.insertReviewAudit("submission.withdraw", "deny", input.actorId, input.submissionId, {
        reason: "missing_submission",
      });
      throw new AppError("Submission not found.", "SUBMISSION_NOT_FOUND", 404);
    }
    await this.withDurableDenyAudit({
      action: "submission.withdraw",
      actorId: input.actorId,
      submissionId: input.submissionId,
    }, async (tx) => {
      const row = await selectUserSubmissionStateForUpdate(tx, input.actorId, input.submissionId);
      if (!row) {
        await this.insertReviewAudit("submission.withdraw", "deny", input.actorId, input.submissionId, {
          reason: "not_owner_or_missing",
        }, tx);
        throw new AppError("Submission not found.", "SUBMISSION_NOT_FOUND", 404);
      }
      if (row.deletedAt || !submissionAllowedActions(row).includes("withdraw")) {
        await this.insertReviewAudit("submission.withdraw", "deny", input.actorId, input.submissionId, {
          slug: row.slug,
          version: row.version,
          reason: "not_withdrawable",
        }, tx);
        throw new AppError("Submission cannot be withdrawn.", "SUBMISSION_NOT_WITHDRAWABLE", 409);
      }
      const now = new Date();
      const [updated] = await tx.update(skillVersions).set({
        reviewStatus: "rejected",
        lifecycleStatus: "archived",
        lifecycleReason: input.reason ?? "",
        lifecycleUpdatedAt: now,
        deletedAt: now,
      }).where(and(
        eq(skillVersions.id, input.submissionId),
        inArray(skillVersions.reviewStatus, ["unreviewed", "changes-requested"]),
        isNull(skillVersions.publishedAt),
        isNull(skillVersions.deletedAt),
      )).returning();
      if (!updated) {
        throw new Error("Submission withdrawal failed.");
      }
      await this.insertReviewAudit("submission.withdraw", "allow", input.actorId, input.submissionId, {
        slug: row.slug,
        version: row.version,
        reason: input.reason,
      }, tx);
    });
    const [updatedRow] = await selectUserSubmissions(this.db, input.actorId, input.submissionId);
    if (!updatedRow) {
      throw new Error("Submission withdrawal readback failed.");
    }
    return userSubmissionSummary(updatedRow);
  }

  async listReviewSubmissions(): Promise<ReviewSubmissionSummary[]> {
    const rows = await this.db
      .select({
        id: skillVersions.id,
        slug: skills.slug,
        title: skills.title,
        version: skillVersions.version,
        visibility: skills.visibility,
        skillLifecycleStatus: skills.lifecycleStatus,
        lifecycleStatus: skillVersions.lifecycleStatus,
        reviewStatus: skillVersions.reviewStatus,
        securityStatus: skillVersions.securityStatus,
        approvedArtifactSha256: skillVersions.approvedArtifactSha256,
        deletedAt: skillVersions.deletedAt,
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
      .where(and(
        isNull(skillVersions.deletedAt),
        ne(skillVersions.lifecycleStatus, "archived"),
        ne(skills.lifecycleStatus, "archived"),
        or(
          inArray(skillVersions.reviewStatus, ["unreviewed", "changes-requested"]),
          and(eq(skillVersions.reviewStatus, "approved"), isNull(skillVersions.publishedAt)),
        ),
      ))
      .groupBy(
        skillVersions.id,
        skills.slug,
        skills.title,
        skillVersions.version,
        skills.visibility,
        skills.lifecycleStatus,
        skillVersions.lifecycleStatus,
        skillVersions.reviewStatus,
        skillVersions.securityStatus,
        skillVersions.approvedArtifactSha256,
        skillVersions.deletedAt,
        skillVersions.createdAt,
      )
      .orderBy(sql`${skillVersions.createdAt} desc`)
      .limit(100);

    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      allowedActions: reviewAllowedActions(row),
    }));
  }

  async getReviewSubmissionBundle(input: { submissionId: string; platform?: string }): Promise<ReviewSubmissionBundle | null> {
    if (!isUuid(input.submissionId)) {
      return null;
    }
    const row = await selectVersionForReview(this.db, input.submissionId);
    if (!row || !isReviewQueueRow(row)) {
      return null;
    }
    if (input.platform && !row.platforms.some((platform) => (
      platform.name === input.platform &&
      platform.status === "supported"
    ))) {
      return null;
    }
    if (!row.artifactId || !row.storageKey || !row.sha256 || typeof row.byteSize !== "number" || !row.contentType) {
      return null;
    }
    const artifactPayload = await readArtifactPayload({
      artifactStorage: this.options.artifactStorage,
      artifact: {
        storageKey: row.storageKey,
        sha256: row.sha256,
        byteSize: row.byteSize,
        contentType: row.contentType,
        payload: row.artifactPayload,
      },
    });
    const body = JSON.stringify(artifactPayload);
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      version: row.version,
      visibility: row.visibility,
      lifecycleStatus: row.lifecycleStatus,
      reviewStatus: row.reviewStatus,
      securityStatus: row.securityStatus,
      approvedArtifactSha256: row.approvedArtifactSha256,
      platforms: row.platforms,
      findingCount: row.findingCount,
      createdAt: row.createdAt.toISOString(),
      allowedActions: reviewAllowedActions(row),
      artifact: {
        sha256: artifactPayloadSha256(artifactPayload),
        byteSize: Buffer.byteLength(body),
        contentType: row.contentType,
      },
      payload: artifactPayload,
    };
  }

  async approveSubmission(input: { actorId: string; submissionId: string; artifactSha256: string; reason?: string }): Promise<ReviewActionResult> {
    if (!isUuid(input.submissionId)) {
      await this.insertReviewAudit("review.approve", "deny", input.actorId, input.submissionId, {
        reason: "missing_submission",
      });
      throw new AppError("Submission not found.", "SUBMISSION_NOT_FOUND", 404);
    }

    const preparedRow = await selectVersionForReview(this.db, input.submissionId);
    const preparedArtifact = await this.requireApprovableArtifact(preparedRow, input);
    if (!preparedRow) {
      throw new Error("Submission approval preparation failed.");
    }
    const preparedArtifactPayloadJson = artifactPayloadJsonForRevalidation(preparedRow.artifactPayload);
    let currentArtifactSha256;
    try {
      const artifactPayload = await readArtifactPayload({
        artifactStorage: this.options.artifactStorage,
        artifact: {
          ...preparedArtifact,
          payload: preparedRow.artifactPayload,
        },
      });
      currentArtifactSha256 = artifactPayloadSha256(artifactPayload);
    } catch (error) {
      await this.insertReviewAudit("review.approve", "deny", input.actorId, input.submissionId, {
        slug: preparedRow?.slug,
        version: preparedRow?.version,
        reason: error instanceof AppError ? error.code : "invalid_artifact_payload",
      });
      throw error;
    }
    if (input.artifactSha256 !== currentArtifactSha256) {
      await this.insertReviewAudit("review.approve", "deny", input.actorId, input.submissionId, {
        slug: preparedRow?.slug,
        version: preparedRow?.version,
        reason: "artifact_hash_mismatch",
      });
      throw new AppError("Approval artifact hash does not match the current submission artifact.", "ARTIFACT_HASH_MISMATCH", 409);
    }

    return this.withDurableDenyAudit({
      action: "review.approve",
      actorId: input.actorId,
      submissionId: input.submissionId,
    }, async (tx) => {
      const row = await selectVersionForReviewRevalidation(tx, input.submissionId, preparedArtifactPayloadJson);
      const currentArtifact = await this.requireApprovableArtifact(row, input, tx);
      if (!row) {
        throw new Error("Submission approval revalidation failed.");
      }
      if (!sameReviewArtifact(currentArtifact, preparedArtifact) || !row.artifactPayloadMatches) {
        await this.insertReviewAudit("review.approve", "deny", input.actorId, input.submissionId, {
          slug: row.slug,
          version: row.version,
          reason: "artifact_hash_mismatch",
        }, tx);
        throw new AppError("Approval artifact hash does not match the current submission artifact.", "ARTIFACT_HASH_MISMATCH", 409);
      }

      const now = new Date();
      const [updatedVersion] = await tx.update(skillVersions).set({
        reviewStatus: "approved",
        lifecycleStatus: "review",
        approvedArtifactSha256: input.artifactSha256,
        lifecycleUpdatedAt: now,
      }).where(and(
        eq(skillVersions.id, input.submissionId),
        eq(skillVersions.reviewStatus, row.reviewStatus),
        eq(skillVersions.securityStatus, "passed"),
        eq(skillVersions.lifecycleStatus, row.lifecycleStatus),
        isNull(skillVersions.deletedAt),
      )).returning();
      if (!updatedVersion) {
        await this.insertReviewAudit("review.approve", "deny", input.actorId, input.submissionId, {
          slug: row.slug,
          version: row.version,
          reason: "stale_submission_state",
        }, tx);
        throw new AppError("Submission is not reviewable.", "SUBMISSION_NOT_REVIEWABLE", 409);
      }

      await this.insertReviewAudit("review.approve", "allow", input.actorId, input.submissionId, {
        slug: row.slug,
        version: row.version,
        artifactSha256: input.artifactSha256,
        reason: input.reason,
      }, tx);

      return {
        id: updatedVersion.id,
        slug: row.slug,
        version: updatedVersion.version,
        visibility: row.visibility,
        lifecycleStatus: updatedVersion.lifecycleStatus,
        reviewStatus: updatedVersion.reviewStatus,
        securityStatus: updatedVersion.securityStatus,
        approvedArtifactSha256: updatedVersion.approvedArtifactSha256,
        publishedAt: updatedVersion.publishedAt?.toISOString() ?? null,
      };
    });
  }

  async requestChanges(input: { actorId: string; submissionId: string; reason?: string }): Promise<ReviewActionResult> {
    if (!isUuid(input.submissionId)) {
      await this.insertReviewAudit("review.request_changes", "deny", input.actorId, input.submissionId, {
        reason: "missing_submission",
      });
      throw new AppError("Submission not found.", "SUBMISSION_NOT_FOUND", 404);
    }

    return this.withDurableDenyAudit({
      action: "review.request_changes",
      actorId: input.actorId,
      submissionId: input.submissionId,
    }, async (tx) => {
      const row = await selectVersionForReviewState(tx, input.submissionId);
      if (!row) {
        await this.insertReviewAudit("review.request_changes", "deny", input.actorId, input.submissionId, {
          reason: "missing_submission",
        }, tx);
        throw new AppError("Submission not found.", "SUBMISSION_NOT_FOUND", 404);
      }
      if (!isActiveReviewRow(row) || !["unreviewed", "changes-requested"].includes(row.reviewStatus)) {
        await this.insertReviewAudit("review.request_changes", "deny", input.actorId, input.submissionId, {
          slug: row.slug,
          version: row.version,
          reason: "not_reviewable",
        }, tx);
        throw new AppError("Submission is not reviewable.", "SUBMISSION_NOT_REVIEWABLE", 409);
      }
      const [updatedVersion] = await tx.update(skillVersions).set({
        reviewStatus: "changes-requested",
        lifecycleStatus: "review",
        lifecycleReason: input.reason ?? "",
        lifecycleUpdatedAt: new Date(),
      }).where(eq(skillVersions.id, input.submissionId)).returning();
      if (!updatedVersion) {
        throw new Error("Submission review update failed.");
      }
      await this.insertReviewAudit("review.request_changes", "allow", input.actorId, input.submissionId, {
        slug: row.slug,
        version: row.version,
        reason: input.reason,
      }, tx);
      return reviewResultFromVersion(row, updatedVersion);
    });
  }

  async rejectSubmission(input: { actorId: string; submissionId: string; reason?: string }): Promise<ReviewActionResult> {
    if (!isUuid(input.submissionId)) {
      await this.insertReviewAudit("review.reject", "deny", input.actorId, input.submissionId, {
        reason: "missing_submission",
      });
      throw new AppError("Submission not found.", "SUBMISSION_NOT_FOUND", 404);
    }

    return this.withDurableDenyAudit({
      action: "review.reject",
      actorId: input.actorId,
      submissionId: input.submissionId,
    }, async (tx) => {
      const row = await selectVersionForReviewState(tx, input.submissionId);
      if (!row) {
        await this.insertReviewAudit("review.reject", "deny", input.actorId, input.submissionId, {
          reason: "missing_submission",
        }, tx);
        throw new AppError("Submission not found.", "SUBMISSION_NOT_FOUND", 404);
      }
      if (!isActiveReviewRow(row) || !["unreviewed", "changes-requested"].includes(row.reviewStatus)) {
        await this.insertReviewAudit("review.reject", "deny", input.actorId, input.submissionId, {
          slug: row.slug,
          version: row.version,
          reason: "not_reviewable",
        }, tx);
        throw new AppError("Submission is not reviewable.", "SUBMISSION_NOT_REVIEWABLE", 409);
      }
      const [updatedVersion] = await tx.update(skillVersions).set({
        reviewStatus: "rejected",
        lifecycleStatus: "archived",
        lifecycleReason: input.reason ?? "",
        lifecycleUpdatedAt: new Date(),
        deletedAt: new Date(),
      }).where(eq(skillVersions.id, input.submissionId)).returning();
      if (!updatedVersion) {
        throw new Error("Submission rejection failed.");
      }
      await this.insertReviewAudit("review.reject", "allow", input.actorId, input.submissionId, {
        slug: row.slug,
        version: row.version,
        reason: input.reason,
      }, tx);
      return reviewResultFromVersion(row, updatedVersion);
    });
  }

  async publishSubmission(input: { actorId: string; submissionId: string; reason?: string }): Promise<ReviewActionResult> {
    if (!isUuid(input.submissionId)) {
      await this.insertReviewAudit("release.publish", "deny", input.actorId, input.submissionId, {
        reason: "missing_submission",
      });
      throw new AppError("Submission not found.", "SUBMISSION_NOT_FOUND", 404);
    }

    const preparedRow = await selectVersionForReview(this.db, input.submissionId);
    const preparedArtifact = await this.requirePublishableArtifact(preparedRow, input);
    if (!preparedRow || !preparedRow.approvedArtifactSha256) {
      throw new Error("Submission publication preparation failed.");
    }
    const preparedArtifactPayloadJson = artifactPayloadJsonForRevalidation(preparedRow.artifactPayload);
    const preparedApprovedArtifactSha256 = preparedRow.approvedArtifactSha256;
    let manifest: ReturnType<typeof manifestFromPayload>;
    try {
      const artifactPayload = await readArtifactPayload({
        artifactStorage: this.options.artifactStorage,
        artifact: {
          ...preparedArtifact,
          payload: preparedRow.artifactPayload,
        },
      });
      if (preparedApprovedArtifactSha256 !== artifactPayloadSha256(artifactPayload)) {
        throw new AppError("Approved artifact hash does not match the current submission artifact.", "APPROVED_ARTIFACT_HASH_MISMATCH", 409);
      }
      manifest = manifestFromPayload(artifactPayload);
    } catch (error) {
      await this.insertReviewAudit("release.publish", "deny", input.actorId, input.submissionId, {
        slug: preparedRow?.slug,
        version: preparedRow?.version,
        reason: error instanceof AppError ? error.code : "invalid_artifact_manifest",
      });
      throw error;
    }
    if (manifest.name !== preparedRow.slug || manifest.version !== preparedRow.version || manifest.visibility !== preparedRow.visibility) {
      await this.insertReviewAudit("release.publish", "deny", input.actorId, input.submissionId, {
        slug: preparedRow.slug,
        version: preparedRow.version,
        reason: "manifest_mismatch",
      });
      throw new AppError("Package manifest does not match the reviewed submission.", "PACKAGE_MANIFEST_MISMATCH", 422);
    }

    return this.withDurableDenyAudit({
      action: "release.publish",
      actorId: input.actorId,
      submissionId: input.submissionId,
    }, async (tx) => {
      const row = await selectVersionForReviewRevalidation(tx, input.submissionId, preparedArtifactPayloadJson);
      const currentArtifact = await this.requirePublishableArtifact(row, input, tx);
      if (!row) {
        throw new Error("Submission publication revalidation failed.");
      }
      if (!sameReviewArtifact(currentArtifact, preparedArtifact) || !row.artifactPayloadMatches || row.approvedArtifactSha256 !== preparedApprovedArtifactSha256) {
        await this.insertReviewAudit("release.publish", "deny", input.actorId, input.submissionId, {
          slug: row.slug,
          version: row.version,
          reason: "approved_artifact_hash_mismatch",
        }, tx);
        throw new AppError("Approved artifact hash does not match the current submission artifact.", "APPROVED_ARTIFACT_HASH_MISMATCH", 409);
      }
      if (manifest.name !== row.slug || manifest.version !== row.version || manifest.visibility !== row.visibility) {
        await this.insertReviewAudit("release.publish", "deny", input.actorId, input.submissionId, {
          slug: row.slug,
          version: row.version,
          reason: "manifest_mismatch",
        }, tx);
        throw new AppError("Package manifest does not match the reviewed submission.", "PACKAGE_MANIFEST_MISMATCH", 422);
      }
      const now = new Date();
      const [updatedVersion] = await tx.update(skillVersions).set({
        publishedAt: now,
        lifecycleStatus: "approved",
        lifecycleReason: input.reason ?? "",
        lifecycleUpdatedAt: now,
        deletedAt: null,
      }).where(and(
        eq(skillVersions.id, input.submissionId),
        eq(skillVersions.reviewStatus, "approved"),
        eq(skillVersions.securityStatus, "passed"),
        eq(skillVersions.lifecycleStatus, row.lifecycleStatus),
        eq(skillVersions.approvedArtifactSha256, preparedApprovedArtifactSha256),
        isNull(skillVersions.publishedAt),
        isNull(skillVersions.deletedAt),
      )).returning();
      if (!updatedVersion) {
        await this.insertReviewAudit("release.publish", "deny", input.actorId, input.submissionId, {
          slug: row.slug,
          version: row.version,
          reason: "stale_submission_state",
        }, tx);
        throw new AppError("Submission is not reviewable.", "SUBMISSION_NOT_REVIEWABLE", 409);
      }
      await tx.update(skills).set({
        title: manifest.title,
        summary: manifest.summary,
        visibility: manifest.visibility,
        lifecycleStatus: updatedVersion.lifecycleStatus,
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
        approvedArtifactSha256: updatedVersion.approvedArtifactSha256,
        publishedAt: updatedVersion.publishedAt?.toISOString() ?? null,
      };
    });
  }

  async getSkillManagement(input: { slug: string; actor: SubmissionActor }): Promise<SkillManagementSummary | null> {
    const skill = await findSkillForManagement(this.db, input.slug);
    if (!skill) {
      return null;
    }
    assertCanManageSkill(skill, input.actor);
    return skillManagementSummary(this.db, skill);
  }

  async updateSkillMetadata(input: { slug: string; actor: SubmissionActor; update: SkillMetadataUpdate; reason?: string }): Promise<SkillManagementSummary> {
    assertNoVisibilityMetadataUpdate(input.update);
    return this.db.transaction(async (tx) => {
      const skill = await findSkillForManagement(tx, input.slug);
      if (!skill) {
        throw new AppError("Skill not found.", "SKILL_NOT_FOUND", 404);
      }
      assertCanManageSkill(skill, input.actor);
      const update: Partial<typeof skills.$inferInsert> = { updatedAt: new Date() };
      if (input.update.title !== undefined) {
        update.title = input.update.title;
      }
      if (input.update.summary !== undefined) {
        update.summary = input.update.summary;
      }
      await tx.update(skills).set(update).where(eq(skills.id, skill.id));
      if (input.update.tags) {
        await tx.delete(skillTags).where(eq(skillTags.skillId, skill.id));
        if (input.update.tags.length > 0) {
          await tx.insert(skillTags).values(uniqueStrings(input.update.tags).map((tag) => ({
            skillId: skill.id,
            tag,
          }))).onConflictDoNothing();
        }
      }
      await tx.insert(auditEvents).values({
        actorUserId: input.actor.id,
        action: "skill.metadata.update",
        decision: "allow",
        resourceType: "skill",
        resourceId: skill.id,
        details: sanitizeAuditDetails({
          slug: input.slug,
          fields: Object.keys(input.update),
          reason: input.reason,
        }),
      });
      const updatedSkill = await findSkillForManagement(tx, input.slug);
      if (!updatedSkill) {
        throw new Error("Skill metadata update failed.");
      }
      return skillManagementSummary(tx, updatedSkill);
    });
  }

  async performSkillAction(input: { slug: string; actor: SubmissionActor; action: SkillLifecycleAction; reason?: string }): Promise<SkillManagementSummary> {
    return this.db.transaction(async (tx) => {
      const skill = await findSkillForManagement(tx, input.slug);
      if (!skill) {
        throw new AppError("Skill not found.", "SKILL_NOT_FOUND", 404);
      }
      assertCanManageSkill(skill, input.actor);
      const lifecycleStatus = input.action === "restore"
        ? await restoredSkillLifecycle(tx, skill.id)
        : "archived";
      await tx.update(skills).set({
        lifecycleStatus,
        updatedAt: new Date(),
      }).where(eq(skills.id, skill.id));
      await tx.insert(auditEvents).values({
        actorUserId: input.actor.id,
        action: `skill.${input.action}`,
        decision: "allow",
        resourceType: "skill",
        resourceId: skill.id,
        details: sanitizeAuditDetails({
          slug: input.slug,
          lifecycleStatus,
          reason: input.reason,
        }),
      });
      const updatedSkill = await findSkillForManagement(tx, input.slug);
      if (!updatedSkill) {
        throw new Error("Skill lifecycle update failed.");
      }
      return skillManagementSummary(tx, updatedSkill);
    });
  }

  async listSkillReleases(input: { slug: string; actor?: SubmissionActor | null }): Promise<SkillReleaseSummary[]> {
    const skill = await findSkillForManagement(this.db, input.slug);
    if (!skill) {
      return [];
    }
    const sharing = await getSharingSettings(this.db);
    const canManage = Boolean(input.actor && canManageSkill(skill, input.actor));
    const rows = await selectSkillReleaseRows(this.db, {
      slug: input.slug,
      where: canManage
        ? eq(skills.slug, input.slug)
        : and(
            eq(skills.slug, input.slug),
            visibleReleasePredicate(),
            visibleToActorPredicate(input.actor?.id ?? null, sharing),
          ),
    });
    return rows.map((row) => releaseSummary(row, input.actor ?? null));
  }

  async performReleaseAction(input: { slug: string; version: string; actor: SubmissionActor; action: ReleaseLifecycleAction; reason?: string; replacement?: string }): Promise<SkillReleaseSummary> {
    await this.withDurableDenyAudit({
      action: `release.${input.action}`,
      actorId: input.actor.id,
      details: { slug: input.slug, version: input.version },
    }, async (tx) => {
      const skill = await findSkillForManagement(tx, input.slug);
      if (!skill) {
        throw new AppError("Release not found.", "RELEASE_NOT_FOUND", 404);
      }
      assertCanManageSkill(skill, input.actor);
      const row = await selectSkillReleaseActionStateForUpdate(tx, input);
      if (!row) {
        throw new AppError("Release not found.", "RELEASE_NOT_FOUND", 404);
      }
      if (input.action === "restore" && row.lifecycleStatus === "revoked") {
        if (!isPrivilegedReleaseActor(input.actor)) {
          throw new AppError("Restoring a revoked release requires maintainer permissions.", "RELEASE_RESTORE_ROLE_REQUIRED", 403);
        }
        if (!isSafeRevokedRestore(row)) {
          throw new AppError("Revoked release artifact and scan state must be safe before restore.", "RELEASE_RESTORE_UNSAFE", 409);
        }
      }
      const allowed = releaseAllowedActions(row);
      if (!allowed.includes(input.action)) {
        await this.insertReviewAudit(`release.${input.action}`, "deny", input.actor.id, row.id, {
          slug: input.slug,
          version: input.version,
          reason: "action_not_allowed",
        }, tx);
        throw new AppError("Release action is not allowed.", "RELEASE_ACTION_NOT_ALLOWED", 409);
      }
      const now = new Date();
      const lifecycleStatus = lifecycleForReleaseAction(input.action);
      const [updatedVersion] = await tx.update(skillVersions).set({
        lifecycleStatus,
        lifecycleReason: input.reason ?? "",
        lifecycleUpdatedAt: now,
        deletedAt: input.action === "delete" ? now : null,
      }).where(and(
        eq(skillVersions.id, row.id),
        eq(skillVersions.lifecycleStatus, row.lifecycleStatus),
        eq(skillVersions.reviewStatus, row.reviewStatus),
        eq(skillVersions.securityStatus, row.securityStatus),
        row.publishedAt ? eq(skillVersions.publishedAt, row.publishedAt) : isNull(skillVersions.publishedAt),
        row.deletedAt ? eq(skillVersions.deletedAt, row.deletedAt) : isNull(skillVersions.deletedAt),
      )).returning({ id: skillVersions.id });
      if (!updatedVersion) {
        throw new Error("Release lifecycle update failed.");
      }
      await this.insertReviewAudit(`release.${input.action}`, "allow", input.actor.id, row.id, {
        slug: input.slug,
        version: input.version,
        replacement: input.replacement,
        reason: input.reason,
      }, tx);
    });
    const [updated] = await selectSkillReleaseRows(this.db, {
      slug: input.slug,
      where: and(eq(skills.slug, input.slug), eq(skillVersions.version, input.version)),
      limit: 1,
    });
    if (!updated) {
      throw new Error("Release lifecycle update failed.");
    }
    return releaseSummary(updated, input.actor);
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

  async getPublicRelease(input: { slug: string; version: string; actorId?: string | null }): Promise<PublicReleaseMetadata | null> {
    const row = await selectVisibleRelease(this.db, input, await getSharingSettings(this.db));
    return row ? publicRelease(row) : null;
  }

  async getPublicBundle(input: { slug: string; version: string; platform?: string; actorId?: string | null }): Promise<PublicBundle | null> {
    const row = await selectVisibleRelease(this.db, input, await getSharingSettings(this.db));
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
      payload: await readArtifactPayload({
        artifactStorage: this.options.artifactStorage,
        artifact: row,
      }),
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

  private async withDurableDenyAudit<T>(
    audit: {
      action: string;
      actorId: string;
      submissionId?: string;
      details?: Record<string, unknown>;
    },
    operation: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.transaction(operation);
    } catch (error) {
      if (error instanceof AppError) {
        await this.insertReviewAudit(audit.action, "deny", audit.actorId, audit.submissionId, {
          ...audit.details,
          reason: reviewAuditReason(error),
        });
      }
      throw error;
    }
  }

  private async requireApprovableArtifact(
    row: ApprovableReviewRow | null,
    input: { actorId: string; submissionId: string },
    tx: DbLike = this.db,
  ): Promise<ReviewArtifactMetadata> {
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
    if (!isActiveReviewRow(row)) {
      await this.insertReviewAudit("review.approve", "deny", input.actorId, input.submissionId, {
        slug: row.slug,
        version: row.version,
        reason: "not_reviewable",
      }, tx);
      throw new AppError("Submission is not reviewable.", "SUBMISSION_NOT_REVIEWABLE", 409);
    }
    const artifact = reviewArtifactMetadata(row);
    if (!artifact) {
      await this.insertReviewAudit("review.approve", "deny", input.actorId, input.submissionId, {
        slug: row.slug,
        version: row.version,
        reason: "missing_artifact_metadata",
      }, tx);
      throw new AppError("Submission artifact metadata is required before approval.", "PACKAGE_ARTIFACT_REQUIRED", 422);
    }
    return artifact;
  }

  private async requirePublishableArtifact(
    row: PublishableReviewRow | null,
    input: { actorId: string; submissionId: string },
    tx: DbLike = this.db,
  ): Promise<ReviewArtifactMetadata> {
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
    if (!isActiveReviewRow(row)) {
      await this.insertReviewAudit("release.publish", "deny", input.actorId, input.submissionId, {
        slug: row.slug,
        version: row.version,
        reason: "not_reviewable",
      }, tx);
      throw new AppError("Submission is not reviewable.", "SUBMISSION_NOT_REVIEWABLE", 409);
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
    const artifact = reviewArtifactMetadata(row);
    if (!artifact) {
      await this.insertReviewAudit("release.publish", "deny", input.actorId, input.submissionId, {
        slug: row.slug,
        version: row.version,
        reason: "missing_artifact_metadata",
      }, tx);
      throw new AppError("Submission artifact metadata is required before publication.", "PACKAGE_ARTIFACT_REQUIRED", 422);
    }
    if (!row.approvedArtifactSha256) {
      await this.insertReviewAudit("release.publish", "deny", input.actorId, input.submissionId, {
        slug: row.slug,
        version: row.version,
        reason: "missing_approved_artifact_hash",
      }, tx);
      throw new AppError("Submission approval must include an artifact hash before publication.", "APPROVED_ARTIFACT_HASH_REQUIRED", 409);
    }
    return artifact;
  }

  private async writeArtifactObject(artifact: StoredSubmission["artifact"]): Promise<void> {
    if (!this.options.artifactStorage) {
      return;
    }
    const body = JSON.stringify(artifact.payload);
    assertArtifactBodyMatchesMetadata(body, artifact);
    await this.options.artifactStorage.putObject({
      key: artifact.storageKey,
      body,
      contentType: artifact.contentType,
      sha256: artifact.sha256,
    });
  }

  private async prepareArtifactWrite(artifact: StoredSubmission["artifact"]): Promise<boolean> {
    if (!this.options.artifactStorage) {
      return false;
    }
    await this.db.insert(artifactWriteIntents).values({ storageKey: artifact.storageKey });
    let putAttempted = false;
    try {
      putAttempted = true;
      await this.writeArtifactObject(artifact);
      await this.db.update(artifactWriteIntents).set({
        state: "object_written",
        updatedAt: new Date(),
      }).where(eq(artifactWriteIntents.storageKey, artifact.storageKey));
      return true;
    } catch (error) {
      if (putAttempted) {
        try {
          await this.options.artifactStorage.deleteObject(artifact.storageKey);
        } catch (compensationError) {
          try {
            await this.db.update(artifactWriteIntents).set({
              state: "object_written",
              attempts: sql`${artifactWriteIntents.attempts} + 1`,
              lastError: "artifact_delete_failed",
              updatedAt: new Date(),
            }).where(eq(artifactWriteIntents.storageKey, artifact.storageKey));
          } catch {
            // The original reserved intent remains durable for stale-intent reconciliation.
          }
          throw new AggregateError([error, compensationError], `Artifact write recovery is pending for ${artifact.storageKey}.`);
        }
      }
      await this.db.delete(artifactWriteIntents).where(eq(artifactWriteIntents.storageKey, artifact.storageKey));
      throw error;
    }
  }

  private async compensateArtifactWrite(storageKey: string, originalError: unknown): Promise<void> {
    if (!this.options.artifactStorage) {
      return;
    }
    try {
      await this.options.artifactStorage.deleteObject(storageKey);
      await this.db.delete(artifactWriteIntents).where(eq(artifactWriteIntents.storageKey, storageKey));
    } catch (compensationError) {
      await this.db.update(artifactWriteIntents).set({
        state: "object_written",
        attempts: sql`${artifactWriteIntents.attempts} + 1`,
        lastError: "artifact_delete_failed",
        updatedAt: new Date(),
      }).where(eq(artifactWriteIntents.storageKey, storageKey));
      throw new AggregateError(
        [originalError, compensationError],
        `Submission failed and artifact recovery is pending for ${storageKey}.`,
      );
    }
  }
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DbLike = Database | Transaction;
type ReviewVersionRow = NonNullable<Awaited<ReturnType<typeof selectVersionForReview>>>;
type ReviewStateRow = Pick<
  ReviewVersionRow,
  "slug" | "version" | "visibility" | "skillLifecycleStatus" | "lifecycleStatus" | "reviewStatus" | "deletedAt"
>;
type ReviewArtifactFields = {
  artifactId: string | null;
  storageKey: string | null;
  sha256: string | null;
  byteSize: number | null;
  contentType: string | null;
};
type ApprovableReviewRow = ReviewArtifactFields & Pick<
  ReviewVersionRow,
  "slug" | "version" | "visibility" | "skillLifecycleStatus" | "lifecycleStatus" | "reviewStatus" | "securityStatus" | "deletedAt"
>;
type PublishableReviewRow = ApprovableReviewRow & {
  skillId: string;
  approvedArtifactSha256?: string | null;
  publishedAt?: Date | null;
  succeededScanCount: number;
  artifactPayloadMatches?: boolean;
};
type ReviewArtifactMetadata = {
  artifactId: string;
  storageKey: string;
  sha256: string;
  byteSize: number;
  contentType: string;
};

type ManagedSkillRow = NonNullable<Awaited<ReturnType<typeof findSkillForManagement>>>;

function reviewArtifactMetadata(row: ReviewArtifactFields): ReviewArtifactMetadata | null {
  if (!row.artifactId || !row.storageKey || !row.sha256 || typeof row.byteSize !== "number" || !row.contentType) {
    return null;
  }
  return {
    artifactId: row.artifactId,
    storageKey: row.storageKey,
    sha256: row.sha256,
    byteSize: row.byteSize,
    contentType: row.contentType,
  };
}

function sameReviewArtifact(left: ReviewArtifactMetadata, right: ReviewArtifactMetadata): boolean {
  return left.artifactId === right.artifactId &&
    left.storageKey === right.storageKey &&
    left.sha256 === right.sha256 &&
    left.byteSize === right.byteSize &&
    left.contentType === right.contentType;
}

function artifactPayloadJsonForRevalidation(input: unknown): string {
  const json = JSON.stringify(input);
  if (typeof json !== "string") {
    throw new Error("Artifact payload JSON is required.");
  }
  return json;
}

async function findSkillForManagement(db: DbLike, slug: string) {
  const [skill] = await db
    .select({
      id: skills.id,
      slug: skills.slug,
      title: skills.title,
      summary: skills.summary,
      lifecycleStatus: skills.lifecycleStatus,
      visibility: skills.visibility,
      ownerUserId: skills.ownerUserId,
    })
    .from(skills)
    .where(eq(skills.slug, slug))
    .limit(1);
  return skill ?? null;
}

function canManageSkill(skill: { ownerUserId: string | null }, actor: SubmissionActor): boolean {
  return skill.ownerUserId === actor.id || actor.roles.some((role) => role === "owner" || role === "admin" || role === "maintainer");
}

function assertCanManageSkill(skill: { ownerUserId: string | null }, actor: SubmissionActor): void {
  if (!canManageSkill(skill, actor)) {
    throw new AppError("Skill management requires owner or maintainer permissions.", "SKILL_MANAGEMENT_ROLE_REQUIRED", 403);
  }
}

async function skillManagementSummary(db: DbLike, skill: ManagedSkillRow): Promise<SkillManagementSummary> {
  const tags = await db
    .select({ tag: skillTags.tag })
    .from(skillTags)
    .where(eq(skillTags.skillId, skill.id))
    .orderBy(skillTags.tag);
  return {
    slug: skill.slug,
    title: skill.title,
    summary: skill.summary,
    lifecycleStatus: skill.lifecycleStatus,
    visibility: skill.visibility,
    tags: tags.map((row) => row.tag),
    allowedActions: ["edit", "archive", "restore", "delete"],
  };
}

async function restoredSkillLifecycle(db: DbLike, skillId: string): Promise<SkillLifecycleStatus> {
  const [visible] = await db
    .select({ id: skillVersions.id })
    .from(skillVersions)
    .where(and(
      eq(skillVersions.skillId, skillId),
      inArray(skillVersions.lifecycleStatus, ["approved", "deprecated"]),
      eq(skillVersions.reviewStatus, "approved"),
      eq(skillVersions.securityStatus, "passed"),
      isNotNull(skillVersions.publishedAt),
      isNull(skillVersions.deletedAt),
    ))
    .limit(1);
  if (visible) {
    return "approved";
  }
  const [published] = await db
    .select({ id: skillVersions.id })
    .from(skillVersions)
    .where(and(eq(skillVersions.skillId, skillId), isNotNull(skillVersions.publishedAt)))
    .limit(1);
  if (published) {
    return "unpublished";
  }
  const [active] = await db
    .select({ id: skillVersions.id })
    .from(skillVersions)
    .where(and(eq(skillVersions.skillId, skillId), sql`${skillVersions.reviewStatus} <> 'rejected'`))
    .limit(1);
  return active ? "submitted" : "archived";
}

async function selectUserSubmissions(db: DbLike, userId: string, submissionId?: string) {
  const where = submissionId
    ? and(eq(skills.ownerUserId, userId), eq(skillVersions.id, submissionId))
    : eq(skills.ownerUserId, userId);
  return db
    .select({
      id: skillVersions.id,
      slug: skills.slug,
      title: skills.title,
      summary: skills.summary,
      version: skillVersions.version,
      visibility: skills.visibility,
      lifecycleStatus: skillVersions.lifecycleStatus,
      reviewStatus: skillVersions.reviewStatus,
      securityStatus: skillVersions.securityStatus,
      publishedAt: skillVersions.publishedAt,
      createdAt: skillVersions.createdAt,
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
      sha256: skillArtifacts.sha256,
      byteSize: skillArtifacts.byteSize,
      contentType: skillArtifacts.contentType,
      storageKey: skillArtifacts.storageKey,
      payload: skillArtifacts.payload,
    })
    .from(skillVersions)
    .innerJoin(skills, eq(skillVersions.skillId, skills.id))
    .innerJoin(skillArtifacts, eq(skillArtifacts.skillVersionId, skillVersions.id))
    .leftJoin(skillPlatformVariants, eq(skillPlatformVariants.skillVersionId, skillVersions.id))
    .leftJoin(scanRuns, eq(scanRuns.skillVersionId, skillVersions.id))
    .leftJoin(scanFindings, eq(scanFindings.scanRunId, scanRuns.id))
    .where(where)
    .groupBy(
      skillVersions.id,
      skills.slug,
      skills.title,
      skills.summary,
      skillVersions.version,
      skills.visibility,
      skillVersions.lifecycleStatus,
      skillVersions.reviewStatus,
      skillVersions.securityStatus,
      skillVersions.publishedAt,
      skillVersions.createdAt,
      skillArtifacts.sha256,
      skillArtifacts.byteSize,
      skillArtifacts.contentType,
      skillArtifacts.storageKey,
      skillArtifacts.payload,
    )
    .orderBy(sql`${skillVersions.createdAt} desc`)
    .limit(submissionId ? 1 : 100);
}

async function selectUserSubmissionStateForUpdate(db: DbLike, userId: string, submissionId: string) {
  const [row] = await db
    .select({
      id: skillVersions.id,
      slug: skills.slug,
      version: skillVersions.version,
      lifecycleStatus: skillVersions.lifecycleStatus,
      reviewStatus: skillVersions.reviewStatus,
      publishedAt: skillVersions.publishedAt,
      deletedAt: skillVersions.deletedAt,
    })
    .from(skillVersions)
    .innerJoin(skills, eq(skillVersions.skillId, skills.id))
    .where(and(eq(skills.ownerUserId, userId), eq(skillVersions.id, submissionId)))
    .for("update", { of: skillVersions })
    .limit(1);
  return row ?? null;
}

type UserSubmissionRow = Awaited<ReturnType<typeof selectUserSubmissions>>[number];

function userSubmissionSummary(row: UserSubmissionRow): UserSubmissionSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    version: row.version,
    visibility: row.visibility,
    lifecycleStatus: row.lifecycleStatus,
    reviewStatus: row.reviewStatus,
    securityStatus: row.securityStatus,
    platforms: row.platforms,
    findingCount: row.findingCount,
    artifact: {
      sha256: row.sha256,
      byteSize: row.byteSize,
      contentType: row.contentType,
    },
    createdAt: row.createdAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    allowedActions: submissionAllowedActions(row),
  };
}

async function selectSkillReleaseRows(
  db: DbLike,
  input: { slug: string; where: SQL | undefined; limit?: number },
) {
  return db
    .select({
      id: skillVersions.id,
      slug: skills.slug,
      version: skillVersions.version,
      lifecycleStatus: skillVersions.lifecycleStatus,
      reviewStatus: skillVersions.reviewStatus,
      securityStatus: skillVersions.securityStatus,
      publishedAt: skillVersions.publishedAt,
      createdAt: skillVersions.createdAt,
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
    })
    .from(skillVersions)
    .innerJoin(skills, eq(skillVersions.skillId, skills.id))
    .innerJoin(skillArtifacts, eq(skillArtifacts.skillVersionId, skillVersions.id))
    .leftJoin(skillPlatformVariants, eq(skillPlatformVariants.skillVersionId, skillVersions.id))
    .leftJoin(scanRuns, eq(scanRuns.skillVersionId, skillVersions.id))
    .leftJoin(scanFindings, eq(scanFindings.scanRunId, scanRuns.id))
    .where(input.where)
    .groupBy(
      skillVersions.id,
      skills.slug,
      skillVersions.version,
      skillVersions.lifecycleStatus,
      skillVersions.reviewStatus,
      skillVersions.securityStatus,
      skillVersions.publishedAt,
      skillVersions.createdAt,
    )
    .orderBy(sql`${skillVersions.createdAt} desc`)
    .limit(input.limit ?? 100);
}

async function selectSkillReleaseActionStateForUpdate(db: DbLike, input: { slug: string; version: string }) {
  const [row] = await db
    .select({
      id: skillVersions.id,
      lifecycleStatus: skillVersions.lifecycleStatus,
      reviewStatus: skillVersions.reviewStatus,
      securityStatus: skillVersions.securityStatus,
      approvedArtifactSha256: skillVersions.approvedArtifactSha256,
      publishedAt: skillVersions.publishedAt,
      deletedAt: skillVersions.deletedAt,
      artifactId: skillArtifacts.id,
      artifactSha256: skillArtifacts.sha256,
      succeededScanCount: sql<number>`(
        select count(*)::int
        from ${scanRuns}
        where ${scanRuns.skillVersionId} = ${skillVersions.id}
          and ${scanRuns.status} = 'succeeded'
      )`,
    })
    .from(skillVersions)
    .innerJoin(skills, eq(skillVersions.skillId, skills.id))
    .leftJoin(skillArtifacts, eq(skillArtifacts.skillVersionId, skillVersions.id))
    .where(and(eq(skills.slug, input.slug), eq(skillVersions.version, input.version)))
    .for("update", { of: skillVersions })
    .limit(1);
  return row ?? null;
}

type SkillReleaseRow = Awaited<ReturnType<typeof selectSkillReleaseRows>>[number];

function releaseSummary(row: SkillReleaseRow, actor: SubmissionActor | null = null): SkillReleaseSummary {
  const allowedActions = releaseAllowedActions(row);
  return {
    id: row.id,
    slug: row.slug,
    version: row.version,
    lifecycleStatus: row.lifecycleStatus,
    reviewStatus: row.reviewStatus,
    securityStatus: row.securityStatus,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    platforms: row.platforms,
    findingCount: row.findingCount,
    allowedActions: row.lifecycleStatus === "revoked" && !isPrivilegedReleaseActor(actor)
      ? allowedActions.filter((action) => action !== "restore")
      : allowedActions,
  };
}

function isPrivilegedReleaseActor(actor: SubmissionActor | null): boolean {
  return Boolean(actor?.roles.some((role) => role === "owner" || role === "admin" || role === "maintainer"));
}

function isSafeRevokedRestore(row: {
  reviewStatus: ReviewSubmissionSummary["reviewStatus"];
  securityStatus: ReviewSubmissionSummary["securityStatus"];
  approvedArtifactSha256: string | null;
  publishedAt: Date | null;
  deletedAt: Date | null;
  artifactId: string | null;
  artifactSha256: string | null;
  succeededScanCount: number;
}): boolean {
  return row.reviewStatus === "approved" &&
    row.securityStatus === "passed" &&
    Boolean(row.publishedAt) &&
    !row.deletedAt &&
    Boolean(row.artifactId) &&
    row.succeededScanCount > 0 &&
    Boolean(row.approvedArtifactSha256) &&
    row.approvedArtifactSha256 === row.artifactSha256;
}

function reviewAllowedActions(row: {
  skillLifecycleStatus?: SkillLifecycleStatus;
  lifecycleStatus: SkillLifecycleStatus;
  reviewStatus: ReviewSubmissionSummary["reviewStatus"];
  securityStatus: ReviewSubmissionSummary["securityStatus"];
  approvedArtifactSha256?: string | null;
  publishedAt?: Date | null;
  deletedAt?: Date | null;
}): ReviewSubmissionSummary["allowedActions"] {
  if (!isActiveReviewRow(row)) {
    return [];
  }
  if (row.reviewStatus === "approved" && !row.publishedAt && row.securityStatus === "passed") {
    return row.approvedArtifactSha256 ? ["publish"] : [];
  }
  if (["unreviewed", "changes-requested"].includes(row.reviewStatus)) {
    return row.securityStatus === "passed"
      ? ["approve", "request-changes", "reject"]
      : ["request-changes", "reject"];
  }
  return [];
}

function isReviewQueueRow(row: {
  skillLifecycleStatus?: SkillLifecycleStatus;
  lifecycleStatus: SkillLifecycleStatus;
  reviewStatus: ReviewSubmissionSummary["reviewStatus"];
  publishedAt?: Date | null;
  deletedAt?: Date | null;
}): boolean {
  if (!isActiveReviewRow(row)) {
    return false;
  }
  return ["unreviewed", "changes-requested"].includes(row.reviewStatus) ||
    (row.reviewStatus === "approved" && !row.publishedAt);
}

function isActiveReviewRow(row: {
  skillLifecycleStatus?: SkillLifecycleStatus;
  lifecycleStatus: SkillLifecycleStatus;
  deletedAt?: Date | null;
}): boolean {
  return !row.deletedAt &&
    row.lifecycleStatus !== "archived" &&
    row.skillLifecycleStatus !== "archived";
}

function submissionAllowedActions(row: { reviewStatus: UserSubmissionSummary["reviewStatus"]; publishedAt?: Date | null }): UserSubmissionSummary["allowedActions"] {
  const actions: UserSubmissionSummary["allowedActions"] = ["export"];
  if (!row.publishedAt && ["unreviewed", "changes-requested"].includes(row.reviewStatus)) {
    actions.push("withdraw");
  }
  return actions;
}

function releaseAllowedActions(row: { lifecycleStatus: SkillLifecycleStatus; reviewStatus: ReviewSubmissionSummary["reviewStatus"]; securityStatus: ReviewSubmissionSummary["securityStatus"]; publishedAt?: Date | null }): ReleaseLifecycleAction[] {
  if (row.reviewStatus !== "approved" || row.securityStatus !== "passed") {
    return [];
  }
  if (!row.publishedAt) {
    return ["delete"];
  }
  if (row.lifecycleStatus === "approved") {
    return ["deprecate", "unpublish", "revoke"];
  }
  if (row.lifecycleStatus === "deprecated") {
    return ["restore", "unpublish", "revoke"];
  }
  if (row.lifecycleStatus === "unpublished" || row.lifecycleStatus === "revoked") {
    return ["restore", "delete"];
  }
  return [];
}

function lifecycleForReleaseAction(action: ReleaseLifecycleAction): SkillLifecycleStatus {
  if (action === "deprecate") {
    return "deprecated";
  }
  if (action === "unpublish") {
    return "unpublished";
  }
  if (action === "revoke") {
    return "revoked";
  }
  if (action === "restore") {
    return "approved";
  }
  return "archived";
}

function reviewResultFromVersion(row: { slug: string; visibility: ReviewVersionRow["visibility"] } | null, version: typeof skillVersions.$inferSelect): ReviewActionResult {
  if (!row) {
    throw new Error("Review row is required.");
  }
  return {
    id: version.id,
    slug: row.slug,
    version: version.version,
    visibility: row.visibility,
    lifecycleStatus: version.lifecycleStatus,
    reviewStatus: version.reviewStatus,
    securityStatus: version.securityStatus,
    approvedArtifactSha256: version.approvedArtifactSha256,
    publishedAt: version.publishedAt?.toISOString() ?? null,
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function reviewAuditReason(error: AppError): string {
  const reasons: Record<string, string> = {
    SUBMISSION_NOT_FOUND: "missing_submission",
    SUBMISSION_NOT_WITHDRAWABLE: "not_withdrawable",
    SUBMISSION_NOT_REVIEWABLE: "not_reviewable",
    ARTIFACT_HASH_MISMATCH: "artifact_hash_mismatch",
    APPROVED_ARTIFACT_HASH_MISMATCH: "approved_artifact_hash_mismatch",
    PACKAGE_MANIFEST_MISMATCH: "manifest_mismatch",
    PACKAGE_SCAN_NOT_PASSED: "scan_not_passed",
    PACKAGE_SCAN_REQUIRED: "missing_succeeded_scan",
    PACKAGE_ARTIFACT_REQUIRED: "missing_artifact_metadata",
    APPROVED_ARTIFACT_HASH_REQUIRED: "missing_approved_artifact_hash",
    SUBMISSION_NOT_APPROVED: "not_approved",
    SUBMISSION_ALREADY_PUBLISHED: "already_published",
    RELEASE_NOT_FOUND: "missing_release",
    RELEASE_ACTION_NOT_ALLOWED: "action_not_allowed",
    RELEASE_RESTORE_ROLE_REQUIRED: "privileged_restore_required",
    RELEASE_RESTORE_UNSAFE: "unsafe_release_state",
    SKILL_MANAGEMENT_ROLE_REQUIRED: "skill_management_role_required",
  };
  return reasons[error.code] ?? error.code.toLowerCase();
}

async function selectVersionForReview(db: DbLike, submissionId: string) {
  const [row] = await db
    .select({
      id: skillVersions.id,
      skillId: skills.id,
      slug: skills.slug,
      title: skills.title,
      version: skillVersions.version,
      visibility: skills.visibility,
      skillLifecycleStatus: skills.lifecycleStatus,
      lifecycleStatus: skillVersions.lifecycleStatus,
      reviewStatus: skillVersions.reviewStatus,
      securityStatus: skillVersions.securityStatus,
      approvedArtifactSha256: skillVersions.approvedArtifactSha256,
      publishedAt: skillVersions.publishedAt,
      deletedAt: skillVersions.deletedAt,
      createdAt: skillVersions.createdAt,
      artifactId: skillArtifacts.id,
      storageKey: skillArtifacts.storageKey,
      sha256: skillArtifacts.sha256,
      byteSize: skillArtifacts.byteSize,
      contentType: skillArtifacts.contentType,
      artifactPayload: skillArtifacts.payload,
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
      succeededScanCount: sql<number>`count(distinct case when ${scanRuns.status} = 'succeeded' then ${scanRuns.id} end)::int`,
    })
    .from(skillVersions)
    .innerJoin(skills, eq(skillVersions.skillId, skills.id))
    .leftJoin(skillArtifacts, eq(skillArtifacts.skillVersionId, skillVersions.id))
    .leftJoin(skillPlatformVariants, eq(skillPlatformVariants.skillVersionId, skillVersions.id))
    .leftJoin(scanRuns, eq(scanRuns.skillVersionId, skillVersions.id))
    .leftJoin(scanFindings, eq(scanFindings.scanRunId, scanRuns.id))
    .where(eq(skillVersions.id, submissionId))
    .groupBy(
      skillVersions.id,
      skills.id,
      skills.slug,
      skills.title,
      skillVersions.version,
      skills.visibility,
      skills.lifecycleStatus,
      skillVersions.lifecycleStatus,
      skillVersions.reviewStatus,
      skillVersions.securityStatus,
      skillVersions.approvedArtifactSha256,
      skillVersions.publishedAt,
      skillVersions.deletedAt,
      skillVersions.createdAt,
      skillArtifacts.id,
      skillArtifacts.storageKey,
      skillArtifacts.sha256,
      skillArtifacts.byteSize,
      skillArtifacts.contentType,
      skillArtifacts.payload,
    )
    .limit(1);
  return row ?? null;
}

async function selectVersionForReviewState(db: DbLike, submissionId: string): Promise<ReviewStateRow | null> {
  const [row] = await db
    .select({
      slug: skills.slug,
      version: skillVersions.version,
      visibility: skills.visibility,
      skillLifecycleStatus: skills.lifecycleStatus,
      lifecycleStatus: skillVersions.lifecycleStatus,
      reviewStatus: skillVersions.reviewStatus,
      deletedAt: skillVersions.deletedAt,
    })
    .from(skillVersions)
    .innerJoin(skills, eq(skillVersions.skillId, skills.id))
    .where(eq(skillVersions.id, submissionId))
    .for("update", { of: [skillVersions, skills] })
    .limit(1);
  return row ?? null;
}

async function selectVersionForReviewRevalidation(
  db: DbLike,
  submissionId: string,
  preparedArtifactPayloadJson: string,
): Promise<PublishableReviewRow | null> {
  const [row] = await db
    .select({
      skillId: skills.id,
      slug: skills.slug,
      version: skillVersions.version,
      visibility: skills.visibility,
      skillLifecycleStatus: skills.lifecycleStatus,
      lifecycleStatus: skillVersions.lifecycleStatus,
      reviewStatus: skillVersions.reviewStatus,
      securityStatus: skillVersions.securityStatus,
      approvedArtifactSha256: skillVersions.approvedArtifactSha256,
      publishedAt: skillVersions.publishedAt,
      deletedAt: skillVersions.deletedAt,
      succeededScanCount: sql<number>`(
        select count(*)::int
        from ${scanRuns}
        where ${scanRuns.skillVersionId} = ${skillVersions.id}
          and ${scanRuns.status} = 'succeeded'
      )`,
    })
    .from(skillVersions)
    .innerJoin(skills, eq(skillVersions.skillId, skills.id))
    .where(eq(skillVersions.id, submissionId))
    .for("update", { of: [skillVersions, skills] })
    .limit(1);

  if (!row) {
    return null;
  }

  const [artifact] = await db
    .select({
      artifactId: skillArtifacts.id,
      storageKey: skillArtifacts.storageKey,
      sha256: skillArtifacts.sha256,
      byteSize: skillArtifacts.byteSize,
      contentType: skillArtifacts.contentType,
      artifactPayloadMatches: sql<boolean>`${skillArtifacts.payload} = ${preparedArtifactPayloadJson}::jsonb`,
    })
    .from(skillArtifacts)
    .where(eq(skillArtifacts.skillVersionId, submissionId))
    .for("update")
    .limit(1);

  return {
    ...row,
    artifactId: artifact?.artifactId ?? null,
    storageKey: artifact?.storageKey ?? null,
    sha256: artifact?.sha256 ?? null,
    byteSize: artifact?.byteSize ?? null,
    contentType: artifact?.contentType ?? null,
    artifactPayloadMatches: artifact?.artifactPayloadMatches ?? false,
  };
}

function visibleReleasePredicate(): SQL | undefined {
  return and(
    inArray(skills.lifecycleStatus, ["approved", "deprecated"]),
    inArray(skillVersions.lifecycleStatus, ["approved", "deprecated"]),
    eq(skillVersions.reviewStatus, "approved"),
    eq(skillVersions.securityStatus, "passed"),
    isNotNull(skillVersions.publishedAt),
    isNull(skillVersions.deletedAt),
  );
}

function visibleToActorPredicate(actorId: string | null | undefined, sharing: SharingSettings): SQL | undefined {
  const predicates: Array<SQL | undefined> = [
    sharing.publicVisibilityEnabled ? eq(skills.visibility, "public") : undefined,
  ];
  if (actorId) {
    predicates.push(eq(skills.ownerUserId, actorId));
    if (sharing.authenticatedVisibilityEnabled) {
      predicates.push(eq(skills.visibility, "authenticated"));
    }
    if (sharing.teamsEnabled && sharing.teamVisibilityEnabled) {
      predicates.push(and(
        eq(skills.visibility, "team"),
        effectiveTeamAccessPredicate(actorId),
      ));
    }
    if (sharing.userVisibilityEnabled) {
      predicates.push(and(
        eq(skills.visibility, "explicit-users"),
        sql`exists (
          select 1
          from ${skillUserGrants}
          where ${skillUserGrants.skillId} = ${skills.id}
            and ${skillUserGrants.userId} = ${actorId}
        )`,
      ));
    }
    if (sharing.organizationVisibilityEnabled) {
      predicates.push(and(
        eq(skills.visibility, "organization"),
        organizationVisibilityPredicateForActor(actorId),
      ));
    }
  }
  const active = predicates.filter((predicate): predicate is SQL => Boolean(predicate));
  return active.length > 0 ? or(...active) : sql`false`;
}

/**
 * Team-derived release access must resolve the parent organization at read
 * time. Standalone teams retain the legacy membership behavior, while an
 * organization-owned team requires an active organization and its current
 * policy row. The policy decides whether the same actor must also have an
 * active organization membership.
 */
function effectiveTeamAccessPredicate(actorId: string): SQL<boolean> {
  return sql<boolean>`exists (
    select 1
    from ${skillTeamGrants} as stg
    inner join ${teamMemberships} as tm on tm.team_id = stg.team_id
    inner join ${teams} as team on team.id = stg.team_id
    left join ${organizations} as org on org.id = team.organization_id
    left join ${organizationPolicyRevisions} as opr
      on opr.organization_id = team.organization_id
      and opr.id = org.current_policy_revision_id
    left join ${organizationMemberships} as om
      on om.organization_id = team.organization_id
      and om.user_id = ${actorId}
      and om.removed_at is null
    where stg.skill_id = ${skills.id}
      and tm.user_id = ${actorId}
      and (
        team.organization_id is null
        or (
          org.status = 'active'
          and org.current_policy_revision_id is not null
          and opr.id is not null
          and (
            coalesce(opr.policy->'teams'->>'requireOrganizationMembershipForTeamMembers', 'true') = 'false'
            or om.id is not null
          )
        )
      )
  )`;
}

function organizationVisibilityPredicateForActor(actorId: string): SQL<boolean> {
  return sql<boolean>`exists (
    select 1
    from ${skillOrganizationGrants} as sog
    inner join ${organizations} as org on org.id = sog.organization_id
    inner join ${organizationPolicyRevisions} as opr
      on opr.organization_id = org.id
      and opr.id = org.current_policy_revision_id
    inner join ${organizationMemberships} as om
      on om.organization_id = org.id
      and om.user_id = ${actorId}
      and om.removed_at is null
    where sog.skill_id = ${skills.id}
      and sog.created_under_policy_revision_id = org.current_policy_revision_id
      and org.status = 'active'
      and opr.policy->'sharing'->>'organizationSkillSharingEnabled' = 'true'
  )`;
}

async function selectVisibleRelease(
  db: DbLike,
  input: { slug: string; version: string; actorId?: string | null },
  sharing: SharingSettings,
) {
  const [row] = await db
    .select({
      slug: skills.slug,
      title: skills.title,
      summary: skills.summary,
      version: skillVersions.version,
      lifecycleStatus: skillVersions.lifecycleStatus,
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
      storageKey: skillArtifacts.storageKey,
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
      visibleToActorPredicate(input.actorId ?? null, sharing),
    ))
    .groupBy(
      skills.slug,
      skills.title,
      skills.summary,
      skillVersions.version,
      skillVersions.lifecycleStatus,
      skillVersions.reviewStatus,
      skillVersions.securityStatus,
      skillVersions.publishedAt,
      skillArtifacts.sha256,
      skillArtifacts.byteSize,
      skillArtifacts.contentType,
      skillArtifacts.storageKey,
      skillArtifacts.payload,
    )
    .limit(1);
  return row ?? null;
}

type PublicReleaseRow = NonNullable<Awaited<ReturnType<typeof selectVisibleRelease>>>;

function publicRelease(row: PublicReleaseRow): PublicReleaseMetadata {
  if (!row.publishedAt) {
    throw new Error("Visible release query returned an unpublished version.");
  }
  return {
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    version: row.version,
    lifecycleStatus: row.lifecycleStatus === "deprecated" ? "deprecated" : "approved",
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

function manifestFromPayload(input: unknown) {
  const payload = parseArtifactPayload(input);
  try {
    return loadSkillManifestFromPackageFiles(payload.files);
  } catch (error) {
    if (error instanceof PackageManifestFileError) {
      throw new AppError(error.message, error.code, 422);
    }
    throw new AppError(error instanceof Error ? error.message : "Invalid artifact payload.", "INVALID_PACKAGE_PAYLOAD", 422);
  }
}

async function getSharingSettings(db: DbLike): Promise<SharingSettings> {
  const [setting] = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, "sharing"))
    .limit(1);
  return parseSharingSettings(setting?.value);
}

function parseSharingSettings(input: unknown): SharingSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return DEFAULT_SHARING_SETTINGS;
  }
  const record = input as Partial<SharingSettings>;
  return {
    publicVisibilityEnabled: typeof record.publicVisibilityEnabled === "boolean" ? record.publicVisibilityEnabled : true,
    authenticatedVisibilityEnabled: typeof record.authenticatedVisibilityEnabled === "boolean" ? record.authenticatedVisibilityEnabled : true,
    teamsEnabled: typeof record.teamsEnabled === "boolean" ? record.teamsEnabled : true,
    teamVisibilityEnabled: typeof record.teamVisibilityEnabled === "boolean" ? record.teamVisibilityEnabled : true,
    userVisibilityEnabled: typeof record.userVisibilityEnabled === "boolean" ? record.userVisibilityEnabled : true,
    organizationVisibilityEnabled: typeof record.organizationVisibilityEnabled === "boolean"
      ? record.organizationVisibilityEnabled
      : false,
  };
}

function isUuid(input: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input);
}
