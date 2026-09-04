import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  AppError, defaultSkillUpgradePolicyV1, isPrereleaseVersion, isWithinSkillUpgradeMaintenanceWindow,
  parseSemanticVersion, skillReleaseUpdateBlockers, skillReleaseUpgradeRange, skillReleaseChangeKinds, type TargetSkillOperation, type SkillUpgradePolicyV1,
} from "@myskills-app/core";
import type { Database } from "../db/client.js";
import {
  skillArchitectureTargets, skillArchitectureObservations, targetSkillOperations, skillUpgradePolicyRevisions,
  instanceSettings, skills, skillVersions, users,
} from "../db/schema.js";
import { PostgresArchitectureTargetStore, lockTargetMutationAuthority } from "../targets/postgres-target-store.js";
import { PostgresSkillRepository } from "../repositories/postgres-skill-repository.js";
import { PostgresSubmissionStore } from "../submissions/postgres-submission-store.js";
import { reauthorizeInternalRegistrySnapshot } from "../architectures/postgres-pattern-migration-authorization.js";
import type { ArchitectureTargetRecord } from "../targets/types.js";

export type OperationDatabase = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export function operationDenied(code = "TARGET_OPERATION_AUTHORIZATION_CHANGED"): AppError {
  return new AppError("The target operation is no longer authorized. Refresh its target and release state.", code, 409);
}

/** Target -> owner/organization -> actor authority. Matches target lifecycle lock order. */
export async function lockOperationTarget(db: OperationDatabase, actorId: string, targetId: string, mutation = true): Promise<ArchitectureTargetRecord> {
  const [row] = await db.select().from(skillArchitectureTargets).where(eq(skillArchitectureTargets.id, targetId)).for("update").limit(1);
  if (!row) throw operationDenied();
  const owner = row.ownerUserId ? { type: "user" as const, id: row.ownerUserId }
    : row.ownerTeamId ? { type: "team" as const, id: row.ownerTeamId }
      : { type: "organization" as const, id: row.ownerOrganizationId! };
  if (!await lockTargetMutationAuthority(db, owner, actorId)) throw operationDenied();
  const [actor] = await db.select({ status: users.status, verifiedAt: users.emailVerifiedAt }).from(users).where(eq(users.id, actorId)).for("update").limit(1);
  if (!actor || actor.status !== "active" || !actor.verifiedAt) throw operationDenied();
  const store = new PostgresArchitectureTargetStore(db as Database);
  const target = await store.getTarget(actorId, targetId);
  if (!target || !(await store.getTargetAccess(actorId, targetId, mutation ? "register" : "read"))?.allowed) throw operationDenied();
  return target;
}

/** Metadata history remains visible only while both actor and target scope can see the skill. */
export async function canReadOperationRelease(db: OperationDatabase, actorId: string, operation: Pick<TargetSkillOperation, "targetId" | "skillSlug" | "toVersion">): Promise<boolean> {
  const target = await new PostgresArchitectureTargetStore(db as Database).getTarget(actorId, operation.targetId);
  if (!target) return false;
  const registry = new PostgresSkillRepository(db as Database);
  const [actorSkill, targetSkill] = await Promise.all([
    registry.getVisibleSkillBySlug(operation.skillSlug, actorId),
    target.owner.type === "team" ? registry.getSkillVisibleToTeamBySlug(operation.skillSlug, target.owner.id)
      : target.owner.type === "organization" ? registry.getSkillVisibleToOrganizationBySlug(operation.skillSlug, target.owner.id)
        : registry.getVisibleSkillBySlug(operation.skillSlug, target.owner.id),
  ]);
  return Boolean(actorSkill && targetSkill);
}


/** Do not wait on reverse-order sharing writers while holding target authority. */
export async function lockOperationSharing(db: OperationDatabase): Promise<void> {
  await db.execute(sql`LOCK TABLE instance_settings IN SHARE MODE NOWAIT`);
  await db.select({ key: instanceSettings.key }).from(instanceSettings).where(eq(instanceSettings.key, "sharing")).for("update", { noWait: true }).limit(1);
}

export async function resolveLockedUpgradePolicy(db: OperationDatabase, target: ArchitectureTargetRecord): Promise<SkillUpgradePolicyV1> {
  const organizationId = target.owner.type === "organization" ? target.owner.id : undefined;
  // Policy append takes the same target/organization lock before this advisory lock.
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`target:${target.id}`}, 0))`);
  if (organizationId) await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`organization:${organizationId}`}, 0))`);
  const latest = async (scopeType: "target" | "organization", scopeId: string) => (await db.select().from(skillUpgradePolicyRevisions)
    .where(and(eq(skillUpgradePolicyRevisions.scopeType, scopeType), eq(skillUpgradePolicyRevisions.scopeId, scopeId)))
    .orderBy(desc(skillUpgradePolicyRevisions.revisionNumber)).limit(1))[0];
  return (await latest("target", target.id))?.policy
    ?? (organizationId ? (await latest("organization", organizationId))?.policy : undefined)
    ?? defaultSkillUpgradePolicyV1;
}

