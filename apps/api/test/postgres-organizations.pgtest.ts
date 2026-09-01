import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultOrganizationPolicyV1, organizationPolicyDigest, type OrganizationPolicyV1 } from "@myskills-app/core";
import { PostgresOrganizationStore } from "../src/organizations/postgres-organization-store.js";
import { createDb, createPgPool } from "../src/db/client.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const ownerId = "11111111-1111-4111-8111-111111111111";
const secondOwnerId = "22222222-2222-4222-8222-222222222222";
const memberId = "33333333-3333-4333-8333-333333333333";
const otherUserId = "44444444-4444-4444-8444-444444444444";
const organizationId = "55555555-5555-4555-8555-555555555555";
const secondOrganizationId = "66666666-6666-4666-8666-666666666666";

test("PostgresOrganizationStore creates an active aggregate and preserves membership snapshots", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "Owner@Example.com", "Owner From Users");
  const store = new PostgresOrganizationStore(createDb(pool));

  const created = await store.createOrganization(createInput({
    id: organizationId,
    name: "Acme Architecture",
    slug: "acme-architecture",
    createdByUserId: ownerId,
    creatorEmail: "spoof@example.com",
    creatorName: "Spoofed Name",
  }));

  assert.equal(created.organization.id, organizationId);
  assert.equal(created.organization.status, "active");
  assert.equal(created.organization.currentPolicyRevisionId, created.policyRevision.id);
  assert.equal(created.policyRevision.revisionNumber, 1);
  assert.equal(created.membership.email, "Owner@Example.com");
  assert.equal(created.membership.name, "Owner From Users");
  assert.deepEqual(Object.keys(created.membership).sort(), [
    "createdAt",
    "email",
    "id",
    "invitedByUserId",
    "name",
    "organizationId",
    "removedAt",
    "role",
    "updatedAt",
    "userId",
  ]);

  const listed = await store.listOrganizations();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, organizationId);
  assert.equal((await store.findMembership({ organizationId, userId: ownerId }))?.role, "owner");

  const rowCounts = (await pool.query(
    `SELECT
       (SELECT count(*) FROM organizations WHERE id = $1) AS organizations,
       (SELECT count(*) FROM organization_memberships WHERE organization_id = $1) AS memberships,
       (SELECT count(*) FROM organization_policy_revisions WHERE organization_id = $1) AS policies`,
    [organizationId],
  )).rows[0] as { organizations: string; memberships: string; policies: string };
  assert.deepEqual(rowCounts, { organizations: "1", memberships: "1", policies: "1" });
});

test("organization invitations require normalized-email identity and resolve membership profile from users", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "owner@example.com", "Owner");
  await insertUser(pool, memberId, "member@example.com", "Authoritative Member");
  await insertUser(pool, otherUserId, "other@example.com", "Other User");
  const store = new PostgresOrganizationStore(createDb(pool));
  await store.createOrganization(createInput({ id: organizationId, name: "Invite Organization", slug: "invite-organization" }));

  const invitation = await store.createInvitation({
    organizationId,
    email: "Member@Example.com",
    normalizedEmail: "MEMBER@EXAMPLE.COM",
    role: "member",
    invitedByUserId: ownerId,
  });
  assert.equal(invitation.normalizedEmail, "member@example.com");
  assert.equal((await store.listInvitationsForEmail(" MEMBER@EXAMPLE.COM ")).length, 1);

  // A different user's email cannot consume the invitation, even when the
  // caller knows the invitation identifier.
  assert.equal(await store.acceptInvitation({
    invitationId: invitation.id,
    userId: otherUserId,
    email: "other@example.com",
    name: "Attempted Spoof",
  }), null);
  assert.equal((await store.findMembership({ organizationId, userId: otherUserId })), null);

  const accepted = await store.acceptInvitation({
    invitationId: invitation.id,
    userId: memberId,
    email: "MEMBER@example.com",
    name: "Untrusted Request Name",
  });
  assert.equal(accepted?.status, "accepted");
  const membership = await store.findMembership({ organizationId, userId: memberId });
  assert.equal(membership?.email, "member@example.com");
  assert.equal(membership?.name, "Authoritative Member");
  assert.equal((await store.listInvitationsForEmail("member@example.com")).length, 0);

  // Removed memberships stay queryable only when explicitly requested.
  const removed = await store.removeMembership({ organizationId, userId: memberId, actorUserId: ownerId });
  assert.equal(removed?.removedAt !== null, true);
  assert.equal(await store.findMembership({ organizationId, userId: memberId }), null);
  assert.equal((await store.findMembership({ organizationId, userId: memberId, includeRemoved: true }))?.removedAt !== null, true);
  assert.equal((await store.listMemberships({ organizationId })).some((row) => row.userId === memberId), false);
  assert.equal((await store.listMemberships({ organizationId, includeRemoved: true })).some((row) => row.userId === memberId), true);
});

