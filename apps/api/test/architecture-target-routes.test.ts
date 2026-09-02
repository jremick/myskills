import assert from "node:assert/strict";
import test from "node:test";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import {
  createFlatArchitecture,
  defaultOrganizationPolicyV1,
  architectureTargetAdapterDigest,
  architectureTargetCapabilitiesDigest,
  type ArchitectureTargetObservationInput,
  type ArchitectureTargetOwnerReference,
} from "@myskills-app/core";
import { buildApp } from "../src/app.js";
import { MemoryArchitectureStore } from "../src/architectures/memory-store.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { AuthService } from "../src/auth/service.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { MemorySubmissionStore } from "../src/submissions/memory-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";
import { ArchitectureTargetBindingAuthorizer } from "../src/targets/architecture-binding-authorizer.js";
import { MemoryArchitectureTargetStore } from "../src/targets/memory-target-store.js";
import { ArchitectureTargetService } from "../src/targets/service.js";
import type { ArchitectureTargetRecord } from "../src/targets/types.js";
import { MemoryTargetSkillOperationStore } from "../src/target-operations/memory-store.js";
import { TargetSkillOperationService } from "../src/target-operations/service.js";
import { MemorySkillUpgradePolicyStore } from "../src/upgrade-policies/memory-store.js";
import { SkillUpgradePolicyService } from "../src/upgrade-policies/service.js";

const PASSWORD = "correct horse battery staple";
const adapter = { kind: "codex", version: "1.0.0", contractVersion: 1 as const };
const capabilities = {
  "inventory.read": true,
  "health.read": true,
  "plan.read": true,
  apply: false,
  rollback: false,
  "sync.write": false,
} as const;

const userOwnerId = "target-route-user-owner";
const teamId = "target-route-team";
const teamOwnerId = "target-route-team-owner";
const teamMemberId = "target-route-team-member";
const organizationId = "target-route-organization";
const organizationAdminId = "target-route-organization-admin";
const organizationMemberId = "target-route-organization-member";
const outsiderId = "target-route-outsider";