export async function assertOperationEligibility(db: OperationDatabase, actorId: string, operation: TargetSkillOperation, target: ArchitectureTargetRecord,
  options: { execution?: boolean; source?: boolean; now: string }): Promise<void> {
  if (target.status === "revoked" || target.consent.status !== "granted" || target.generation !== operation.targetGeneration
    || target.adapter.contractVersion !== 2 || target.capabilities["sync.write"] !== true
    || target.capabilities[operation.action === "rollback" ? "rollback" : "apply"] !== true) throw operationDenied();
  const [skill] = await db.select({ id: skills.id, visibility: skills.visibility }).from(skills).where(eq(skills.slug, operation.skillSlug)).limit(1);
  if (!skill || (target.owner.type === "organization" && !["public", "authenticated", "organization"].includes(skill.visibility))) throw operationDenied();
  await reauthorizeInternalRegistrySnapshot(db, {
    actorId, architectureId: target.architectureId,
    owner: target.owner.type === "team" ? { type: "team", id: target.owner.id } : { type: "user", id: actorId },
    organizationIds: target.owner.type === "organization" ? [target.owner.id] : [],
    spec: { skills: [{ id: "operation-release", slug: operation.skillSlug, version: operation.toVersion, digest: operation.artifact.sha256, packageVisibility: skill.visibility }] },
  });
  const release = await new PostgresSubmissionStore(db as Database).getPublicRelease({ slug: operation.skillSlug, version: operation.toVersion, actorId });
  if (!release || release.artifact.sha256 !== operation.artifact.sha256 || release.artifact.byteSize !== operation.artifact.byteSize
    || release.artifact.contentType !== operation.artifact.contentType) throw operationDenied();
  const policy = await resolveLockedUpgradePolicy(db, target);
  if ((policy.pins[operation.skillSlug] && policy.pins[operation.skillSlug] !== operation.toVersion)
    || (!policy.includePrerelease && isPrereleaseVersion(operation.toVersion))
    || !policy.allowedChangeKinds.includes(release.changeKind)) throw operationDenied("TARGET_OPERATION_POLICY_CHANGED");
  if (operation.action === "update" && operation.fromVersion
    && !skillReleaseChangeKinds.every((kind) => policy.allowedChangeKinds.includes(kind))) {
    // The exact-release authorizer holds the parent skill FOR UPDATE, which
    // prevents new version inserts. Lock every existing version so publication
    // or change metadata cannot alter the crossed range before this commit.
    const versions = await db.select({ version: skillVersions.version, changeKind: skillVersions.changeKind, publishedAt: skillVersions.publishedAt,
    }).from(skillVersions).where(eq(skillVersions.skillId, skill.id)).orderBy(asc(skillVersions.id)).for("update");
    // Withdrawn or newly unsafe releases still contributed changes to later versions.
    const released = versions.filter((item) => item.publishedAt);
    if (skillReleaseUpgradeRange(released, operation.fromVersion, operation.toVersion).some((item) => !policy.allowedChangeKinds.includes(item.changeKind))) {
      throw operationDenied("TARGET_OPERATION_POLICY_CHANGED");
    }
  }
  if (options.execution && policy.mode === "maintenance-window" && !isWithinSkillUpgradeMaintenanceWindow(policy, new Date(options.now))) {
    throw operationDenied("TARGET_OPERATION_OUTSIDE_MAINTENANCE_WINDOW");
  }
  const blockers = skillReleaseUpdateBlockers(release, {
    installed: { version: operation.fromVersion ?? "0.0.0", platform: operation.platform }, releases: [release], policy: { includePrerelease: true },
    client: { adapterContractVersion: target.adapter.contractVersion,
      ...(typeof target.metadata?.myskillsVersion === "string" ? { myskillsVersion: target.metadata.myskillsVersion } : {}) },
  }).filter((code) => operation.action !== "rollback" || code !== "release-deprecated");
  if (blockers.length) throw operationDenied("TARGET_OPERATION_RELEASE_INCOMPATIBLE");
  if (options.source) await assertCurrentSource(db, operation, target);
}

async function assertCurrentSource(db: OperationDatabase, operation: TargetSkillOperation, target: ArchitectureTargetRecord): Promise<void> {
  // Target lock also serializes observation appends. Select current-generation evidence only.
  const [observation] = await db.select().from(skillArchitectureObservations).where(and(
    eq(skillArchitectureObservations.targetId, target.id), eq(skillArchitectureObservations.generation, target.generation),
  )).orderBy(desc(skillArchitectureObservations.capturedAt), desc(skillArchitectureObservations.id)).limit(1);
  const evidence = observation?.observedState as { skills?: Array<{ slug: string; version?: string; digest?: string; managed?: boolean }> } | undefined;
  const observed = evidence?.skills?.find((item) => item.slug === operation.skillSlug && item.managed !== false);
  const [receipt] = await db.select().from(targetSkillOperations).where(and(
    eq(targetSkillOperations.targetId, target.id), eq(targetSkillOperations.targetGeneration, target.generation),
    eq(targetSkillOperations.skillSlug, operation.skillSlug), eq(targetSkillOperations.state, "succeeded"),
    sql`${targetSkillOperations.result}->>'installedVersion' = ${targetSkillOperations.toVersion} AND ${targetSkillOperations.result}->>'artifactSha256' = ${targetSkillOperations.artifactSha256} AND ${targetSkillOperations.result}->>'contentDigest' ~ '^[0-9a-f]{64}$'`,
  )).orderBy(desc(targetSkillOperations.updatedAt), desc(targetSkillOperations.id)).limit(1);
  const newerReceipt = receipt && (!observation || receipt.updatedAt > observation.capturedAt);
  const version = newerReceipt ? receipt.result?.installedVersion : observed?.version;
  const digest = newerReceipt ? receipt.result?.artifactSha256 : observed?.digest;
  if (operation.state !== "queued" && version === operation.toVersion && digest === operation.artifact.sha256) return;
  if ((operation.action === "install" && version) || (operation.action !== "install" && (!version || !parseSemanticVersion(version) || version !== operation.fromVersion))) {
    throw operationDenied("TARGET_OPERATION_SOURCE_CHANGED");
  }
}