test("organization member limits are enforced atomically and keep active-member acceptance idempotent", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "limited-owner@example.com", "Limited Owner");
  await insertUser(pool, memberId, "limited-member@example.com", "Limited Member");
  const store = new PostgresOrganizationStore(createDb(pool));
  const policy: OrganizationPolicyV1 = {
    ...defaultOrganizationPolicyV1,
    limits: {
      ...defaultOrganizationPolicyV1.limits,
      membersPerOrganization: 1,
    },
  };
  await store.createOrganization({
    ...createInput({
      id: organizationId,
      name: "Limited Organization",
      slug: "limited-organization",
      creatorEmail: "limited-owner@example.com",
      creatorName: "Limited Owner",
    }),
    policy,
    policySha256: organizationPolicyDigest(policy),
  });

  const invitation = await store.createInvitation({
    organizationId,
    email: "limited-member@example.com",
    normalizedEmail: "limited-member@example.com",
    role: "member",
    invitedByUserId: ownerId,
  });
  await assert.rejects(
    store.acceptInvitation({
      invitationId: invitation.id,
      userId: memberId,
      email: "limited-member@example.com",
      name: "Limited Member",
    }),
    (error: unknown) => hasError(error, "ORGANIZATION_MEMBER_LIMIT_REACHED", 409),
  );
  assert.equal(await store.findMembership({ organizationId, userId: memberId }), null);
  assert.equal((await store.listInvitations({ organizationId })).find((row) => row.id === invitation.id)?.status, "pending");

  // Re-activate the member under a larger policy, remove them, then verify a
  // later cap rotation blocks reactivation without changing the old row.
  const expandedPolicy: OrganizationPolicyV1 = {
    ...defaultOrganizationPolicyV1,
    limits: { ...defaultOrganizationPolicyV1.limits, membersPerOrganization: 2 },
  };
  await store.appendPolicyRevision({
    organizationId,
    policy: expandedPolicy,
    policySha256: organizationPolicyDigest(expandedPolicy),
    reason: "Expand member limit for reactivation fixture",
    createdByUserId: ownerId,
  });
  await store.acceptInvitation({
    invitationId: invitation.id,
    userId: memberId,
    email: "limited-member@example.com",
    name: "Limited Member",
  });
  await store.removeMembership({ organizationId, userId: memberId, actorUserId: ownerId });
  const restrictedPolicy: OrganizationPolicyV1 = {
    ...defaultOrganizationPolicyV1,
    limits: { ...defaultOrganizationPolicyV1.limits, membersPerOrganization: 1 },
  };
  await store.appendPolicyRevision({
    organizationId,
    policy: restrictedPolicy,
    policySha256: organizationPolicyDigest(restrictedPolicy),
    reason: "Restore member limit",
    createdByUserId: ownerId,
  });
  const reactivationInvitation = await store.createInvitation({
    organizationId,
    email: "limited-member@example.com",
    normalizedEmail: "limited-member@example.com",
    role: "member",
    invitedByUserId: ownerId,
  });
  await assert.rejects(
    store.acceptInvitation({
      invitationId: reactivationInvitation.id,
      userId: memberId,
      email: "limited-member@example.com",
      name: "Limited Member",
    }),
    (error: unknown) => hasError(error, "ORGANIZATION_MEMBER_LIMIT_REACHED", 409),
  );
  assert.equal((await store.findMembership({ organizationId, userId: memberId, includeRemoved: true }))?.removedAt !== null, true);
  assert.equal((await store.listInvitations({ organizationId })).find((row) => row.id === reactivationInvitation.id)?.status, "pending");

  // Store-level acceptance must remain idempotent for an active member even
  // when the active-member cap is already full.
  const duplicateInvitation = (await pool.query(
    `INSERT INTO organization_invitations (organization_id, email, normalized_email, role, status, invited_by_user_id)
     VALUES ($1, $2, $3, 'member', 'pending', $4)
     RETURNING id`,
    [organizationId, "limited-owner@example.com", "limited-owner@example.com", ownerId],
  )).rows[0] as { id: string };
  const accepted = await store.acceptInvitation({
    invitationId: duplicateInvitation.id,
    userId: ownerId,
    email: "limited-owner@example.com",
    name: "Ignored Request Name",
  });
  assert.equal(accepted?.status, "accepted");
  assert.equal((await store.listMemberships({ organizationId })).length, 1);
});

