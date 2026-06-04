import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, createPgPool } from "./client.js";
import {
  auditEvents,
  instanceSettings,
  roleAssignments,
  roles,
  skillArtifacts,
  skillPlatformVariants,
  skills,
  skillTags,
  skillVersions,
  users,
} from "./schema.js";

const pool = createPgPool();
const db = createDb(pool);

try {
  await seed();
  console.log("Seed data written.");
} finally {
  await pool.end();
}

async function seed() {
  for (const role of ["owner", "admin", "maintainer", "author", "user"] as const) {
    await db.insert(roles).values({ name: role, description: `${role} role` }).onConflictDoNothing();
  }

  const [owner] = await db
    .insert(users)
    .values({
      email: "owner@example.com",
      name: "Instance Owner",
      status: "active",
      emailVerifiedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: users.email,
      set: { status: "active", emailVerifiedAt: new Date() },
    })
    .returning();

  if (!owner) {
    throw new Error("Owner seed failed.");
  }

  await db.insert(roleAssignments).values({ userId: owner.id, role: "owner" }).onConflictDoNothing();
  await db.insert(instanceSettings).values({
    key: "registration",
    value: { mode: "closed" },
  }).onConflictDoNothing();

  const [skill] = await db
    .insert(skills)
    .values({
      slug: "release-notes-helper",
      title: "Release Notes Helper",
      summary: "Turns merged changes into concise release notes with decisions, risks, and upgrade notes.",
      lifecycleStatus: "approved",
      visibility: "public",
      ownerUserId: owner.id,
    })
    .onConflictDoUpdate({
      target: skills.slug,
      set: {
        title: "Release Notes Helper",
        summary: "Turns merged changes into concise release notes with decisions, risks, and upgrade notes.",
        lifecycleStatus: "approved",
        visibility: "public",
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
      version: "0.1.0",
      releaseNotes: "Initial synthetic seed package.",
      reviewStatus: "approved",
      securityStatus: "passed",
      publishedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();

  const existingVersion = version ?? (await db.select().from(skillVersions).where(eq(skillVersions.skillId, skill.id)).limit(1))[0];
  if (!existingVersion) {
    throw new Error("Skill version seed failed.");
  }

  await db.insert(skillPlatformVariants).values({
    skillVersionId: existingVersion.id,
    name: "codex",
    installTarget: "codex-skill",
    status: "supported",
  }).onConflictDoNothing();

  for (const tag of ["writing", "release"]) {
    await db.insert(skillTags).values({ skillId: skill.id, tag }).onConflictDoNothing();
  }

  const syntheticArtifact = "release-notes-helper 0.1.0 synthetic seed";
  await db.insert(skillArtifacts).values({
    skillVersionId: existingVersion.id,
    storageKey: "seed/release-notes-helper/0.1.0/package.zip",
    sha256: createHash("sha256").update(syntheticArtifact).digest("hex"),
    byteSize: Buffer.byteLength(syntheticArtifact),
    contentType: "application/zip",
  }).onConflictDoNothing();

  await db.insert(auditEvents).values({
    actorUserId: owner.id,
    action: "seed.skill",
    decision: "allow",
    resourceType: "skill",
    resourceId: skill.id,
    details: { slug: skill.slug },
  });
}

