import test from "node:test";
import assert from "node:assert/strict";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { TeamService } from "../src/teams/service.js";
import { MemoryTeamStore } from "../src/teams/memory-team-store.js";

test("signed-in users can create teams, invite members, and accept invitations", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const teamStore = new MemoryTeamStore();
  const skillRepository = new MemorySkillRepository([]);
  const app = buildApp({
    skillRepository,
    authService: new AuthService(authStore),
    teamService: new TeamService(teamStore),
  });
  t.after(() => app.close());

  const ownerToken = await addUserAndLogin(app, authStore, {
    id: "owner-user",
    email: "owner@example.com",
    roles: ["author"],
  });
  const memberToken = await addUserAndLogin(app, authStore, {
    id: "member-user",
    email: "member@example.com",
    roles: ["user"],
  });
  teamStore.addKnownUser({ id: "owner-user", email: "owner@example.com", name: "Owner" });
  teamStore.addKnownUser({ id: "member-user", email: "member@example.com", name: "Member" });

  const created = await app.inject({
    method: "POST",
    url: "/v1/teams",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { name: "Platform" },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().team.name, "Platform");
  assert.equal(created.json().team.role, "owner");

  const teamId = created.json().team.id as string;
  const invited = await app.inject({
    method: "POST",
    url: `/v1/teams/${teamId}/invitations`,
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { email: "Member@Example.com" },
  });
  assert.equal(invited.statusCode, 201);
  assert.equal(invited.json().invitation.email, "member@example.com");

  const memberDashboard = await app.inject({
    method: "GET",
    url: "/v1/teams",
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(memberDashboard.statusCode, 200);
  assert.deepEqual(memberDashboard.json().invitations.map((invitation: { teamName: string }) => invitation.teamName), ["Platform"]);

  const accepted = await app.inject({
    method: "POST",
    url: `/v1/teams/invitations/${invited.json().invitation.id}/accept`,
    headers: { authorization: `Bearer ${memberToken}` },
    payload: {},
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().invitation.status, "accepted");

  const nextDashboard = await app.inject({
    method: "GET",
    url: "/v1/teams",
    headers: { authorization: `Bearer ${memberToken}` },
  });
  assert.equal(nextDashboard.statusCode, 200);
  assert.deepEqual(nextDashboard.json().teams.map((team: { name: string }) => team.name), ["Platform"]);
  assert.deepEqual(nextDashboard.json().invitations, []);
});

test("skill owners can set signed-in visibility and instance owners can disable scopes", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const skillRepository = new MemorySkillRepository([
    {
      slug: "private-helper",
      title: "Private Helper",
      summary: "Owner managed helper.",
      lifecycleStatus: "approved",
      visibility: "private",
      latestVersion: "0.1.0",
      reviewStatus: "approved",
      securityStatus: "passed",
      platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }],
      tags: ["private"],
      ownerUserId: "owner-user",
    },
  ]);
  const app = buildApp({
    skillRepository,
    authService: new AuthService(authStore),
  });
  t.after(() => app.close());

  const ownerTokenWithoutMfa = await addUserAndLogin(app, authStore, {
    id: "owner-user",
    email: "owner@example.com",
    roles: ["owner"],
  });
  const verifiedOwnerToken = await addUserAndLoginWithMfa(app, authStore, {
    id: "verified-owner-user",
    email: "verified-owner@example.com",
    roles: ["owner"],
  });
  const readerToken = await addUserAndLogin(app, authStore, {
    id: "reader-user",
    email: "reader@example.com",
    roles: ["user"],
  });

  const anonymous = await app.inject({ method: "GET", url: "/v1/skills/private-helper" });
  assert.equal(anonymous.statusCode, 404);

  const ownerDetail = await app.inject({
    method: "GET",
    url: "/v1/skills/private-helper",
    headers: { authorization: `Bearer ${ownerTokenWithoutMfa}` },
  });
  assert.equal(ownerDetail.statusCode, 200);
  assert.equal(ownerDetail.json().skill.access.canManageSharing, true);

  const missingSkillSharingReadMfa = await app.inject({
    method: "GET",
    url: "/v1/skills/private-helper/sharing",
    headers: { authorization: `Bearer ${ownerTokenWithoutMfa}` },
  });
  assert.equal(missingSkillSharingReadMfa.statusCode, 403);
  assert.equal(missingSkillSharingReadMfa.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const sharing = await app.inject({
    method: "GET",
    url: "/v1/skills/private-helper/sharing",
    headers: { authorization: `Bearer ${verifiedOwnerToken}` },
  });
  assert.equal(sharing.statusCode, 200);
  assert.equal(sharing.json().sharing.visibility, "private");

  const missingSkillSharingMfa = await app.inject({
    method: "PUT",
    url: "/v1/skills/private-helper/sharing",
    headers: { authorization: `Bearer ${ownerTokenWithoutMfa}` },
    payload: {
      visibility: "authenticated",
      teamIds: [],
      userEmails: [],
    },
  });
  assert.equal(missingSkillSharingMfa.statusCode, 403);
  assert.equal(missingSkillSharingMfa.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const updated = await app.inject({
    method: "PUT",
    url: "/v1/skills/private-helper/sharing",
    headers: { authorization: `Bearer ${verifiedOwnerToken}` },
    payload: {
      visibility: "authenticated",
      teamIds: [],
      userEmails: [],
    },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().sharing.visibility, "authenticated");

  const readerDetail = await app.inject({
    method: "GET",
    url: "/v1/skills/private-helper",
    headers: { authorization: `Bearer ${readerToken}` },
  });
  assert.equal(readerDetail.statusCode, 200);

  const missingAdminSharingMfa = await app.inject({
    method: "PUT",
    url: "/v1/admin/sharing",
    headers: { authorization: `Bearer ${ownerTokenWithoutMfa}` },
    payload: {
      publicVisibilityEnabled: true,
      authenticatedVisibilityEnabled: false,
      teamsEnabled: true,
      teamVisibilityEnabled: true,
      userVisibilityEnabled: true,
    },
  });
  assert.equal(missingAdminSharingMfa.statusCode, 403);
  assert.equal(missingAdminSharingMfa.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const disabled = await app.inject({
    method: "PUT",
    url: "/v1/admin/sharing",
    headers: { authorization: `Bearer ${verifiedOwnerToken}` },
    payload: {
      publicVisibilityEnabled: true,
      authenticatedVisibilityEnabled: false,
      teamsEnabled: true,
      teamVisibilityEnabled: true,
      userVisibilityEnabled: true,
    },
  });
  assert.equal(disabled.statusCode, 200);

  const deniedReaderDetail = await app.inject({
    method: "GET",
    url: "/v1/skills/private-helper",
    headers: { authorization: `Bearer ${readerToken}` },
  });
  assert.equal(deniedReaderDetail.statusCode, 404);
});

async function addUserAndLogin(
  app: ReturnType<typeof buildApp>,
  authStore: MemoryAuthStore,
  input: {
    id: string;
    email: string;
    roles: Array<"owner" | "admin" | "maintainer" | "author" | "user">;
  },
): Promise<string> {
  authStore.addUser({
    id: input.id,
    email: input.email,
    name: input.email.split("@")[0],
    status: "active",
    emailVerifiedAt: new Date(),
    roles: input.roles,
    passwordHash: await hashPassword("correct horse battery staple"),
  });
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: input.email,
      password: "correct horse battery staple",
    },
  });
  assert.equal(login.statusCode, 200);
  return login.json().token;
}

async function addUserAndLoginWithMfa(
  app: ReturnType<typeof buildApp>,
  authStore: MemoryAuthStore,
  input: {
    id: string;
    email: string;
    roles: Array<"owner" | "admin" | "maintainer" | "author" | "user">;
  },
): Promise<string> {
  const setupSession = await addUserAndLogin(app, authStore, input);
  const enrollment = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/enroll",
    headers: { authorization: `Bearer ${setupSession}` },
    payload: {
      password: "correct horse battery staple",
    },
  });
  assert.equal(enrollment.statusCode, 201);

  const confirm = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/confirm",
    headers: { authorization: `Bearer ${setupSession}` },
    payload: {
      factorId: enrollment.json().enrollment.factorId,
      code: generateTotpCode(enrollment.json().enrollment.secret),
    },
  });
  assert.equal(confirm.statusCode, 200);

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: input.email,
      password: "correct horse battery staple",
    },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().mfaRequired, true);

  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    payload: {
      challengeToken: login.json().challengeToken,
      recoveryCode: confirm.json().mfa.recoveryCodes[0],
    },
  });
  assert.equal(verify.statusCode, 200);
  assert.equal(verify.json().user.mfaVerified, true);
  return verify.json().token;
}
