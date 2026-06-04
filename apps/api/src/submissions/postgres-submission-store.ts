import { and, eq } from "drizzle-orm";
import { AppError } from "@ai-skills-share/core";
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
import type { CreateSubmissionInput, StoredSubmission, SubmissionStore } from "./types.js";

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
          visibility: "private",
          ownerUserId: input.actor.id,
        })
        .returning())[0];

      if (!skill) {
        throw new Error("Skill submission insert failed.");
      }

      if (existingSkill) {
        await tx.update(skills).set({
          title: input.manifest.title,
          summary: input.manifest.summary,
          lifecycleStatus: "submitted",
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
        version: version.version,
        reviewStatus: version.reviewStatus,
        securityStatus: version.securityStatus,
        artifact: input.artifact,
        scan: {
          status: "succeeded",
          findings: input.findings,
        },
      };
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
        reason: input.reason,
        findingCount: input.findingCount,
      },
    });
  }
}
