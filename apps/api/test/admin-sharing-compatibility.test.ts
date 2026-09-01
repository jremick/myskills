import test from "node:test";
import assert from "node:assert/strict";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";

test("legacy five-field admin sharing updates preserve organization visibility", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const skillRepository = new MemorySkillRepository([]);
  await skillRepository.updateSharingSettings(
    { id: "owner-1", roles: ["owner"] },
    {
      publicVisibilityEnabled: true,
      authenticatedVisibilityEnabled: true,
      teamsEnabled: true,
      teamVisibilityEnabled: true,
      userVisibilityEnabled: true,
      organizationVisibilityEnabled: true,
    },
  );
  const app = buildApp({
    skillRepository,
    authService: new AuthService(authStore),
  });
  t.after(() => app.close());

  const ownerSession = await addOwnerAndLoginWithMfa(app, authStore);
  const legacyUpdate = await app.inject({
    method: "PUT",
    url: "/v1/admin/sharing",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: {
      publicVisibilityEnabled: false,
      authenticatedVisibilityEnabled: true,
      teamsEnabled: true,
      teamVisibilityEnabled: true,
      userVisibilityEnabled: false,
    },
  });

  assert.equal(legacyUpdate.statusCode, 200, legacyUpdate.body);
  assert.equal(legacyUpdate.json().sharing.organizationVisibilityEnabled, true);

  const current = await app.inject({
    method: "GET",
    url: "/v1/admin/sharing",
    headers: { authorization: `Bearer ${ownerSession}` },
  });
  assert.equal(current.statusCode, 200);
  assert.equal(current.json().sharing.organizationVisibilityEnabled, true);

  const explicitDisable = await app.inject({
    method: "PUT",
    url: "/v1/admin/sharing",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: {
      publicVisibilityEnabled: false,
      authenticatedVisibilityEnabled: true,
      teamsEnabled: true,
      teamVisibilityEnabled: true,
      userVisibilityEnabled: false,
      organizationVisibilityEnabled: false,
    },
  });
  assert.equal(explicitDisable.statusCode, 200, explicitDisable.body);
  assert.equal(explicitDisable.json().sharing.organizationVisibilityEnabled, false);
});

async function addOwnerAndLoginWithMfa(
  app: ReturnType<typeof buildApp>,
  authStore: MemoryAuthStore,
): Promise<string> {
  authStore.addUser({
    id: "owner-1",
    email: "owner@example.com",
    name: "Owner",
    status: "active",
    emailVerifiedAt: new Date(),
    roles: ["owner"],
    passwordHash: await hashPassword("correct horse battery staple"),
  });

  const initialLogin = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: "owner@example.com", password: "correct horse battery staple" },
  });
  assert.equal(initialLogin.statusCode, 200);
  const setupToken = initialLogin.json().token as string;

  const enrollment = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/enroll",
    headers: { authorization: `Bearer ${setupToken}` },
    payload: { password: "correct horse battery staple" },
  });
  assert.equal(enrollment.statusCode, 201);

  const confirmation = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/confirm",
    headers: { authorization: `Bearer ${setupToken}` },
    payload: {
      factorId: enrollment.json().enrollment.factorId,
      code: generateTotpCode(enrollment.json().enrollment.secret),
    },
  });
  assert.equal(confirmation.statusCode, 200);

  const mfaLogin = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: "owner@example.com", password: "correct horse battery staple" },
  });
  assert.equal(mfaLogin.statusCode, 200);

  const verified = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    payload: {
      challengeToken: mfaLogin.json().challengeToken,
      recoveryCode: confirmation.json().mfa.recoveryCodes[0],
    },
  });
  assert.equal(verified.statusCode, 200);
  return verified.json().token as string;
}