test("target routes expose the capability, use sessions, enforce owner MFA, and keep terminal lifecycle state", async (t) => {
  const fixture = await createFixture({ includeTenants: false });
  t.after(() => fixture.app.close());
  const userArchitecture = await seedArchitecture(fixture.architectureStore, {
    actorId: userOwnerId,
    owner: { type: "user", id: userOwnerId },
  });
  const plainSession = await addUserAndLogin(fixture, userOwnerId, "target-route-user-owner@example.com");
  const mfaSession = await verifyMfaForSession(fixture.app, plainSession, "target-route-user-owner@example.com");
  const outsiderSession = await addUserAndLogin(fixture, outsiderId, "target-route-outsider@example.com");

  const capabilityResponse = await fixture.app.inject({ method: "GET", url: "/v1/capabilities" });
  assert.equal(capabilityResponse.statusCode, 200);
  assert.equal(capabilityResponse.json().capabilities.architectureTargets, true);

  const unauthenticated = await fixture.app.inject({ method: "GET", url: "/v1/architecture-targets" });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().error.code, "AUTHENTICATION_REQUIRED");

  const registerInput = targetInput(userArchitecture, { type: "user", id: userOwnerId });
  const withoutMfa = await fixture.app.inject({
    method: "POST",
    url: "/v1/architecture-targets",
    headers: { authorization: `Bearer ${plainSession}` },
    payload: registerInput,
  });
  assert.equal(withoutMfa.statusCode, 403);
  assert.equal(withoutMfa.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const registered = await fixture.app.inject({
    method: "POST",
    url: "/v1/architecture-targets",
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: {
      ...registerInput,
      credentialReference: "keychain-target-route",
      metadata: { label: "Personal Codex" },
    },
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const target = registered.json().target as ArchitectureTargetRecord;
  assert.deepEqual(target.owner, { type: "user", id: userOwnerId });
  assert.equal(target.architectureId, userArchitecture.architectureId);
  assert.equal(target.environmentId, userArchitecture.environmentId);
  assert.equal(target.profileId, userArchitecture.profileId);
  assert.equal(target.consent.status, "pending");
  assert.equal("credentialReference" in target, false);

  const apiTokenResponse = await fixture.app.inject({
    method: "POST",
    url: "/v1/auth/api-tokens",
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: { name: "Target route token", scopes: ["architectures:read"] },
  });
  assert.equal(apiTokenResponse.statusCode, 201);
  const apiToken = apiTokenResponse.json().token.token as string;
  const apiTokenRequests = [
    { method: "GET", url: "/v1/architecture-targets" },
    { method: "GET", url: `/v1/architecture-targets/${target.id}` },
    { method: "POST", url: "/v1/architecture-targets", payload: registerInput },
    { method: "POST", url: `/v1/architecture-targets/${target.id}/consent`, payload: { decision: "grant" } },
    { method: "GET", url: `/v1/architecture-targets/${target.id}/observations` },
    { method: "POST", url: `/v1/architecture-targets/${target.id}/observations`, payload: observationInput(target) },
    { method: "POST", url: `/v1/architecture-targets/${target.id}/health`, payload: healthyHealth() },
    { method: "DELETE", url: `/v1/architecture-targets/${target.id}` },
  ] as const;
  for (const request of apiTokenRequests) {
    const response = await fixture.app.inject({
      ...request,
      headers: { authorization: `Bearer ${apiToken}` },
    });
    assert.equal(response.statusCode, 403, `${request.method} ${request.url}`);
    assert.equal(response.json().error.code, "SESSION_AUTH_REQUIRED", `${request.method} ${request.url}`);
  }

  const detail = await fixture.app.inject({
    method: "GET",
    url: `/v1/architecture-targets/${target.id}`,
    headers: { authorization: `Bearer ${plainSession}` },
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().target.id, target.id);
  assert.equal("credentialReference" in detail.json().target, false);

  const consentWithoutMfa = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${target.id}/consent`,
    headers: { authorization: `Bearer ${plainSession}` },
    payload: { decision: "grant" },
  });
  assert.equal(consentWithoutMfa.statusCode, 403);
  assert.equal(consentWithoutMfa.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const consent = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${target.id}/consent`,
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: { decision: "grant" },
  });
  assert.equal(consent.statusCode, 200);
  assert.equal(consent.json().target.consent.status, "granted");

  const health = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${target.id}/health`,
    headers: { authorization: `Bearer ${plainSession}` },
    payload: healthyHealth(),
  });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().target.status, "connected");

  const appended = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${target.id}/observations`,
    headers: { authorization: `Bearer ${plainSession}` },
    payload: observationInput(target),
  });
  assert.equal(appended.statusCode, 201, appended.body);
  assert.equal(appended.json().observation.targetId, target.id);
  assert.equal("credentialReference" in appended.json().observation, false);

  const observations = await fixture.app.inject({
    method: "GET",
    url: `/v1/architecture-targets/${target.id}/observations?limit=1`,
    headers: { authorization: `Bearer ${plainSession}` },
  });
  assert.equal(observations.statusCode, 200);
  assert.equal(observations.json().observations.length, 1);

  const revokeWithoutMfa = await fixture.app.inject({
    method: "DELETE",
    url: `/v1/architecture-targets/${target.id}`,
    headers: { authorization: `Bearer ${plainSession}` },
  });
  assert.equal(revokeWithoutMfa.statusCode, 403);
  assert.equal(revokeWithoutMfa.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const revoked = await fixture.app.inject({
    method: "DELETE",
    url: `/v1/architecture-targets/${target.id}`,
    headers: { authorization: `Bearer ${mfaSession}` },
  });
  assert.equal(revoked.statusCode, 200);
  assert.equal(revoked.json().target.status, "revoked");
  assert.equal(revoked.json().target.consent.status, "revoked");

  const terminalConsent = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${target.id}/consent`,
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: { decision: "deny" },
  });
  assert.equal(terminalConsent.statusCode, 410);
  assert.equal(terminalConsent.json().error.code, "ARCHITECTURE_TARGET_REVOKED");

  const terminalObservation = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${target.id}/observations`,
    headers: { authorization: `Bearer ${plainSession}` },
    payload: observationInput(target),
  });
  assert.equal(terminalObservation.statusCode, 410);
  assert.equal(terminalObservation.json().error.code, "ARCHITECTURE_TARGET_REVOKED");

  const outsider = await fixture.app.inject({
    method: "GET",
    url: `/v1/architecture-targets/${target.id}`,
    headers: { authorization: `Bearer ${outsiderSession}` },
  });
  assert.equal(outsider.statusCode, 404);
  assert.equal(outsider.json().error.code, "ARCHITECTURE_TARGET_NOT_FOUND");
  assert.equal(JSON.stringify(outsider.json()).includes(target.id), false);
});

