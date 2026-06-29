import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "@myskills-app/auth";
import { createDb, createPgPool, type Database } from "./client.js";
import {
  auditEvents,
  instanceSettings,
  passwordCredentials,
  roleAssignments,
  roles,
  skillArtifacts,
  skillPlatformVariants,
  skills,
  skillTags,
  skillVersions,
  users,
} from "./schema.js";

const DEMO_SKILL_SLUG = "release-notes-helper";
const DEMO_SKILL_VERSION = "0.1.0";
const DEMO_SKILL_TITLE = "Release Notes Helper";
const DEMO_SKILL_SUMMARY = "Turns merged changes into concise release notes with decisions, risks, and upgrade notes.";
const DEMO_RELEASE_NOTES = "Initial synthetic seed package.";
const DEMO_PLATFORM = { name: "codex", installTarget: "codex-skill", status: "supported" };

export interface SeedDatabaseOptions {
  ownerEmail?: string;
  ownerPassword?: string;
}

if (isMainModule(import.meta.url)) {
  await main();
}

export async function seedDatabase(db: Database, options: SeedDatabaseOptions = {}) {
  const seedOwnerEmail = (options.ownerEmail ?? process.env.SEED_OWNER_EMAIL ?? "owner@example.com").trim().toLowerCase();
  const seedOwnerPassword = options.ownerPassword ?? getSeedOwnerPassword();

  for (const role of ["owner", "admin", "maintainer", "author", "user"] as const) {
    await db.insert(roles).values({ name: role, description: `${role} role` }).onConflictDoNothing();
  }

  const [owner] = await db
    .insert(users)
    .values({
      email: seedOwnerEmail,
      normalizedEmail: seedOwnerEmail,
      name: "Instance Owner",
      status: "active",
      emailVerifiedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: users.normalizedEmail,
      set: { status: "active", emailVerifiedAt: new Date() },
    })
    .returning();

  if (!owner) {
    throw new Error("Owner seed failed.");
  }

  await db.insert(roleAssignments).values({ userId: owner.id, role: "owner" }).onConflictDoNothing();
  await db.insert(passwordCredentials).values({
    userId: owner.id,
    passwordHash: await hashPassword(seedOwnerPassword),
  }).onConflictDoNothing();
  await db.insert(instanceSettings).values({
    key: "registration",
    value: { mode: "closed" },
  }).onConflictDoNothing();

  const [skill] = await db
    .insert(skills)
    .values({
      slug: DEMO_SKILL_SLUG,
      title: DEMO_SKILL_TITLE,
      summary: DEMO_SKILL_SUMMARY,
      lifecycleStatus: "approved",
      visibility: "public",
      ownerUserId: owner.id,
    })
    .onConflictDoUpdate({
      target: skills.slug,
      set: {
        title: DEMO_SKILL_TITLE,
        summary: DEMO_SKILL_SUMMARY,
        lifecycleStatus: "approved",
        visibility: "public",
        ownerUserId: owner.id,
      },
    })
    .returning();

  if (!skill) {
    throw new Error("Skill seed failed.");
  }

  const [version] = await db
    .insert(skillVersions)
    .values({
      skillId: skill.id,
      version: DEMO_SKILL_VERSION,
      releaseNotes: DEMO_RELEASE_NOTES,
      lifecycleStatus: "approved",
      reviewStatus: "approved",
      securityStatus: "passed",
      publishedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();

  const seededVersion = version ?? (await db
    .select()
    .from(skillVersions)
    .where(and(
      eq(skillVersions.skillId, skill.id),
      eq(skillVersions.version, DEMO_SKILL_VERSION),
    ))
    .limit(1))[0];
  if (!seededVersion) {
    throw new Error("Skill version seed failed.");
  }

  const [visibleVersion] = await db
    .update(skillVersions)
    .set({
      releaseNotes: DEMO_RELEASE_NOTES,
      lifecycleStatus: "approved",
      reviewStatus: "approved",
      securityStatus: "passed",
      publishedAt: seededVersion.publishedAt ?? new Date(),
    })
    .where(eq(skillVersions.id, seededVersion.id))
    .returning();
  if (!visibleVersion) {
    throw new Error("Skill version seed repair failed.");
  }

  await db.insert(skillPlatformVariants).values({
    skillVersionId: visibleVersion.id,
    ...DEMO_PLATFORM,
  }).onConflictDoNothing();
  await db
    .update(skillPlatformVariants)
    .set({
      installTarget: DEMO_PLATFORM.installTarget,
      status: DEMO_PLATFORM.status,
    })
    .where(and(
      eq(skillPlatformVariants.skillVersionId, visibleVersion.id),
      eq(skillPlatformVariants.name, DEMO_PLATFORM.name),
    ));

  for (const tag of ["writing", "release"]) {
    await db.insert(skillTags).values({ skillId: skill.id, tag }).onConflictDoNothing();
  }

  const syntheticArtifactPayload = {
    files: [
      {
        path: "README.md",
        content: DEMO_SKILL_SUMMARY,
      },
      {
        path: "skill.json",
        content: JSON.stringify({
          name: DEMO_SKILL_SLUG,
          title: DEMO_SKILL_TITLE,
          summary: DEMO_SKILL_SUMMARY,
          version: DEMO_SKILL_VERSION,
          license: "Apache-2.0",
          visibility: "public",
          platforms: [{ name: DEMO_PLATFORM.name, install_target: DEMO_PLATFORM.installTarget, status: DEMO_PLATFORM.status }],
          tags: ["writing", "release"],
        }),
      },
    ],
  };
  const syntheticArtifact = JSON.stringify(syntheticArtifactPayload);
  await db.delete(skillArtifacts).where(eq(skillArtifacts.skillVersionId, visibleVersion.id));
  await db.insert(skillArtifacts).values({
    skillVersionId: visibleVersion.id,
    storageKey: `seed/${randomUUID()}.json`,
    sha256: createHash("sha256").update(syntheticArtifact).digest("hex"),
    byteSize: Buffer.byteLength(syntheticArtifact),
    contentType: "application/vnd.myskills-app.package+json",
    payload: syntheticArtifactPayload,
  });

  await db.insert(auditEvents).values({
    actorUserId: owner.id,
    action: "seed.skill",
    decision: "allow",
    resourceType: "skill",
    resourceId: skill.id,
    details: { slug: skill.slug },
  });
}

async function main() {
  const pool = createPgPool();
  try {
    await seedDatabase(createDb(pool));
    console.log("Seed data written.");
  } finally {
    await pool.end();
  }
}

function getSeedOwnerPassword(): string {
  const password = process.env.SEED_OWNER_PASSWORD;
  if (password) {
    return password;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("SEED_OWNER_PASSWORD is required in production.");
  }
  return "change-me-now-please";
}

function isMainModule(metaUrl: string): boolean {
  return process.argv[1] ? fileURLToPath(metaUrl) === resolve(process.argv[1]) : false;
}