test("last-owner checks remain true under concurrent role changes and removals", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "first-owner@example.com", "First Owner");
  await insertUser(pool, secondOwnerId, "second-owner@example.com", "Second Owner");
  const store = new PostgresOrganizationStore(createDb(pool));
  await store.createOrganization(createInput({ id: organizationId, name: "Owner Organization", slug: "owner-organization" }));
  await pool.query(
    `INSERT INTO organization_memberships (organization_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [organizationId, secondOwnerId],
  );

  const removalResults = await Promise.allSettled([
    store.removeMembership({ organizationId, userId: ownerId, actorUserId: ownerId }),
    store.removeMembership({ organizationId, userId: secondOwnerId, actorUserId: secondOwnerId }),
  ]);
  assert.equal(removalResults.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(removalResults.filter((result) => (
    result.status === "rejected"
      && result.reason?.code === "LAST_ORGANIZATION_OWNER_REQUIRED"
  )).length, 1);

  const ownerRows = await pool.query(
    `SELECT user_id FROM organization_memberships
     WHERE organization_id = $1 AND role = 'owner' AND removed_at IS NULL`,
    [organizationId],
  );
  assert.equal(ownerRows.rowCount, 1);

  const remainingOwnerId = ownerRows.rows[0]?.user_id as string;
  await assert.rejects(
    store.updateMembershipRole({ organizationId, userId: remainingOwnerId, role: "member", actorUserId: remainingOwnerId }),
    (error: unknown) => hasError(error, "LAST_ORGANIZATION_OWNER_REQUIRED"),
  );
});

test("organization mutation stores recheck a demoted actor inside the transaction", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "boundary-owner@example.com", "Boundary Owner");
  await insertUser(pool, secondOwnerId, "boundary-admin@example.com", "Boundary Admin");
  await insertUser(pool, memberId, "boundary-member@example.com", "Boundary Member");
  const store = new PostgresOrganizationStore(createDb(pool));
  const created = await store.createOrganization(createInput({
    id: organizationId,
    name: "Boundary Organization",
    slug: "boundary-organization",
    creatorEmail: "boundary-owner@example.com",
    creatorName: "Boundary Owner",
  }));

  const adminInvitation = await store.createInvitation({
    organizationId,
    email: "boundary-admin@example.com",
    normalizedEmail: "boundary-admin@example.com",
    role: "admin",
    invitedByUserId: ownerId,
  });
  await store.acceptInvitation({
    invitationId: adminInvitation.id,
    userId: secondOwnerId,
    email: "boundary-admin@example.com",
    name: "Boundary Admin",
  });
  const memberInvitation = await store.createInvitation({
    organizationId,
    email: "boundary-member@example.com",
    normalizedEmail: "boundary-member@example.com",
    role: "member",
    invitedByUserId: ownerId,
  });
  await store.acceptInvitation({
    invitationId: memberInvitation.id,
    userId: memberId,
    email: "boundary-member@example.com",
    name: "Boundary Member",
  });

  // A request can read admin access before a concurrent request changes the
  // membership. The store must recheck the current row before each mutation.
  await store.updateMembershipRole({
    organizationId,
    userId: secondOwnerId,
    role: "member",
    actorUserId: ownerId,
  });
  await assert.rejects(
    store.updateMembershipRole({
      organizationId,
      userId: memberId,
      role: "admin",
      actorUserId: secondOwnerId,
    }),
    (error: unknown) => hasError(error, "ORGANIZATION_ADMIN_REQUIRED", 403),
  );
  await assert.rejects(
    store.removeMembership({ organizationId, userId: memberId, actorUserId: secondOwnerId }),
    (error: unknown) => hasError(error, "ORGANIZATION_ADMIN_REQUIRED", 403),
  );
  await assert.rejects(
    store.activatePolicyRevision({
      organizationId,
      revisionId: created.policyRevision.id,
      actorUserId: secondOwnerId,
    }),
    (error: unknown) => hasError(error, "ORGANIZATION_OWNER_REQUIRED", 403),
  );
  await assert.rejects(
    store.archiveOrganization({ organizationId, actorUserId: secondOwnerId }),
    (error: unknown) => hasError(error, "ORGANIZATION_OWNER_REQUIRED", 403),
  );
  assert.equal((await store.getOrganization(organizationId))?.status, "active");
  assert.equal((await store.findMembership({ organizationId, userId: memberId }))?.removedAt, null);
});

test("policy digests are idempotent while policy rows remain immutable", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "policy-owner@example.com", "Policy Owner");
  const store = new PostgresOrganizationStore(createDb(pool));
  const created = await store.createOrganization(createInput({ id: organizationId, name: "Policy Organization", slug: "policy-organization" }));
  const policy = policyWith({
    sharing: { organizationSkillSharingEnabled: false },
  });
  const appendInput = {
    organizationId,
    policy,
    policySha256: organizationPolicyDigest(policy),
    reason: "Disable skill sharing",
    createdByUserId: ownerId,
  };
  const first = await store.appendPolicyRevision(appendInput);
  const duplicate = await store.appendPolicyRevision(appendInput);
  assert.equal(first.created, true);
  assert.equal(first.activated, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.activated, true);
  assert.equal(duplicate.revision.id, first.revision.id);
  assert.equal((await store.getOrganization(organizationId))?.currentPolicyRevisionId, first.revision.id);
  assert.equal((await store.listPolicyRevisions(organizationId)).length, 2);

  await assert.rejects(
    pool.query("UPDATE organization_policy_revisions SET reason = 'mutated' WHERE id = $1", [first.revision.id]),
    (error: unknown) => hasError(error, "55000"),
  );
  await assert.rejects(
    pool.query("DELETE FROM organization_policy_revisions WHERE id = $1", [first.revision.id]),
    (error: unknown) => hasError(error, "55000"),
  );
  const persisted = (await pool.query(
    "SELECT reason, policy_sha256 FROM organization_policy_revisions WHERE id = $1",
    [first.revision.id],
  )).rows[0] as { reason: string; policy_sha256: string };
  assert.deepEqual(persisted, { reason: "Disable skill sharing", policy_sha256: appendInput.policySha256 });

  await assert.rejects(
    store.appendPolicyRevision({
      ...appendInput,
      policySha256: "0".repeat(64),
    }),
    (error: unknown) => hasError(error, "ORGANIZATION_POLICY_DIGEST_INVALID"),
  );
  assert.equal((await store.listPolicyRevisions(organizationId)).length, 2);
  assert.equal(created.policyRevision.id !== first.revision.id, true);
});

test("existing policy revisions activate atomically, preserve rows, and reject cross-org or inactive targets", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "activate-owner@example.com", "Activate Owner");
  await insertUser(pool, secondOwnerId, "activate-second-owner@example.com", "Second Owner");
  const store = new PostgresOrganizationStore(createDb(pool));
  const created = await store.createOrganization(createInput({
    id: organizationId,
    name: "Activation Organization",
    slug: "activation-organization",
    createdByUserId: ownerId,
    creatorEmail: "activate-owner@example.com",
    creatorName: "Activate Owner",
  }));
  const second = await store.createOrganization(createInput({
    id: secondOrganizationId,
    name: "Other Activation Organization",
    slug: "other-activation-organization",
    createdByUserId: secondOwnerId,
    creatorEmail: "activate-second-owner@example.com",
    creatorName: "Second Owner",
  }));
  const appended = await store.appendPolicyRevision({
    organizationId,
    policy: policyWith({ sharing: { organizationSkillSharingEnabled: false } }),
    policySha256: organizationPolicyDigest(policyWith({ sharing: { organizationSkillSharingEnabled: false } })),
    reason: "Disable skill sharing",
    createdByUserId: ownerId,
  });
  const originalRow = (await pool.query(
    "SELECT reason, policy_sha256, policy FROM organization_policy_revisions WHERE id = $1",
    [created.policyRevision.id],
  )).rows[0] as { reason: string; policy_sha256: string; policy: unknown };
  const beforeActivation = (await pool.query(
    "SELECT current_policy_revision_id, updated_at FROM organizations WHERE id = $1",
    [organizationId],
  )).rows[0] as { current_policy_revision_id: string; updated_at: string };

  const restored = await store.activatePolicyRevision({
    organizationId,
    revisionId: created.policyRevision.id,
    actorUserId: ownerId,
  });
  assert.equal(restored?.activated, true);
  assert.equal(restored?.changed, true);
  assert.equal(restored?.revision.id, created.policyRevision.id);
  assert.equal((await store.getOrganization(organizationId))?.currentPolicyRevisionId, created.policyRevision.id);
  const beforeIdempotent = (await pool.query(
    "SELECT current_policy_revision_id, updated_at FROM organizations WHERE id = $1",
    [organizationId],
  )).rows[0] as { current_policy_revision_id: string; updated_at: string };
  assert.ok(new Date(beforeIdempotent.updated_at).getTime() >= new Date(beforeActivation.updated_at).getTime());

  const idempotent = await store.activatePolicyRevision({
    organizationId,
    revisionId: created.policyRevision.id,
    actorUserId: ownerId,
  });
  assert.equal(idempotent?.activated, true);
  assert.equal(idempotent?.changed, false);
  const afterIdempotent = (await pool.query(
    "SELECT current_policy_revision_id, updated_at FROM organizations WHERE id = $1",
    [organizationId],
  )).rows[0] as { current_policy_revision_id: string; updated_at: string };
  assert.deepEqual(afterIdempotent, {
    current_policy_revision_id: created.policyRevision.id,
    updated_at: beforeIdempotent.updated_at,
  });

  const crossOrganization = await store.activatePolicyRevision({
    organizationId,
    revisionId: second.policyRevision.id,
    actorUserId: ownerId,
  });
  assert.equal(crossOrganization, null);
  const unchanged = (await pool.query(
    "SELECT current_policy_revision_id FROM organizations WHERE id = $1",
    [organizationId],
  )).rows[0] as { current_policy_revision_id: string };
  assert.equal(unchanged.current_policy_revision_id, created.policyRevision.id);

  const preservedRow = (await pool.query(
    "SELECT reason, policy_sha256, policy FROM organization_policy_revisions WHERE id = $1",
    [created.policyRevision.id],
  )).rows[0] as { reason: string; policy_sha256: string; policy: unknown };
  assert.deepEqual(preservedRow, originalRow);
  assert.equal(appended.revision.id !== created.policyRevision.id, true);

  await pool.query("UPDATE organizations SET status = 'suspended' WHERE id = $1", [organizationId]);
  await assert.rejects(
    store.activatePolicyRevision({ organizationId, revisionId: created.policyRevision.id, actorUserId: ownerId }),
    (error: unknown) => hasError(error, "ORGANIZATION_INACTIVE", 409),
  );
  await pool.query("UPDATE organizations SET status = 'archived' WHERE id = $1", [organizationId]);
  await assert.rejects(
    store.activatePolicyRevision({ organizationId, revisionId: created.policyRevision.id, actorUserId: ownerId }),
    (error: unknown) => hasError(error, "ORGANIZATION_INACTIVE", 409),
  );
});

test("archive keeps organization, policy, memberships, and audit rows queryable while bounding audit output", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "archive-owner@example.com", "Archive Owner");
  const store = new PostgresOrganizationStore(createDb(pool));
  const created = await store.createOrganization(createInput({ id: organizationId, name: "Archive Organization", slug: "archive-organization" }));

  await store.recordAuditEvent({
    actorUserId: ownerId,
    action: "organization.archive",
    decision: "allow",
    resourceId: organizationId,
    details: {
      token: "do-not-persist",
      longValue: "x".repeat(300),
    },
  });
  const archived = await store.archiveOrganization({ organizationId, actorUserId: ownerId });
  assert.equal(archived?.status, "archived");
  assert.equal((await store.getOrganization(organizationId))?.currentPolicyRevisionId, created.policyRevision.id);
  assert.equal((await store.listOrganizations()).some((row) => row.id === organizationId && row.status === "archived"), true);
  assert.equal((await store.findMembership({ organizationId, userId: ownerId }))?.role, "owner");
  assert.equal((await pool.query("SELECT count(*) FROM organization_policy_revisions WHERE organization_id = $1", [organizationId])).rows[0].count, "1");

  const audit = await store.listAuditEvents(10_000);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.details.token, "[redacted]");
  assert.equal((audit[0]?.details.longValue as string).length, 203);
});

test("organization persistence maps uniqueness conflicts to stable application errors", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "conflict-owner@example.com", "Conflict Owner");
  const store = new PostgresOrganizationStore(createDb(pool));
  await store.createOrganization(createInput({ id: organizationId, name: "Conflict Organization", slug: "conflict-organization" }));
  await assert.rejects(
    store.createOrganization(createInput({ id: secondOrganizationId, name: "Other Name", slug: "conflict-organization" })),
    (error: unknown) => hasError(error, "ORGANIZATION_ALREADY_EXISTS", 409),
  );
  const invite = await store.createInvitation({
    organizationId,
    email: "new-member@example.com",
    normalizedEmail: "new-member@example.com",
    role: "member",
    invitedByUserId: ownerId,
  });
  assert.equal(invite.status, "pending");
  await assert.rejects(
    store.createInvitation({
      organizationId,
      email: "NEW-MEMBER@example.com",
      normalizedEmail: "NEW-MEMBER@example.com",
      role: "member",
      invitedByUserId: ownerId,
    }),
    (error: unknown) => hasError(error, "ORGANIZATION_INVITATION_EXISTS", 409),
  );
});

function hasError(error: unknown, code: string, statusCode?: number): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; statusCode?: unknown };
  return candidate.code === code && (statusCode === undefined || candidate.statusCode === statusCode);
}

function createInput(overrides: Partial<{
  id: string;
  name: string;
  slug: string;
  createdByUserId: string;
  creatorEmail: string;
  creatorName: string;
}> = {}) {
  const policy = defaultOrganizationPolicyV1;
  return {
    id: overrides.id ?? organizationId,
    name: overrides.name ?? "Test Organization",
    slug: overrides.slug ?? "test-organization",
    createdByUserId: overrides.createdByUserId ?? ownerId,
    creatorEmail: overrides.creatorEmail ?? "owner@example.com",
    creatorName: overrides.creatorName ?? "Owner",
    policy,
    policySha256: organizationPolicyDigest(policy),
    reason: "Initial organization policy",
  };
}

function policyWith(input: {
  sharing?: Partial<OrganizationPolicyV1["sharing"]>;
}): OrganizationPolicyV1 {
  return {
    ...defaultOrganizationPolicyV1,
    sharing: {
      ...defaultOrganizationPolicyV1.sharing,
      ...input.sharing,
    },
  };
}

async function freshPool(t: TestContext) {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for organization store tests.");
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await applyMigrationsThrough(pool, "0017_organizations_and_org_sharing");
  return pool;
}

async function applyMigrationsThrough(pool: ReturnType<typeof createPgPool>, lastMigration: string): Promise<void> {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    await applyMigration(pool, id);
    if (id === lastMigration) return;
  }
  throw new Error(`Migration ${lastMigration} was not found.`);
}

async function applyMigration(pool: ReturnType<typeof createPgPool>, id: string): Promise<void> {
  const contents = readFileSync(join(migrationsDir, `${id}.sql`), "utf8");
  await pool.query("BEGIN");
  try {
    await pool.query(contents);
    await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

async function insertUser(
  pool: ReturnType<typeof createPgPool>,
  id: string,
  email: string,
  name: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, normalized_email, name, status, email_verified_at)
     VALUES ($1, $2, $3, $4, 'active', now())`,
    [id, email, email.trim().toLowerCase(), name],
  );
}

function assertSafeTestDatabaseUrl(value: string): void {
  const databaseName = new URL(value).pathname.replace(/^\//, "");
  assert.match(databaseName, /(^|[_-])(test|ci)([_-]|$)/i, "TEST_DATABASE_URL must target a disposable database whose name includes test or ci.");
}