test("target operation routes enforce MFA scheduling and API-token-only fenced execution", async (t) => {
  const fixture = await createFixture({ includeTenants: false });
  t.after(() => fixture.app.close());
  const architecture = await seedArchitecture(fixture.architectureStore, {
    actorId: userOwnerId,
    owner: { type: "user", id: userOwnerId },
  });
  const plainSession = await addUserAndLogin(fixture, userOwnerId, "target-route-operations@example.com");
  const mfaSession = await verifyMfaForSession(fixture.app, plainSession, "target-route-operations@example.com");
  await seedPublicRelease(fixture.submissionService, userOwnerId, "1.1.0");

  const registered = await fixture.app.inject({
    method: "POST",
    url: "/v1/architecture-targets",
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: {
      ...targetInput(architecture, { type: "user", id: userOwnerId }),
      adapter: { kind: "codex-companion", version: "1.0.0", contractVersion: 2 },
      capabilities: { ...capabilities, apply: true, rollback: true, "sync.write": true },
    },
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const target = registered.json().target as ArchitectureTargetRecord;
  const consent = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${target.id}/consent`,
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: { decision: "grant" },
  });
  assert.equal(consent.statusCode, 200, consent.body);
  const consentedTarget = consent.json().target as ArchitectureTargetRecord;
  const observation = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${target.id}/observations`,
    headers: { authorization: `Bearer ${plainSession}` },
    payload: observationInput(consentedTarget, {
      skills: [{ slug: "release-notes-helper", version: "1.0.0", digest: "b".repeat(64), managed: true }],
    }),
  });
  assert.equal(observation.statusCode, 201, observation.body);

  const schedulePayload = {
    action: "update",
    slug: "release-notes-helper",
    version: "1.1.0",
    platform: "codex",
    idempotencyKey: "route-operation-1",
  };
  const unauthenticated = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${target.id}/operations`,
    payload: schedulePayload,
  });
  assert.equal(unauthenticated.statusCode, 401);
  const withoutMfa = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${target.id}/operations`,
    headers: { authorization: `Bearer ${plainSession}` },
    payload: schedulePayload,
  });
  assert.equal(withoutMfa.statusCode, 403);
  assert.equal(withoutMfa.json().error.code, "MFA_VERIFICATION_REQUIRED");
  const scheduled = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${target.id}/operations`,
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: schedulePayload,
  });
  assert.equal(scheduled.statusCode, 202, scheduled.body);
  const operationId = scheduled.json().operation.id as string;
  assert.equal("idempotencyKey" in scheduled.json().operation, false);

  const policy = await fixture.app.inject({
    method: "PUT",
    url: `/v1/architecture-targets/${target.id}/update-policy`,
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: {
      expectedRevisionNumber: 0,
      reason: "Route integration coverage",
      policy: { schemaVersion: 1, mode: "manual", includePrerelease: false, allowedChangeKinds: ["feature", "fix", "security"], pins: {} },
    },
  });
  assert.equal(policy.statusCode, 201, policy.body);
  assert.equal(policy.json().revision.revisionNumber, 1);

  const tokenResponse = await fixture.app.inject({
    method: "POST",
    url: "/v1/auth/api-tokens",
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: { name: "Target executor", scopes: ["targets:execute"] },
  });
  assert.equal(tokenResponse.statusCode, 201, tokenResponse.body);
  const executorToken = tokenResponse.json().token.token as string;
  const sessionClaim = await fixture.app.inject({
    method: "POST",
    url: "/v1/target-operations/claim",
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: { targetId: target.id, targetGeneration: target.generation, holderId: "companion-1" },
  });
  assert.equal(sessionClaim.statusCode, 403);
  assert.equal(sessionClaim.json().error.code, "API_TOKEN_REQUIRED");
  const claimed = await fixture.app.inject({
    method: "POST",
    url: "/v1/target-operations/claim",
    headers: { authorization: `Bearer ${executorToken}` },
    payload: { targetId: target.id, targetGeneration: target.generation, holderId: "companion-1" },
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const claim = claimed.json().claim;
  assert.equal(claim.operation.id, operationId);
  assert.equal("claimToken" in claim.operation, false);

  for (const state of ["applying", "verifying"] as const) {
    const advanced = await fixture.app.inject({
      method: "POST",
      url: `/v1/target-operations/${operationId}/state`,
      headers: { authorization: `Bearer ${executorToken}` },
      payload: { holderId: "companion-1", claimToken: claim.claimToken, fencingToken: claim.operation.fencingToken, state },
    });
    assert.equal(advanced.statusCode, 200, advanced.body);
    assert.equal(advanced.json().operation.state, state);
  }
  const receipt = await fixture.app.inject({
    method: "POST",
    url: `/v1/target-operations/${operationId}/receipt`,
    headers: { authorization: `Bearer ${executorToken}` },
    payload: {
      holderId: "companion-1",
      claimToken: claim.claimToken,
      fencingToken: claim.operation.fencingToken,
      result: { status: "succeeded", code: "operation.succeeded", installedVersion: "1.1.0", artifactSha256: scheduled.json().operation.artifact.sha256, contentDigest: "c".repeat(64) },
    },
  });
  assert.equal(receipt.statusCode, 200, receipt.body);
  assert.equal(receipt.json().operation.result.installedVersion, "1.1.0");

  const listed = await fixture.app.inject({
    method: "GET",
    url: `/v1/architecture-targets/${target.id}/operations`,
    headers: { authorization: `Bearer ${plainSession}` },
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().operations[0].state, "succeeded");
});

test("target routes enforce team and organization role matrices and current membership removal", async (t) => {
  const fixture = await createFixture({ includeTenants: true });
  t.after(() => fixture.app.close());
  const teamArchitecture = await seedArchitecture(fixture.architectureStore, {
    actorId: teamOwnerId,
    owner: { type: "team", id: teamId },
  });
  const organizationArchitecture = await seedArchitecture(fixture.architectureStore, {
    actorId: organizationAdminId,
    owner: { type: "user", id: organizationAdminId },
  });
  fixture.architectureStore.addOrganizationGrant({
    architectureId: organizationArchitecture.architectureId,
    organizationId,
  });

  const teamOwnerSession = await addUserAndLogin(fixture, teamOwnerId, "target-route-team-owner@example.com");
  const teamOwnerMfaSession = await verifyMfaForSession(fixture.app, teamOwnerSession, "target-route-team-owner@example.com");
  const teamMemberSession = await addUserAndLogin(fixture, teamMemberId, "target-route-team-member@example.com");
  const teamMemberMfaSession = await verifyMfaForSession(fixture.app, teamMemberSession, "target-route-team-member@example.com");
  const organizationAdminSession = await addUserAndLogin(fixture, organizationAdminId, "target-route-organization-admin@example.com");
  const organizationAdminMfaSession = await verifyMfaForSession(fixture.app, organizationAdminSession, "target-route-organization-admin@example.com");
  const organizationMemberSession = await addUserAndLogin(fixture, organizationMemberId, "target-route-organization-member@example.com");
  const organizationMemberMfaSession = await verifyMfaForSession(fixture.app, organizationMemberSession, "target-route-organization-member@example.com");

  const teamTarget = await registerTarget(fixture, teamOwnerMfaSession, teamArchitecture, { type: "team", id: teamId });
  const organizationTarget = await registerTarget(
    fixture,
    organizationAdminMfaSession,
    organizationArchitecture,
    { type: "organization", id: organizationId },
  );

  const teamMemberList = await fixture.app.inject({
    method: "GET",
    url: "/v1/architecture-targets",
    headers: { authorization: `Bearer ${teamMemberSession}` },
  });
  assert.equal(teamMemberList.statusCode, 200);
  assert.deepEqual(teamMemberList.json().targets.map((item: { id: string }) => item.id), [teamTarget.id]);

  const teamMemberRead = await fixture.app.inject({
    method: "GET",
    url: `/v1/architecture-targets/${teamTarget.id}`,
    headers: { authorization: `Bearer ${teamMemberSession}` },
  });
  assert.equal(teamMemberRead.statusCode, 200);

  const teamMemberRegister = await fixture.app.inject({
    method: "POST",
    url: "/v1/architecture-targets",
    headers: { authorization: `Bearer ${teamMemberMfaSession}` },
    payload: targetInput(teamArchitecture, { type: "team", id: teamId }),
  });
  assert.equal(teamMemberRegister.statusCode, 403);
  assert.equal(teamMemberRegister.json().error.code, "ARCHITECTURE_TARGET_BINDING_FORBIDDEN");

  const teamMemberConsent = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${teamTarget.id}/consent`,
    headers: { authorization: `Bearer ${teamMemberMfaSession}` },
    payload: { decision: "grant" },
  });
  assert.equal(teamMemberConsent.statusCode, 403);
  assert.equal(teamMemberConsent.json().error.code, "ARCHITECTURE_TARGET_ACTION_FORBIDDEN");

  const teamMemberHealth = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${teamTarget.id}/health`,
    headers: { authorization: `Bearer ${teamMemberSession}` },
    payload: healthyHealth(),
  });
  assert.equal(teamMemberHealth.statusCode, 403);
  assert.equal(teamMemberHealth.json().error.code, "ARCHITECTURE_TARGET_ACTION_FORBIDDEN");

  const teamMemberRevoke = await fixture.app.inject({
    method: "DELETE",
    url: `/v1/architecture-targets/${teamTarget.id}`,
    headers: { authorization: `Bearer ${teamMemberMfaSession}` },
  });
  assert.equal(teamMemberRevoke.statusCode, 403);
  assert.equal(teamMemberRevoke.json().error.code, "ARCHITECTURE_TARGET_ACTION_FORBIDDEN");

  const organizationMemberList = await fixture.app.inject({
    method: "GET",
    url: "/v1/architecture-targets",
    headers: { authorization: `Bearer ${organizationMemberSession}` },
  });
  assert.equal(organizationMemberList.statusCode, 200);
  assert.deepEqual(organizationMemberList.json().targets.map((item: { id: string }) => item.id), [organizationTarget.id]);

  const organizationMemberRead = await fixture.app.inject({
    method: "GET",
    url: `/v1/architecture-targets/${organizationTarget.id}`,
    headers: { authorization: `Bearer ${organizationMemberSession}` },
  });
  assert.equal(organizationMemberRead.statusCode, 200);

  const organizationMemberRegister = await fixture.app.inject({
    method: "POST",
    url: "/v1/architecture-targets",
    headers: { authorization: `Bearer ${organizationMemberMfaSession}` },
    payload: targetInput(organizationArchitecture, { type: "organization", id: organizationId }),
  });
  assert.equal(organizationMemberRegister.statusCode, 403);
  assert.equal(organizationMemberRegister.json().error.code, "ARCHITECTURE_TARGET_BINDING_FORBIDDEN");

  const organizationMemberConsent = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${organizationTarget.id}/consent`,
    headers: { authorization: `Bearer ${organizationMemberMfaSession}` },
    payload: { decision: "grant" },
  });
  assert.equal(organizationMemberConsent.statusCode, 403);
  assert.equal(organizationMemberConsent.json().error.code, "ARCHITECTURE_TARGET_ACTION_FORBIDDEN");

  const organizationMemberHealth = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${organizationTarget.id}/health`,
    headers: { authorization: `Bearer ${organizationMemberSession}` },
    payload: healthyHealth(),
  });
  assert.equal(organizationMemberHealth.statusCode, 403);
  assert.equal(organizationMemberHealth.json().error.code, "ARCHITECTURE_TARGET_ACTION_FORBIDDEN");

  fixture.targetStore.removeTeamMembership(teamMemberId, teamId);
  fixture.targetStore.removeOrganizationMembership(organizationMemberId, organizationId);
  const removedTeamRead = await fixture.app.inject({
    method: "GET",
    url: `/v1/architecture-targets/${teamTarget.id}`,
    headers: { authorization: `Bearer ${teamMemberSession}` },
  });
  assert.equal(removedTeamRead.statusCode, 404);
  assert.equal(removedTeamRead.json().error.code, "ARCHITECTURE_TARGET_NOT_FOUND");
  const removedOrganizationRead = await fixture.app.inject({
    method: "GET",
    url: `/v1/architecture-targets/${organizationTarget.id}`,
    headers: { authorization: `Bearer ${organizationMemberSession}` },
  });
  assert.equal(removedOrganizationRead.statusCode, 404);
  assert.equal(removedOrganizationRead.json().error.code, "ARCHITECTURE_TARGET_NOT_FOUND");
});

test("target routes reject mutation capabilities and unsafe metadata without echoing sensitive values", async (t) => {
  const fixture = await createFixture({ includeTenants: false });
  t.after(() => fixture.app.close());
  const architecture = await seedArchitecture(fixture.architectureStore, {
    actorId: userOwnerId,
    owner: { type: "user", id: userOwnerId },
  });
  const plainSession = await addUserAndLogin(fixture, userOwnerId, "target-route-sensitive@example.com");
  const mfaSession = await verifyMfaForSession(fixture.app, plainSession, "target-route-sensitive@example.com");
  const input = targetInput(architecture, { type: "user", id: userOwnerId });

  const mutation = await fixture.app.inject({
    method: "POST",
    url: "/v1/architecture-targets",
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: { ...input, capabilities: { ...capabilities, apply: true } },
  });
  assert.equal(mutation.statusCode, 400);
  assert.equal(mutation.json().error.code, "INVALID_ARCHITECTURE_TARGET");

  const sensitiveFields = [
    ["root", "secret-root-value"],
    ["rootPath", "secret-root-path-value"],
    ["path", "secret-path-value"],
    ["prompt", "secret-prompt-value"],
    ["promptBody", "secret-prompt-body-value"],
    ["body", "secret-body-value"],
    ["source", "secret-source-value"],
    ["source_path", "secret-source-path-value"],
    ["raw", "secret-raw-value"],
    ["rawSnapshot", "secret-raw-snapshot-value"],
    ["snapshot", "secret-snapshot-value"],
    ["payload", "secret-payload-value"],
    ["file", "secret-file-value"],
    ["filename", "secret-filename-value"],
    ["directory", "secret-directory-value"],
    ["home", "secret-home-value"],
    ["host", "secret-host-value"],
    ["machine", "secret-machine-value"],
    ["machineId", "secret-machine-id-value"],
    ["credentialValue", "secret-credential-value"],
  ] as const;
  const unsafeMetadataResults = [];
  for (const [field, value] of sensitiveFields) {
    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/architecture-targets",
      headers: { authorization: `Bearer ${mfaSession}` },
      payload: { ...input, metadata: { [field]: value } },
    });
    unsafeMetadataResults.push({
      field,
      statusCode: response.statusCode,
      echoed: JSON.stringify(response.json()).includes(value),
    });
  }
  assert.deepEqual(unsafeMetadataResults, sensitiveFields.map(([field]) => ({ field, statusCode: 400, echoed: false })));

  const registered = await registerTarget(fixture, mfaSession, architecture, { type: "user", id: userOwnerId });
  const consent = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${registered.id}/consent`,
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: { decision: "grant" },
  });
  assert.equal(consent.statusCode, 200);

  const unsafeObservationResults = [];
  for (const [field, value] of sensitiveFields) {
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/architecture-targets/${registered.id}/observations`,
      headers: { authorization: `Bearer ${plainSession}` },
      payload: { ...observationInput(registered), metadata: { [field]: value } },
    });
    unsafeObservationResults.push({
      field,
      statusCode: response.statusCode,
      echoed: JSON.stringify(response.json()).includes(value),
    });
  }
  assert.deepEqual(unsafeObservationResults, sensitiveFields.map(([field]) => ({ field, statusCode: 400, echoed: false })));

  const unsafeObservedSkillResults = [];
  for (const [field, value] of sensitiveFields) {
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/architecture-targets/${registered.id}/observations`,
      headers: { authorization: `Bearer ${plainSession}` },
      payload: {
        ...observationInput(registered),
        skills: [{ slug: "route-observed-skill", metadata: { [field]: value } }],
      },
    });
    unsafeObservedSkillResults.push({
      field,
      statusCode: response.statusCode,
      echoed: JSON.stringify(response.json()).includes(value),
    });
  }
  assert.deepEqual(unsafeObservedSkillResults, sensitiveFields.map(([field]) => ({ field, statusCode: 400, echoed: false })));

  const unsafeHealthResults = [];
  for (const [field, value] of sensitiveFields) {
    const response = await fixture.app.inject({
      method: "POST",
      url: `/v1/architecture-targets/${registered.id}/health`,
      headers: { authorization: `Bearer ${plainSession}` },
      payload: { ...healthyHealth(), metadata: { [field]: value } },
    });
    unsafeHealthResults.push({
      field,
      statusCode: response.statusCode,
      echoed: JSON.stringify(response.json()).includes(value),
    });
  }
  assert.deepEqual(unsafeHealthResults, sensitiveFields.map(([field]) => ({ field, statusCode: 400, echoed: false })));

  const auditDetails = Object.fromEntries(sensitiveFields.map(([field, value]) => [field, value]));
  auditDetails.safe = "retained";
  await fixture.targetStore.recordAuditEvent({
    actorUserId: userOwnerId,
    action: "metadata-regression",
    decision: "deny",
    details: auditDetails,
  });
  const audit = await fixture.targetStore.listAuditEvents(1);
  assert.equal(audit[0]?.details.safe, "retained");
  for (const [, value] of sensitiveFields) {
    assert.equal(JSON.stringify(audit[0]?.details).includes(value), false);
  }
});

