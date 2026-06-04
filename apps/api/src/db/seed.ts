import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { hashPassword } from "@ai-skills-share/auth";
import { createDb, createPgPool } from "./client.js";
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

const seedOwnerEmail = (process.env.SEED_OWNER_EMAIL ?? "owner@example.com").trim().toLowerCase();
const seedOwnerPassword = getSeedOwnerPassword();
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

  const syntheticArtifactPayload = {
    files: [
      {
        path: "README.md",
        content: "Turns merged changes into concise release notes with decisions, risks, and upgrade notes.",
      },
      {
        path: "skill.json",
        content: JSON.stringify({
          name: "release-notes-helper",
          title: "Release Notes Helper",
          summary: "Turns merged changes into concise release notes with decisions, risks, and upgrade notes.",
          version: "0.1.0",
          license: "Apache-2.0",
          visibility: "public",
          platforms: [{ name: "codex", install_target: "codex-skill", status: "supported" }],
          tags: ["writing", "release"],
        }),
      },
    ],
  };
  const syntheticArtifact = JSON.stringify(syntheticArtifactPayload);
  await db.delete(skillArtifacts).where(eq(skillArtifacts.skillVersionId, existingVersion.id));
  await db.insert(skillArtifacts).values({
    skillVersionId: existingVersion.id,
    storageKey: `seed/release-notes-helper/0.1.0/${createHash("sha256").update(syntheticArtifact).digest("hex")}.json`,
    sha256: createHash("sha256").update(syntheticArtifact).digest("hex"),
    byteSize: Buffer.byteLength(syntheticArtifact),
    contentType: "application/vnd.ai-skills-share.package+json",
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
