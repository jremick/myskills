import test from "node:test";
import assert from "node:assert/strict";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import type { SubmissionService } from "../src/submissions/service.js";

test("legacy skill visibility updates require a verified session and preserve the complete current grant set", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const skillRepository = new MemorySkillRepository([{
    slug: "private-helper",
    title: "Private helper",
    summary: "Private",
    lifecycleStatus: "approved",
    visibility: "private",
    latestVersion: "1.0.0",
    reviewStatus: "approved",
    securityStatus: "passed",
    platforms: [],
    tags: [],
    ownerUserId: "visibility-user",
  }]);
  await skillRepository.updateSharingSettings(
    { id: "visibility-user", roles: ["owner"] },
    {
      publicVisibilityEnabled: true,
      authenticatedVisibilityEnabled: true,
      teamsEnabled: true,
      teamVisibilityEnabled: true,
      userVisibilityEnabled: true,
      organizationVisibilityEnabled: true,
    },
  );
  skillRepository.addTeamMembership("visibility-user", {
    id: "team-one",
    name: "Team One",
    role: "owner",
  });
  skillRepository.addTeam({ id: "team-hidden" });
  skillRepository.addTeamGrant("private-helper", "team-hidden");
  skillRepository.addTeamMembership("hidden-team-member", {
    id: "team-hidden",
    name: "Hidden Team",
    role: "member",
  });
  skillRepository.addTeamGrant("private-helper", "team-one");
  skillRepository.addKnownUserGrant("private-helper", {
    id: "user-one",
    email: "grantee@example.com",
    name: "Grantee",
  });
  skillRepository.addOrganization({ id: "org-one", name: "Org One" });
  skillRepository.addOrganizationMembership("visibility-user", {
    id: "org-one",
    name: "Org One",
    role: "owner",
  });
  skillRepository.addOrganization({ id: "org-hidden", name: "Hidden Org" });
  skillRepository.addOrganizationMembership("hidden-org-member", {
    id: "org-hidden",
    name: "Hidden Org",
    role: "member",
  });
  skillRepository.addOrganizationGrant("private-helper", "org-hidden");
  skillRepository.addOrganizationGrant("private-helper", "org-one");

  const app = buildApp({
    skillRepository,
    authService: new AuthService(authStore),
    submissionService: {
      getSkillManagement: async () => ({
        slug: "private-helper",
        title: "Private helper",
        summary: "Private",
        lifecycleStatus: "approved",
        visibility: "private",
        tags: [],
        allowedActions: ["edit"],
      }),
    } as unknown as SubmissionService,
  });
  t.after(() => app.close());

  authStore.addUser({
    id: "visibility-user",
    email: "visibility@example.com",
    name: "Visibility User",
    status: "active",
    emailVerifiedAt: new Date(),
    roles: ["author"],
    passwordHash: await hashPassword("correct horse battery staple"),
  });
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: "visibility@example.com", password: "correct horse battery staple" },
  });
  assert.equal(login.statusCode, 200);
  const plainSession = login.json().token as string;

  const withoutMfa = await app.inject({
    method: "PUT",
    url: "/v1/skills/private-helper",
    headers: { authorization: `Bearer ${plainSession}` },
    payload: { visibility: "organization" },
  });
  assert.equal(withoutMfa.statusCode, 403);
  assert.equal(withoutMfa.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const apiToken = await app.inject({
    method: "POST",
    url: "/v1/auth/api-tokens",
    headers: { authorization: `Bearer ${plainSession}` },
    payload: { name: "beta2 compatibility", scopes: ["review:write"] },
  });
  assert.equal(apiToken.statusCode, 201);

  const apiTokenUpdate = await app.inject({
    method: "PUT",
    url: "/v1/skills/private-helper",
    headers: { authorization: `Bearer ${apiToken.json().token.token}` },
    payload: { visibility: "organization" },
  });
  assert.equal(apiTokenUpdate.statusCode, 403);
  assert.equal(apiTokenUpdate.json().error.code, "SESSION_AUTH_REQUIRED");

  const mfaSession = await verifyMfaForSession(app, plainSession);
  const response = await app.inject({
    method: "PUT",
    url: "/v1/skills/private-helper",
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: { visibility: "organization" },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().skill.visibility, "organization");
  assert.equal((await skillRepository.getVisibleSkillBySlug("private-helper", "hidden-org-member"))?.slug, "private-helper");

  const sharing = await skillRepository.getSkillSharing("private-helper", {
    id: "visibility-user",
    roles: ["author"],
  });
  assert.equal(sharing.visibility, "organization");
  assert.deepEqual(sharing.teamGrants.map((team) => team.id), ["team-one"]);
  assert.deepEqual(sharing.userGrants.map((user) => user.email), ["grantee@example.com"]);
  assert.deepEqual(sharing.organizationGrants?.map((organization) => organization.id), ["org-one"]);

  const canonicalResponse = await app.inject({
    method: "PUT",
    url: "/v1/skills/private-helper/sharing",
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: { visibility: "organization" },
  });
  assert.equal(canonicalResponse.statusCode, 200, canonicalResponse.body);
  assert.equal((await skillRepository.getVisibleSkillBySlug("private-helper", "hidden-org-member"))?.slug, "private-helper");

  const teamResponse = await app.inject({
    method: "PUT",
    url: "/v1/skills/private-helper",
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: { visibility: "team" },
  });
  assert.equal(teamResponse.statusCode, 200, teamResponse.body);
  assert.equal((await skillRepository.getVisibleSkillBySlug("private-helper", "hidden-team-member"))?.slug, "private-helper");

  await skillRepository.updateSkillSharing({
    actor: { id: "visibility-user", roles: ["author"] },
    slug: "private-helper",
    visibility: "private",
    teamIds: [],
    userEmails: [],
    organizationIds: [],
  });
  assert.equal(await skillRepository.getVisibleSkillBySlug("private-helper", "hidden-team-member"), null);
  assert.equal(await skillRepository.getVisibleSkillBySlug("private-helper", "hidden-org-member"), null);
});

async function verifyMfaForSession(
  app: ReturnType<typeof buildApp>,
  session: string,
): Promise<string> {
  const enrollment = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/enroll",
    headers: { authorization: `Bearer ${session}` },
    payload: { password: "correct horse battery staple" },
  });
  assert.equal(enrollment.statusCode, 201);

  const confirmation = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/confirm",
    headers: { authorization: `Bearer ${session}` },
    payload: {
      factorId: enrollment.json().enrollment.factorId,
      code: generateTotpCode(enrollment.json().enrollment.secret),
    },
  });
  assert.equal(confirmation.statusCode, 200);

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: "visibility@example.com", password: "correct horse battery staple" },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().mfaRequired, true);

  const verified = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    payload: {
      challengeToken: login.json().challengeToken,
      recoveryCode: confirmation.json().mfa.recoveryCodes[0],
    },
  });
  assert.equal(verified.statusCode, 200);
  assert.equal(verified.json().user.mfaVerified, true);
  return verified.json().token as string;
}