test("target route observation reads are capped at the store maximum", async (t) => {
  const fixture = await createFixture({ includeTenants: false });
  t.after(() => fixture.app.close());
  const architecture = await seedArchitecture(fixture.architectureStore, {
    actorId: userOwnerId,
    owner: { type: "user", id: userOwnerId },
  });
  const plainSession = await addUserAndLogin(fixture, userOwnerId, "target-route-cap@example.com");
  const mfaSession = await verifyMfaForSession(fixture.app, plainSession, "target-route-cap@example.com");
  const target = await registerTarget(fixture, mfaSession, architecture, { type: "user", id: userOwnerId });
  const consent = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${target.id}/consent`,
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: { decision: "grant" },
  });
  assert.equal(consent.statusCode, 200);

  for (let index = 0; index < 501; index += 1) {
    const appended = await fixture.targetService.appendObservation({
      actor: userOwnerId,
      targetId: target.id,
      observation: observationInput(target, {
        id: `bounded-observation-${index}`,
        observedAt: new Date(Date.parse("2026-08-30T00:00:00.000Z") + index * 1_000).toISOString(),
      }),
    });
    assert.equal(appended.targetId, target.id);
  }

  const listed = await fixture.app.inject({
    method: "GET",
    url: `/v1/architecture-targets/${target.id}/observations?limit=9999`,
    headers: { authorization: `Bearer ${plainSession}` },
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().observations.length, 500);
});

test("target registration uses the authoritative binding returned by the authorizer", async (t) => {
  const fixture = await createFixture({ includeTenants: false, authoritativeBinding: true });
  t.after(() => fixture.app.close());
  const plainSession = await addUserAndLogin(fixture, userOwnerId, "target-route-binding@example.com");
  const session = await verifyMfaForSession(fixture.app, plainSession, "target-route-binding@example.com");
  const response = await fixture.app.inject({
    method: "POST",
    url: "/v1/architecture-targets",
    headers: { authorization: `Bearer ${session}` },
    payload: {
      name: "Client supplied labels",
      owner: { type: "user", id: "client-label-owner" },
      architectureId: "client-architecture",
      environmentId: "client-environment",
      profileId: "client-profile",
      adapter,
      capabilities,
    },
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json().target.owner, { type: "user", id: userOwnerId });
  assert.equal(response.json().target.architectureId, "authoritative-architecture");
  assert.equal(response.json().target.environmentId, "authoritative-environment");
  assert.equal(response.json().target.profileId, "authoritative-profile");
});

interface Fixture {
  app: ReturnType<typeof buildApp>;
  authStore: MemoryAuthStore;
  architectureStore: MemoryArchitectureStore;
  targetStore: MemoryArchitectureTargetStore;
  targetService: ArchitectureTargetService;
  submissionService: SubmissionService;
}

async function createFixture(options: {
  includeTenants: boolean;
  authoritativeBinding?: boolean;
}): Promise<Fixture> {
  const authStore = new MemoryAuthStore("closed");
  const architectureStore = new MemoryArchitectureStore(options.includeTenants ? {
    teamMemberships: [
      { userId: teamOwnerId, teamId, role: "owner" },
      { userId: teamMemberId, teamId, role: "member" },
    ],
    organizationVisibilityEnabled: true,
    organizations: [{ id: organizationId, status: "active", policy: defaultOrganizationPolicyV1 }],
    organizationMemberships: [
      { userId: organizationAdminId, organizationId, role: "admin" },
      { userId: organizationMemberId, organizationId, role: "member" },
    ],
  } : {});
  const targetStore = new MemoryArchitectureTargetStore({
    teamMemberships: options.includeTenants ? [
      { userId: teamOwnerId, teamId, role: "owner" },
      { userId: teamMemberId, teamId, role: "member" },
    ] : [],
    organizationMemberships: options.includeTenants ? [
      { userId: organizationAdminId, organizationId, role: "admin" },
      { userId: organizationMemberId, organizationId, role: "member" },
    ] : [],
    now: () => new Date("2026-08-30T00:00:00.000Z"),
  });
  let nextId = 0;
  const authorizer = options.authoritativeBinding
    ? {
      authorizeBinding: async () => ({
        allowed: true,
        binding: {
          owner: { type: "user", id: userOwnerId } as const,
          architectureId: "authoritative-architecture",
          environmentId: "authoritative-environment",
          profileId: "authoritative-profile",
        },
      }),
    }
    : new ArchitectureTargetBindingAuthorizer(architectureStore, {
      organizationMembershipAuthority: {
        findMembership: async ({ organizationId: requestedOrganizationId, userId }) => {
          const memberships = new Map([
            [organizationAdminId, "admin" as const],
            [organizationMemberId, "member" as const],
          ]);
          const role = memberships.get(userId);
          return role && requestedOrganizationId === organizationId
            ? { organizationId, userId, role }
            : null;
        },
      },
    });
  const targetService = new ArchitectureTargetService(targetStore, authorizer, {
    now: () => new Date("2026-08-30T00:00:00.000Z"),
    idFactory: () => `target-route-${++nextId}`,
  });
  const submissionService = new SubmissionService(new MemorySubmissionStore());
  const upgradePolicyService = new SkillUpgradePolicyService(new MemorySkillUpgradePolicyStore());
  const targetSkillOperationService = new TargetSkillOperationService(
    new MemoryTargetSkillOperationStore(),
    targetService,
    submissionService,
    { upgradePolicies: upgradePolicyService },
  );
  const app = buildApp({
    skillRepository: new MemorySkillRepository([]),
    authService: new AuthService(authStore),
    architectureStore,
    architectureTargetService: targetService,
    submissionService,
    targetSkillOperationService,
    skillUpgradePolicyService: upgradePolicyService,
  });
  return { app, authStore, architectureStore, targetStore, targetService, submissionService };
}

async function seedPublicRelease(service: SubmissionService, actorId: string, version: string): Promise<void> {
  const manifest = {
    name: "release-notes-helper",
    title: "Release Notes Helper",
    summary: "Turns changes into concise release notes.",
    version,
    license: "Apache-2.0",
    visibility: "public" as const,
    platforms: [{ name: "codex", install_target: "codex-skill", status: "supported" as const }],
    tags: ["release"],
  };
  const submitted = await service.createSubmission({
    actor: { id: actorId, roles: ["author"] },
    manifest,
    release: { releaseNotes: "Adds the connected update route.", changeKind: "feature", requiresUserAction: false, compatibility: { minimumAdapterContractVersion: 2 } },
    files: [
      { path: "skill.json", content: JSON.stringify(manifest) },
      { path: "README.md", content: "Connected update route." },
    ],
  });
  await service.performReviewAction({ actor: { id: "route-maintainer", roles: ["maintainer"] }, submissionId: submitted.id, action: "approve", artifactSha256: submitted.artifact.sha256 });
  await service.performReviewAction({ actor: { id: "route-maintainer", roles: ["maintainer"] }, submissionId: submitted.id, action: "publish" });
}

async function seedArchitecture(
  store: MemoryArchitectureStore,
  input: { actorId: string; owner: ArchitectureTargetOwnerReference },
): Promise<{ architectureId: string; environmentId: string; profileId: string; revisionId: string }> {
  const architecture = await store.createArchitecture({
    actor: input.actorId,
    owner: input.owner,
    name: `${input.owner.type} target route architecture`,
    description: "",
    patternId: "flat",
  });
  const environmentId = `environment-${architecture.id}`;
  const profileId = `profile-${architecture.id}`;
  const spec = createFlatArchitecture({
    id: architecture.id,
    name: architecture.name,
    profile: { id: profileId, subject: { type: "user", id: input.actorId } },
    environment: { id: environmentId, kind: "personal" },
    skills: [{
      id: "target-route-fixture-skill",
      slug: "target-route-fixture-skill",
      title: "Target route fixture skill",
      version: "1.0.0",
      digest: "a".repeat(64),
      packageVisibility: "authenticated",
    }],
  });
  const revision = await store.createRevision({
    actor: input.actorId,
    architectureId: architecture.id,
    expectedCurrentRevisionId: null,
    message: "target route fixture",
    spec,
  });
  assert.ok(revision);
  return { architectureId: architecture.id, environmentId, profileId, revisionId: revision.id };
}

function targetInput(
  architecture: { architectureId: string; environmentId: string; profileId: string },
  owner: ArchitectureTargetOwnerReference,
) {
  return {
    name: "Target route fixture",
    owner,
    architectureId: architecture.architectureId,
    environmentId: architecture.environmentId,
    profileId: architecture.profileId,
    adapter,
    capabilities,
  };
}

async function registerTarget(
  fixture: Fixture,
  session: string,
  architecture: { architectureId: string; environmentId: string; profileId: string },
  owner: ArchitectureTargetOwnerReference,
): Promise<ArchitectureTargetRecord> {
  const response = await fixture.app.inject({
    method: "POST",
    url: "/v1/architecture-targets",
    headers: { authorization: `Bearer ${session}` },
    payload: targetInput(architecture, owner),
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().target as ArchitectureTargetRecord;
}

function observationInput(
  target: Pick<ArchitectureTargetRecord, "id" | "generation" | "adapter" | "capabilities">,
  overrides: Partial<ArchitectureTargetObservationInput> = {},
): ArchitectureTargetObservationInput {
  return {
    schemaVersion: 1,
    targetId: target.id,
    targetGeneration: target.generation,
    adapterDigest: architectureTargetAdapterDigest(target.adapter),
    capabilitiesDigest: architectureTargetCapabilitiesDigest(target.capabilities, target.adapter.contractVersion),
    observedAt: "2026-08-30T00:01:00.000Z",
    skills: [],
    configFindings: [],
    promptAwareness: { detected: false, count: 0, redacted: true },
    ...overrides,
  };
}

function healthyHealth() {
  return { status: "healthy", checkedAt: "2026-08-30T00:02:00.000Z" };
}

async function addUserAndLogin(fixture: Fixture, id: string, email: string): Promise<string> {
  fixture.authStore.addUser({
    id,
    email,
    name: id,
    status: "active",
    emailVerifiedAt: new Date(),
    roles: ["user"],
    passwordHash: await hashPassword(PASSWORD),
  });
  const response = await fixture.app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email, password: PASSWORD },
  });
  assert.equal(response.statusCode, 200);
  return response.json().token as string;
}

async function verifyMfaForSession(
  app: ReturnType<typeof buildApp>,
  session: string,
  email: string,
): Promise<string> {
  const enrollment = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/enroll",
    headers: { authorization: `Bearer ${session}` },
    payload: { password: PASSWORD },
  });
  assert.equal(enrollment.statusCode, 201, enrollment.body);
  const enrollmentBody = enrollment.json();
  const confirm = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/confirm",
    headers: { authorization: `Bearer ${session}` },
    payload: {
      factorId: enrollmentBody.enrollment.factorId,
      code: generateTotpCode(enrollmentBody.enrollment.secret),
    },
  });
  assert.equal(confirm.statusCode, 200, confirm.body);
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email, password: PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  const verification = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    payload: {
      challengeToken: login.json().challengeToken,
      recoveryCode: confirm.json().mfa.recoveryCodes[0],
    },
  });
  assert.equal(verification.statusCode, 200, verification.body);
  return verification.json().token as string;
}
