/**
 * Skill improvement (OPT-1) API journeys against the in-memory stores.
 *
 * Failure cases enumerated before implementation. Each journey below covers the listed cases
 * through the real HTTP routes, auth, services, and stores:
 *
 * Declarations and approval binding (AC-01, AC-02)
 *  D1 legacy release without a declaration projects as `unspecified`; bytes and release metadata keys stay unchanged
 *  D2 invalid declarations (targeted without targets, unknown fields, absolute paths, URLs) are rejected
 *  D3 non-managers cannot append; unpublished releases stay invisible to them (non-enumerating 404)
 *  D4 stale expectedRevisionNumber conflicts; identical replay is idempotent
 *  D5 review needs the review role and MFA; wrong artifact or declaration digest is rejected
 *  D6 an unapproved declaration never appears publicly; a newer edit hides the older approval
 *  D7 revisions after publication are attestations, shown separately with their issuer
 *  D8 approved author targets display as designed-for-untested, never as measured compatibility
 *
 * Publication binding (AC-01)
 *  B1 releases without a declaration publish exactly as before
 *  B2 a pending latest declaration blocks publication with an actionable 409; the release stays unpublished and a deny audit is written
 *  B3 a newer pre-publication edit invalidates the earlier approval for publication, not only for display
 *  B4 a rejected latest declaration blocks even after an earlier approval; an approved `unspecified` revision withdraws the claim
 *  B5 a declaration read as pre-publication but written after publication committed is refused; the retry is an attestation
 *  B6 pending attestations on published releases never block publication and never change published bytes
 *
 * Policies and resource ceilings (AC-03, AC-04)
 *  P1 team/org policy writes need the owner/admin role; outsiders get 404 on reads
 *  P2 team/org contexts without an enabled policy block (POLICY_MISSING / POLICY_DISABLED)
 *  P3 policy revision conflicts
 *  P4 personal context on a team-granted child-team skill inherits team and parent-org ceilings
 *  P5 the skill's own manager is still bound by resource-owner ceilings
 *  P6 designated reviewer allowlists and required reviewers are enforced; reviewer cycles block
 *  P7 selecting one team never merges another team's policy; child teams inherit the parent org
 *  P8 pinned source digest mismatch blocks; blocked creation writes a deny audit
 *  P9 API tokens need the matching improvements scope
 *
 * Plan/run lifecycle (AC-05, AC-10, AC-14, AC-15, AC-18)
 *  R1 plan idempotency: replay returns the same plan; key reuse with a different request conflicts
 *  R2 altered plan digest, other users' plans, missing declared runner controls are rejected
 *  R3 one active attempt per plan; bounded attempts
 *  R4 event sequence gaps, conflicting replays, and invalid stage order are rejected
 *  R5 unsafe or identity-mismatched candidates cannot be frozen; analysis-only plans cannot freeze
 *  R6 evaluation digests, counts, and unattested model identity are validated
 *  R7 forged report fields (scores, provenance) are rejected; findings must cite plan reviewers;
 *     local-only plans cannot upload findings in the completion report; claude-code runners use the same protocol
 *  R8 cancellation is terminal; late events cannot revive a run
 *  R9 revoked reviewer blocks the next stage and fails the run; policy change makes the plan stale
 *  R10 plan expiry moves the run to expired and blocks new attempts
 *
 * Evidence and claims (AC-02, AC-11, AC-17)
 *  E1 disclosure beyond the plan or current policy is rejected; local-only plans cannot share
 *  E2 evidence cannot bind to a release whose artifact differs from the tested bytes
 *  E3 third-party evidence stays private until the release manager accepts the exact digest
 *  E4 every API-created result is local-report; caller fields never produce measured-improvement
 *  E5 profile revision after acceptance marks evidence stale
 *  E6 audits never contain finding text, guidance URLs, or report bodies
 *  E7 local/unrelated-parent sources cannot bypass destination disclosure, missing policy or disabled policy
 *  E8 static findings and stale evaluations cannot label a declared target tested
 *  E9 revoked reviewers or newly blocking policies stop subsequent sharing
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateTotpCode, hashPassword, type Role } from "@myskills-app/auth";
import { improvementPlanDigest, improvementTreeSha256, optimizationDeclarationApprovalDigest } from "@myskills-app/core";
import { buildApp } from "../src/app.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { AuthService } from "../src/auth/service.js";
import { ImprovementService } from "../src/improvements/service.js";
import { MemoryImprovementStore } from "../src/improvements/memory-store.js";
import { MemoryOrganizationStore } from "../src/organizations/memory-organization-store.js";
import { OrganizationService } from "../src/organizations/service.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { MemorySubmissionStore } from "../src/submissions/memory-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";
import { MemoryTeamStore } from "../src/teams/memory-team-store.js";
import { TeamService } from "../src/teams/service.js";

type TestUser = { id: string; email: string; name: string; roles: Role[] };
type JourneyApp = ReturnType<typeof buildApp>;
type ResponseLike = { statusCode: number; body: string; json: () => unknown };

const PASSWORD = "correct horse battery staple";
const users = {
  author: { id: "author-1", email: "author@example.com", name: "Author", roles: ["author"] },
  reviewerAuthor: { id: "reviewer-author", email: "reviewer-author@example.com", name: "Reviewer Author", roles: ["author"] },
  maintainer: { id: "maintainer-1", email: "maintainer@example.com", name: "Maintainer", roles: ["maintainer"] },
  unverifiedMaintainer: { id: "maintainer-2", email: "maintainer-two@example.com", name: "Maintainer Two", roles: ["maintainer"] },
  member: { id: "member-1", email: "member@example.com", name: "Member", roles: ["user"] },
  orgOwner: { id: "org-owner", email: "org-owner@example.com", name: "Org Owner", roles: ["user"] },
  outsider: { id: "outsider-1", email: "outsider@example.com", name: "Outsider", roles: ["author"] },
} satisfies Record<string, TestUser>;

const releaseMetadata = {
  releaseNotes: "Fixture release for improvement journeys.",
  changeKind: "feature",
  requiresUserAction: false,
  compatibility: { minimumMyskillsVersion: "0.1.0-beta.4", minimumAdapterContractVersion: 1, minimumSourceVersion: "0.0.1" },
};

const declarationV1 = {
  schemaVersion: 1,
  intent: "targeted",
  targets: [{
    id: "codex-gpt-5-5",
    models: [{ provider: "openai", id: "gpt-5.5" }],
    apps: [{ id: "codex", version: "0.50.0" }],
    environment: { os: ["macos", "linux"], requiredCapabilities: ["workspace.read"], network: "optional" },
  }],
  objectives: ["task-success", "token-efficiency"],
  limitations: ["No claim for other model or app versions."],
};

const profileBody = {
  schemaVersion: 1,
  name: "Codex with GPT-5.5",
  target: {
    model: { provider: "openai", id: "gpt-5.5" },
    app: { id: "codex", version: "0.50.0" },
    environment: { os: ["macos"], requiredCapabilities: ["workspace.read"], network: "optional" },
  },
  settings: { reasoningEffort: "high" },
  objectives: ["task-success"],
  protectedRequirements: ["Keep the release-note output contract."],
};

const suiteBody = {
  schemaVersion: 1,
  name: "Release notes regression suite",
  contentSha256: "c".repeat(64),
  rubricSha256: "d".repeat(64),
  caseCount: 12,
  protectedCaseCount: 3,
  holdoutCaseCount: 4,
  graders: ["deterministic"],
  repetitions: 3,
};

const codexRunner = {
  adapter: "codex",
  adapterVersion: "0.50.0",
  coordinatorVersion: "0.1.0-beta.8",
  capabilities: {
    structuredOutput: true,
    workspaceIsolation: true,
    networkRestriction: false,
    tokenAccounting: false,
    cancellation: false,
    exactModelReadback: false,
  },
};

const FINDING_TEXT = "Shorten the routing preamble for the target model.";
const GUIDANCE_URL = "https://docs.example.com/prompting/model-guidance";

test("release declarations bind approval to the exact revision and artifact; edits and attestations stay separate", async (t) => {
  const fx = await createJourneyFixture();
  t.after(() => fx.app.close());
  const journal = recorder("declarations");
  const author = await fx.login(users.author);
  const outsider = await fx.login(users.outsider);
  const maintainer = await fx.login(users.maintainer, { mfa: true });
  const unverifiedMaintainer = await fx.login(users.unverifiedMaintainer);

  const legacy = await fx.publish(author, { name: "release-notes-helper", version: "1.0.0", readme: "Summarize release notes." });
  const legacyBundle = await call(fx.app, "GET", "/v1/skills/release-notes-helper/releases/1.0.0/bundle?platform=codex");
  journal.check("legacy bundle readable", legacyBundle, 200);
  assert.equal(sha256(legacyBundle.body), legacy.artifactSha256);
  const legacyMetadata = await call(fx.app, "GET", "/v1/skills/release-notes-helper/releases/1.0.0");
  const legacyMetadataKeys = Object.keys(legacyMetadata.json().release).sort();

  // D1: legacy releases resolve to unspecified without rewriting anything.
  const legacyCompat = journal.check("legacy compatibility", await call(fx.app, "GET", compatUrl("release-notes-helper", "1.0.0")), 200);
  assert.equal(body(legacyCompat).compatibility.declaration.status, "unspecified");
  assert.equal(body(legacyCompat).compatibility.attestation.status, "none");
  assert.deepEqual(body(legacyCompat).compatibility.evidence, []);
  assert.equal(body(legacyCompat).compatibility.manage, undefined);

  const pending = await fx.submit(author, { name: "release-notes-helper", version: "1.1.0", readme: "Summarize release notes with headings." });
  const declarationsUrl = "/v1/improvements/releases/release-notes-helper/1.1.0/declarations";

  // D2: strict declaration validation.
  for (const [step, declaration] of [
    ["targeted without targets", { ...declarationV1, targets: [] }],
    ["unknown verified field", { ...declarationV1, verified: true }],
    ["absolute path limitation", { ...declarationV1, limitations: ["Tested from /home/alex/private-skill only."] }],
    ["tenant url limitation", { ...declarationV1, limitations: ["See https://tenant.example.com/report"] }],
    ["unknown objective", { ...declarationV1, objectives: ["guaranteed-quality"] }],
  ] as const) {
    journal.check(`reject ${step}`, await call(fx.app, "POST", declarationsUrl, author, { declaration, expectedRevisionNumber: 0 }), 400, "INVALID_IMPROVEMENT_REQUEST");
  }

  // D3: non-managers cannot see unpublished releases or write declarations on published ones.
  journal.check("outsider pending release hidden", await call(fx.app, "POST", declarationsUrl, outsider, { declaration: declarationV1, expectedRevisionNumber: 0 }), 404, "RELEASE_NOT_FOUND");
  journal.check("outsider cannot declare on published release", await call(fx.app, "POST", "/v1/improvements/releases/release-notes-helper/1.0.0/declarations", outsider, {
    declaration: declarationV1, expectedRevisionNumber: 0,
  }), 403, "IMPROVEMENT_RELEASE_MANAGER_REQUIRED");

  const first = journal.check("append declaration", await call(fx.app, "POST", declarationsUrl, author, { declaration: declarationV1, expectedRevisionNumber: 0 }), 201);
  const firstRevision = body(first).revision;
  assert.equal(firstRevision.kind, "declaration");
  assert.equal(firstRevision.revisionNumber, 1);
  assert.equal(firstRevision.review, null);
  // D4: replay and conflicts.
  const replay = journal.check("replay identical declaration", await call(fx.app, "POST", declarationsUrl, author, { declaration: declarationV1, expectedRevisionNumber: 0 }), 200);
  assert.equal(body(replay).revision.id, firstRevision.id);
  assert.equal(body(replay).created, false);
  const conflict = journal.check("stale declaration revision", await call(fx.app, "POST", declarationsUrl, author, {
    declaration: { ...declarationV1, objectives: ["task-success"] }, expectedRevisionNumber: 0,
  }), 409, "IMPROVEMENT_REVISION_CONFLICT");
  assert.equal(body(conflict).error.details.currentRevisionNumber, 1);

  // D5: review authority and exact binding.
  const reviewUrl = `${declarationsUrl}/${firstRevision.id}/review`;
  const binding = { artifactSha256: pending.artifactSha256, declarationSha256: firstRevision.declarationSha256 };
  journal.check("author cannot review", await call(fx.app, "POST", reviewUrl, author, { decision: "approve", ...binding }), 403, "REVIEW_ROLE_REQUIRED");
  journal.check("review requires MFA", await call(fx.app, "POST", reviewUrl, unverifiedMaintainer, { decision: "approve", ...binding }), 403, "MFA_VERIFICATION_REQUIRED");
  journal.check("wrong artifact digest", await call(fx.app, "POST", reviewUrl, maintainer, { decision: "approve", ...binding, artifactSha256: "0".repeat(64) }), 422, "IMPROVEMENT_BINDING_MISMATCH");
  journal.check("wrong declaration digest", await call(fx.app, "POST", reviewUrl, maintainer, { decision: "approve", ...binding, declarationSha256: "1".repeat(64) }), 422, "IMPROVEMENT_BINDING_MISMATCH");
  const approved = journal.check("approve exact declaration", await call(fx.app, "POST", reviewUrl, maintainer, { decision: "approve", ...binding, reason: "Checked targets." }), 200);
  assert.equal(body(approved).revision.review.decision, "approve");
  assert.equal(body(approved).revision.review.bindingSha256, optimizationDeclarationApprovalDigest({
    releaseId: firstRevision.releaseId,
    artifactSha256: pending.artifactSha256,
    declarationRevisionId: firstRevision.id,
    declarationSha256: firstRevision.declarationSha256,
  }));
  journal.check("second review rejected", await call(fx.app, "POST", reviewUrl, maintainer, { decision: "approve", ...binding }), 409, "IMPROVEMENT_DECLARATION_REVIEWED");

  // D6: a newer pre-publication edit hides the earlier approval.
  const second = journal.check("edit declaration before publication", await call(fx.app, "POST", declarationsUrl, author, {
    declaration: { ...declarationV1, limitations: ["No claim for Windows."] }, expectedRevisionNumber: 1,
  }), 201);
  const secondRevision = body(second).revision;
  const ownerView = journal.check("owner sees pending edit", await call(fx.app, "GET", compatUrl("release-notes-helper", "1.1.0"), author), 200);
  assert.equal(body(ownerView).compatibility.declaration.status, "unspecified");
  assert.deepEqual(body(ownerView).compatibility.manage.pendingRevisions.map((item: { id: string }) => item.id), [secondRevision.id]);
  journal.check("stale approval of older revision", await call(fx.app, "POST", reviewUrl.replace(firstRevision.id, firstRevision.id), maintainer, {
    decision: "approve", ...binding,
  }), 409, "IMPROVEMENT_DECLARATION_REVIEWED");

  // B2/B3: the byte approval does not cover the edited declaration; publication rechecks the latest revision.
  await fx.approve(pending.submissionId);
  const blocked = journal.check("publish with pending declaration", await fx.publishAttempt(pending.submissionId), 409, "RELEASE_DECLARATION_NOT_APPROVED");
  assert.deepEqual(body(blocked).error.details, { revisionId: secondRevision.id, revisionNumber: 2, status: "pending" });
  journal.check("blocked release stays unpublished", await call(fx.app, "GET", "/v1/skills/release-notes-helper/releases/1.1.0/bundle?platform=codex"), 404);
  assert.equal(body(await call(fx.app, "GET", compatUrl("release-notes-helper", "1.1.0"), author)).compatibility.release.published, false);
  assert.ok(fx.submissionStore.auditEvents().some((event) => event.action === "release.publish" && event.decision === "deny"
    && event.details.reason === "release_declaration_not_approved"), "blocked publication must write a deny audit");

  journal.check("approve second declaration", await call(fx.app, "POST", `${declarationsUrl}/${secondRevision.id}/review`, maintainer, {
    decision: "approve", artifactSha256: pending.artifactSha256, declarationSha256: secondRevision.declarationSha256,
  }), 200);
  journal.check("publish with approved latest declaration", await fx.publishAttempt(pending.submissionId), 200);
  const designed = journal.check("approved declaration visible", await call(fx.app, "GET", compatUrl("release-notes-helper", "1.1.0")), 200);
  const designedCompat = body(designed).compatibility;
  assert.equal(designedCompat.declaration.status, "approved");
  assert.equal(designedCompat.declaration.revision.revisionNumber, 2);
  // D8: author targets are untested claims only.
  assert.deepEqual(designedCompat.declaration.targets.map((item: { status: string }) => item.status), ["designed-for-untested"]);
  assert.equal(JSON.stringify(designedCompat).includes("measured-improvement"), false);
  journal.note("declaration target status", designedCompat.declaration.targets.map((item: { status: string }) => item.status));

  // D7: post-publication corrections are attestations with a separate issuer.
  const attestation = journal.check("append attestation", await call(fx.app, "POST", declarationsUrl, author, {
    declaration: { ...declarationV1, limitations: ["No claim for Windows or Linux."] }, expectedRevisionNumber: 2,
  }), 201);
  const attestationRevision = body(attestation).revision;
  assert.equal(attestationRevision.kind, "attestation");
  const pendingAttestation = await call(fx.app, "GET", compatUrl("release-notes-helper", "1.1.0"));
  assert.equal(body(pendingAttestation).compatibility.attestation.status, "none");
  assert.equal(body(pendingAttestation).compatibility.declaration.revision.revisionNumber, 2);
  journal.check("approve attestation", await call(fx.app, "POST", `${declarationsUrl}/${attestationRevision.id}/review`, maintainer, {
    decision: "approve", artifactSha256: pending.artifactSha256, declarationSha256: attestationRevision.declarationSha256,
  }), 200);
  const attested = body(await call(fx.app, "GET", compatUrl("release-notes-helper", "1.1.0"))).compatibility;
  assert.equal(attested.attestation.status, "approved");
  assert.equal(attested.attestation.revision.issuerUserId, users.author.id);
  assert.equal(attested.declaration.revision.revisionNumber, 2);

  // AC-01: bytes and old response shapes are unchanged.
  const bundleAfter = await call(fx.app, "GET", "/v1/skills/release-notes-helper/releases/1.0.0/bundle?platform=codex");
  assert.equal(sha256(bundleAfter.body), legacy.artifactSha256);
  const newBundle = await call(fx.app, "GET", "/v1/skills/release-notes-helper/releases/1.1.0/bundle?platform=codex");
  assert.equal(sha256(newBundle.body), pending.artifactSha256);
  const metadataAfter = await call(fx.app, "GET", "/v1/skills/release-notes-helper/releases/1.1.0");
  assert.deepEqual(Object.keys(metadataAfter.json().release).sort(), legacyMetadataKeys);
  const legacyAfter = body(await call(fx.app, "GET", compatUrl("release-notes-helper", "1.0.0"))).compatibility;
  assert.equal(legacyAfter.declaration.status, "unspecified");

  journal.write("memory");
});

test("publication rechecks the latest author declaration atomically; attestations never block", async (t) => {
  const fx = await createJourneyFixture();
  t.after(() => fx.app.close());
  const journal = recorder("publication-binding");
  const author = await fx.login(users.author);
  const maintainer = await fx.login(users.maintainer, { mfa: true });
  const declarationsUrl = (version: string) => `/v1/improvements/releases/triage-helper/${version}/declarations`;
  const review = (version: string, revision: { id: string; declarationSha256: string }, artifactSha256: string, decision: "approve" | "reject") =>
    call(fx.app, "POST", `${declarationsUrl(version)}/${revision.id}/review`, maintainer, { decision, artifactSha256, declarationSha256: revision.declarationSha256 });

  // B1: publication without a declaration is unchanged.
  const legacy = await fx.publish(author, { name: "triage-helper", version: "1.0.0", readme: "Triage incoming issues." });
  assert.equal(body(await call(fx.app, "GET", compatUrl("triage-helper", "1.0.0"))).compatibility.declaration.status, "unspecified");

  // B6: a pending attestation on a published release is not a publication condition.
  const pendingAttestation = body(journal.check("pending attestation on published release", await call(fx.app, "POST", declarationsUrl("1.0.0"), author, {
    declaration: declarationV1, expectedRevisionNumber: 0,
  }), 201)).revision;
  assert.equal(pendingAttestation.kind, "attestation");

  // B4: a rejected latest revision blocks publication even after an earlier approval.
  const next = await fx.submit(author, { name: "triage-helper", version: "1.1.0", readme: "Triage incoming issues by severity." });
  await fx.approve(next.submissionId);
  const first = body(journal.check("append declaration", await call(fx.app, "POST", declarationsUrl("1.1.0"), author, {
    declaration: declarationV1, expectedRevisionNumber: 0,
  }), 201)).revision;
  journal.check("approve declaration", await review("1.1.0", first, next.artifactSha256, "approve"), 200);
  const broader = body(journal.check("append broader declaration", await call(fx.app, "POST", declarationsUrl("1.1.0"), author, {
    declaration: { ...declarationV1, limitations: ["No claim for Windows."] }, expectedRevisionNumber: 1,
  }), 201)).revision;
  journal.check("reject broader declaration", await review("1.1.0", broader, next.artifactSha256, "reject"), 200);
  const rejected = journal.check("publish with rejected declaration", await fx.publishAttempt(next.submissionId), 409, "RELEASE_DECLARATION_NOT_APPROVED");
  assert.deepEqual(body(rejected).error.details, { revisionId: broader.id, revisionNumber: 2, status: "rejected" });

  // An approved unspecified revision withdraws the claim and unblocks publication.
  const withdrawn = body(journal.check("append unspecified declaration", await call(fx.app, "POST", declarationsUrl("1.1.0"), author, {
    declaration: { schemaVersion: 1, intent: "unspecified" }, expectedRevisionNumber: 2,
  }), 201)).revision;
  journal.check("approve unspecified declaration", await review("1.1.0", withdrawn, next.artifactSha256, "approve"), 200);
  journal.check("publish with approved latest declaration", await fx.publishAttempt(next.submissionId), 200);
  const published = body(await call(fx.app, "GET", compatUrl("triage-helper", "1.1.0"))).compatibility;
  assert.equal(published.release.published, true);
  assert.equal(published.declaration.status, "approved");
  assert.equal(published.declaration.revision.revisionNumber, 3);
  assert.equal(published.declaration.revision.declaration.intent, "unspecified");
  assert.deepEqual(published.declaration.targets, []);

  // B5: a declaration read as pre-publication but written after publication committed is refused.
  const raced = await fx.submit(author, { name: "triage-helper", version: "1.2.0", readme: "Triage incoming issues by owner." });
  await fx.approve(raced.submissionId);
  fx.afterNextReleaseRead(async () => {
    journal.check("publish between declaration read and write", await fx.publishAttempt(raced.submissionId), 200);
  });
  journal.check("stale pre-publication declaration", await call(fx.app, "POST", declarationsUrl("1.2.0"), author, {
    declaration: declarationV1, expectedRevisionNumber: 0,
  }), 409, "IMPROVEMENT_RELEASE_STATE_CHANGED");
  const retried = body(journal.check("retry as attestation", await call(fx.app, "POST", declarationsUrl("1.2.0"), author, {
    declaration: declarationV1, expectedRevisionNumber: 0,
  }), 201)).revision;
  assert.equal(retried.kind, "attestation");
  const racedCompat = body(await call(fx.app, "GET", compatUrl("triage-helper", "1.2.0"))).compatibility;
  assert.equal(racedCompat.release.published, true);
  assert.equal(racedCompat.declaration.status, "unspecified");
  assert.equal(racedCompat.attestation.status, "none");

  // B6: the pending attestation on 1.0.0 blocked neither publication and left its bytes unchanged.
  const legacyCompat = body(await call(fx.app, "GET", compatUrl("triage-helper", "1.0.0"), author)).compatibility;
  assert.equal(legacyCompat.attestation.status, "none");
  assert.deepEqual(legacyCompat.manage.pendingRevisions.map((item: { id: string }) => item.id), [pendingAttestation.id]);
  const legacyBundle = journal.check("legacy bundle unchanged", await call(fx.app, "GET", "/v1/skills/triage-helper/releases/1.0.0/bundle?platform=codex"), 200);
  assert.equal(sha256(legacyBundle.body), legacy.artifactSha256);

  journal.write("memory");
});

test("reviewer policies compose user, team, child-team, and organization scopes; resource ceilings bind personal runs", async (t) => {
  const fx = await createJourneyFixture();
  t.after(() => fx.app.close());
  const journal = recorder("policies");
  const author = await fx.login(users.author, { mfa: true });
  const reviewerAuthor = await fx.login(users.reviewerAuthor);
  const member = await fx.login(users.member, { mfa: true });
  const orgOwner = await fx.login(users.orgOwner, { mfa: true });
  const outsider = await fx.login(users.outsider, { mfa: true });

  const organization = journal.check("create organization", await call(fx.app, "POST", "/v1/organizations", orgOwner, { name: "Platform Skills", slug: "platform-skills" }), 201);
  const orgId = body(organization).organization.id as string;
  const childTeam = journal.check("create child team", await call(fx.app, "POST", `/v1/organizations/${orgId}/teams`, orgOwner, { name: "Release Tools" }), 201);
  const childTeamId = body(childTeam).team.id as string;
  const docsTeam = journal.check("create standalone team", await call(fx.app, "POST", "/v1/teams", orgOwner, { name: "Docs Guild" }), 201);
  const docsTeamId = body(docsTeam).team.id as string;
  const invitation = await call(fx.app, "POST", `/v1/organizations/${orgId}/invitations`, orgOwner, { email: users.member.email });
  journal.check("invite member", invitation, 201);
  journal.check("member joins organization", await call(fx.app, "POST", `/v1/organizations/invitations/${body(invitation).invitation.id}/accept`, member, {}), 200);

  // The subject skill is visible only through the org child team.
  fx.submissionStore.addOrganization({ id: orgId });
  fx.submissionStore.addOrganizationMembership(users.member.id, orgId, "member");
  fx.submissionStore.addTeam({ id: childTeamId, organizationId: orgId });
  fx.submissionStore.addTeamMembership(users.member.id, childTeamId, { organizationId: orgId });
  const subject = await fx.publish(author, { name: "incident-summary", version: "1.0.0", visibility: "team", readme: "Summarize incidents." });
  fx.submissionStore.addTeamGrant("incident-summary", childTeamId);
  fx.improvementStore.setSkillGovernance("incident-summary", { visibility: "team", organizationIds: [], teams: [{ id: childTeamId, organizationId: orgId }] });
  const publicHelper = await fx.publish(author, { name: "public-helper", version: "1.0.0", readme: "Help with public docs." });
  const guidance = await fx.publish(reviewerAuthor, { name: "model-guidance-reviewer", version: "1.0.0", readme: "Review against model guidance." });
  const compat = await fx.publish(reviewerAuthor, { name: "app-compat-reviewer", version: "1.0.0", readme: "Review app compatibility." });
  const guidancePin = pin("model-guidance-reviewer", guidance.artifactSha256, ["analyze", "propose"]);
  const compatPin = pin("app-compat-reviewer", compat.artifactSha256, ["analyze"]);

  const memberProfile = await fx.createProfile(member, { type: "user", id: users.member.id });
  const authorProfile = await fx.createProfile(author, { type: "user", id: users.author.id });
  const ownerProfile = await fx.createProfile(orgOwner, { type: "user", id: users.orgOwner.id });
  const incidentSource = { kind: "release", slug: "incident-summary", version: "1.0.0", artifactSha256: subject.artifactSha256 };
  const helperSource = { kind: "release", slug: "public-helper", version: "1.0.0", artifactSha256: publicHelper.artifactSha256 };

  // P2: organization context needs a designated, enabled policy.
  const orgMissing = await preview(fx, member, planRequest({ context: { type: "organization", id: orgId }, source: helperSource, reviewers: [guidancePin], profileRevisionId: memberProfile }));
  assert.equal(orgMissing.effectivePolicy.status, "blocked");
  assert.deepEqual(blockerCodes(orgMissing), ["POLICY_MISSING"]);
  journal.note("org context without policy", blockerCodes(orgMissing));

  // P1: scope write authority.
  const orgPolicyUrl = `/v1/improvements/policies/organization/${orgId}`;
  const childPolicyUrl = `/v1/improvements/policies/team/${childTeamId}`;
  journal.check("member cannot write org policy", await call(fx.app, "PUT", orgPolicyUrl, member, { policy: { schemaVersion: 1 }, expectedRevisionNumber: 0 }), 403, "IMPROVEMENT_SCOPE_FORBIDDEN");
  journal.check("outsider cannot read org policy", await call(fx.app, "GET", orgPolicyUrl, outsider), 404, "IMPROVEMENT_NOT_FOUND");
  journal.check("member cannot write child team policy", await call(fx.app, "PUT", childPolicyUrl, member, { policy: { schemaVersion: 1 }, expectedRevisionNumber: 0 }), 404, "IMPROVEMENT_NOT_FOUND");

  const orgPolicy = {
    schemaVersion: 1,
    enabled: true,
    reviewers: [{ ...guidancePin, required: true, parameters: {} }],
    reviewerAllowlist: "designated",
    inference: { routes: ["on-device"], providers: null, models: null },
    maxDisclosure: "local-only",
    requiredChecks: ["protected-cases"],
  };
  journal.check("org policy revision 1", await call(fx.app, "PUT", orgPolicyUrl, orgOwner, { policy: orgPolicy, expectedRevisionNumber: 0, reason: "Designate reviewers." }), 201);
  // P3: stale writes conflict.
  const policyConflict = journal.check("org policy conflict", await call(fx.app, "PUT", orgPolicyUrl, orgOwner, { policy: { ...orgPolicy, maxDisclosure: "summary" }, expectedRevisionNumber: 0 }), 409, "IMPROVEMENT_REVISION_CONFLICT");
  assert.equal(body(policyConflict).error.details.currentRevisionNumber, 1);
  const memberRead = journal.check("member reads org policy", await call(fx.app, "GET", orgPolicyUrl, member), 200);
  assert.equal(body(memberRead).revision.revisionNumber, 1);
  journal.check("child team policy", await call(fx.app, "PUT", childPolicyUrl, orgOwner, {
    policy: { schemaVersion: 1, enabled: true, inference: { routes: ["cloud", "on-device"], providers: null, models: null }, maxDisclosure: "summary" },
    expectedRevisionNumber: 0,
  }), 201);
  journal.check("docs team policy", await call(fx.app, "PUT", `/v1/improvements/policies/team/${docsTeamId}`, orgOwner, {
    policy: { schemaVersion: 1, enabled: true, reviewers: [{ ...compatPin, required: true, parameters: {} }], inference: { routes: ["cloud"], providers: null, models: null } },
    expectedRevisionNumber: 0,
  }), 201);

  // P4: personal context does not bypass the child team and parent organization ceilings.
  const personalCloud = await preview(fx, member, planRequest({ context: { type: "user", id: users.member.id }, source: incidentSource, reviewers: [guidancePin], profileRevisionId: memberProfile }));
  assert.equal(personalCloud.effectivePolicy.status, "blocked");
  assert.deepEqual(blockerCodes(personalCloud), ["DISCLOSURE_NOT_ALLOWED", "INFERENCE_ROUTE_BLOCKED"]);
  assert.ok(personalCloud.effectivePolicy.blockers.every((item: { source: { type: string; id: string } }) => item.source.type === "organization" && item.source.id === orgId));
  assert.deepEqual(constraintSummary(personalCloud), [
    `organization:${orgId}:subject-resource`,
    `team:${childTeamId}:subject-resource`,
    `user:${users.member.id}:run-context`,
  ]);
  journal.note("personal context resource ceilings", blockerCodes(personalCloud));

  // P5: the skill's manager is also bound.
  const managerCloud = await preview(fx, author, planRequest({ context: { type: "user", id: users.author.id }, source: incidentSource, reviewers: [guidancePin], profileRevisionId: authorProfile }));
  assert.deepEqual(blockerCodes(managerCloud), ["DISCLOSURE_NOT_ALLOWED", "INFERENCE_ROUTE_BLOCKED"]);

  const onDevice = planRequest({
    context: { type: "user", id: users.member.id },
    source: incidentSource,
    reviewers: [guidancePin],
    profileRevisionId: memberProfile,
    dataRoute: { ...defaultDataRoute, inference: "on-device" },
    resultSharing: "local-only",
  });
  const allowedOnDevice = await preview(fx, member, onDevice);
  assert.equal(allowedOnDevice.effectivePolicy.status, "allowed", JSON.stringify(allowedOnDevice.effectivePolicy.blockers));
  assert.deepEqual(allowedOnDevice.effectivePolicy.requiredReviewers.map((item: { slug: string }) => item.slug), ["model-guidance-reviewer"]);
  assert.equal(allowedOnDevice.effectivePolicy.localConsent, "required");

  // P6: designated reviewers, required reviewers, and cycles.
  const wrongReviewer = await preview(fx, member, { ...onDevice, reviewers: [compatPin] });
  assert.deepEqual(blockerCodes(wrongReviewer), ["REQUIRED_REVIEWER_MISSING", "REVIEWER_NOT_ALLOWED"]);
  const cycle = await preview(fx, member, { ...onDevice, reviewers: [guidancePin, pin("incident-summary", subject.artifactSha256, ["analyze"])] });
  assert.ok(blockerCodes(cycle).includes("REVIEWER_CYCLE"));
  const localCycle = await preview(fx, member, { ...onDevice,
    source: { kind: "local", treeSha256: subject.artifactSha256, parent: null },
    candidate: { maxCandidates: 1, identity: { slug: guidancePin.slug, version: "1.1.0", visibility: "public", derivativeOf: null } },
  });
  assert.ok(blockerCodes(localCycle).includes("REVIEWER_CYCLE"));

  // P7: one selected team only; child teams inherit the parent organization.
  const docsContext = await preview(fx, orgOwner, planRequest({ context: { type: "team", id: docsTeamId }, source: helperSource, reviewers: [guidancePin], profileRevisionId: ownerProfile }));
  assert.deepEqual(blockerCodes(docsContext), ["REQUIRED_REVIEWER_MISSING"]);
  assert.deepEqual(constraintSummary(docsContext), [`team:${docsTeamId}:run-context`]);
  const docsAllowed = await preview(fx, orgOwner, planRequest({ context: { type: "team", id: docsTeamId }, source: helperSource, reviewers: [compatPin, guidancePin], profileRevisionId: ownerProfile }));
  assert.equal(docsAllowed.effectivePolicy.status, "allowed", JSON.stringify(docsAllowed.effectivePolicy.blockers));
  const childContext = await preview(fx, orgOwner, planRequest({ context: { type: "team", id: childTeamId }, source: helperSource, reviewers: [guidancePin], profileRevisionId: ownerProfile }));
  assert.deepEqual(blockerCodes(childContext), ["DISCLOSURE_NOT_ALLOWED", "INFERENCE_ROUTE_BLOCKED"]);
  assert.deepEqual(constraintSummary(childContext), [
    `organization:${orgId}:parent-organization`,
    `team:${childTeamId}:run-context`,
  ]);

  // P2: disabled organization policy blocks its context.
  journal.check("disable org policy", await call(fx.app, "PUT", orgPolicyUrl, orgOwner, { policy: { ...orgPolicy, enabled: false }, expectedRevisionNumber: 1 }), 201);
  const disabled = await preview(fx, member, planRequest({ context: { type: "organization", id: orgId }, source: helperSource, reviewers: [guidancePin], profileRevisionId: memberProfile, dataRoute: { ...defaultDataRoute, inference: "on-device" }, resultSharing: "local-only" }));
  assert.ok(blockerCodes(disabled).includes("POLICY_DISABLED"));

  // P8: pinned digests must match; blocked creation is denied and audited.
  const wrongSource = await preview(fx, member, planRequest({ context: { type: "user", id: users.member.id }, source: { ...helperSource, artifactSha256: "e".repeat(64) }, reviewers: [guidancePin], profileRevisionId: memberProfile }));
  assert.deepEqual(blockerCodes(wrongSource), ["SOURCE_UNAVAILABLE"]);
  const denied = journal.check("blocked plan creation", await call(fx.app, "POST", "/v1/improvements/plans", member, {
    request: planRequest({ context: { type: "user", id: users.member.id }, source: incidentSource, reviewers: [guidancePin], profileRevisionId: memberProfile }),
    idempotencyKey: "blocked-plan-0001",
  }), 409, "IMPROVEMENT_POLICY_BLOCKED");
  assert.ok(body(denied).error.details.blockers.some((item: { code: string }) => item.code === "INFERENCE_ROUTE_BLOCKED"));
  const denyAudit = fx.improvementStore.auditEvents().find((event) => event.action === "improvement.plan.create" && event.decision === "deny");
  assert.ok(denyAudit, "blocked plan creation must write a deny audit");

  // P9: tokens need the matching scope.
  const readToken = await fx.createToken(member, ["improvements:read"]);
  journal.check("read token cannot preview", await call(fx.app, "POST", "/v1/improvements/plans/preview", readToken, { request: onDevice }), 403, "API_TOKEN_SCOPE_REQUIRED");
  journal.check("read token can read policy", await call(fx.app, "GET", orgPolicyUrl, readToken), 200);

  journal.write("memory");
});

test("a member completes a local improvement run and a release manager accepts the exact evidence", async (t) => {
  const fx = await createJourneyFixture();
  t.after(() => fx.app.close());
  const journal = recorder("lifecycle");
  const author = await fx.login(users.author, { mfa: true });
  const reviewerAuthor = await fx.login(users.reviewerAuthor);
  const member = await fx.login(users.member, { mfa: true });
  const outsider = await fx.login(users.outsider, { mfa: true });

  const source = await fx.submit(author, { name: "release-notes-helper", version: "1.0.0", readme: "Summarize release notes." });
  const targetRevision = body(journal.check("declare baseline target", await call(fx.app, "POST", "/v1/improvements/releases/release-notes-helper/1.0.0/declarations", author, { declaration: declarationV1, expectedRevisionNumber: 0 }), 201)).revision;
  journal.check("approve baseline target", await call(fx.app, "POST", `/v1/improvements/releases/release-notes-helper/1.0.0/declarations/${targetRevision.id}/review`, fx.maintainerToken, {
    decision: "approve", artifactSha256: source.artifactSha256, declarationSha256: targetRevision.declarationSha256,
  }), 200);
  await fx.approveAndPublish(source.submissionId);
  const guidance = await fx.publish(reviewerAuthor, { name: "model-guidance-reviewer", version: "1.0.0", readme: "Review against model guidance." });
  const guidancePin = pin("model-guidance-reviewer", guidance.artifactSha256, ["analyze", "propose"]);
  const candidatePackage = packageFiles("release-notes-helper", "1.1.0", "public", "Summarize release notes. Keep the heading contract.");
  const candidateTree = improvementTreeSha256(candidatePackage.files);

  const runnerToken = await fx.createToken(member, ["improvements:read", "improvements:configure", "improvements:run", "improvements:report"]);
  const profile = journal.check("create profile", await call(fx.app, "POST", "/v1/improvements/profiles", runnerToken, {
    owner: { type: "user", id: users.member.id }, profile: profileBody, reason: "GPT-5.5 target.",
  }), 201);
  const profileId = body(profile).profile.id as string;
  const profileRevisionId = body(profile).profile.latest.id as string;
  const suite = journal.check("create suite", await call(fx.app, "POST", "/v1/improvements/suites", runnerToken, {
    owner: { type: "user", id: users.member.id }, suite: suiteBody,
  }), 201);
  const suiteRevisionId = body(suite).suite.latest.id as string;
  journal.check("outsider cannot read profile", await call(fx.app, "GET", `/v1/improvements/profiles/${profileId}`, outsider), 404, "IMPROVEMENT_NOT_FOUND");

  const request = planRequest({
    context: { type: "user", id: users.member.id },
    source: { kind: "release", slug: "release-notes-helper", version: "1.0.0", artifactSha256: source.artifactSha256 },
    reviewers: [guidancePin],
    profileRevisionId,
    suiteRevisionId,
    guidance: [{ publisher: "openai", url: GUIDANCE_URL, retrievedAt: "2026-09-26T00:00:00.000Z", sha256: "f".repeat(64) }],
    candidate: { maxCandidates: 1, identity: { slug: "release-notes-helper", version: "1.1.0", visibility: "public", derivativeOf: null } },
  });
  const previewed = await preview(fx, runnerToken, request);
  assert.equal(previewed.effectivePolicy.status, "allowed", JSON.stringify(previewed.effectivePolicy.blockers));
  assert.equal(previewed.plan.localExecution.consent, "required-local");
  assert.equal(previewed.plan.suite.suiteSha256, suiteBody.contentSha256);

  // R1: idempotent plan creation.
  const created = journal.check("create plan", await call(fx.app, "POST", "/v1/improvements/plans", runnerToken, { request, idempotencyKey: "plan-journey-0001" }), 201);
  const plan = body(created).plan;
  // The created plan binds its own id and expiry; its digest is recomputable from the returned plan.
  assert.equal(plan.planSha256, improvementPlanDigest(plan.plan));
  assert.deepEqual(plan.plan.reviewers.map((item: { slug: string }) => item.slug), ["model-guidance-reviewer"]);
  assert.equal(plan.plan.source.artifactSha256, source.artifactSha256);
  const replayed = journal.check("replay plan", await call(fx.app, "POST", "/v1/improvements/plans", runnerToken, { request, idempotencyKey: "plan-journey-0001" }), 200);
  assert.equal(body(replayed).plan.id, plan.id);
  journal.check("idempotency key reuse", await call(fx.app, "POST", "/v1/improvements/plans", runnerToken, {
    request: { ...request, expiresInMinutes: 90 }, idempotencyKey: "plan-journey-0001",
  }), 409, "IMPROVEMENT_IDEMPOTENCY_CONFLICT");
  journal.check("outsider cannot read plan", await call(fx.app, "GET", `/v1/improvements/plans/${plan.id}`, outsider), 404, "IMPROVEMENT_NOT_FOUND");

  // R2: run creation binds the exact plan and declared controls.
  const runsUrl = `/v1/improvements/plans/${plan.id}/runs`;
  journal.check("altered plan digest", await call(fx.app, "POST", runsUrl, runnerToken, { planSha256: "0".repeat(64), idempotencyKey: "run-journey-0001", runner: codexRunner }), 422, "IMPROVEMENT_BINDING_MISMATCH");
  journal.check("outsider cannot run plan", await call(fx.app, "POST", runsUrl, outsider, { planSha256: plan.planSha256, idempotencyKey: "run-journey-0001", runner: codexRunner }), 404, "IMPROVEMENT_NOT_FOUND");
  const missingControl = journal.check("missing workspace control", await call(fx.app, "POST", runsUrl, runnerToken, {
    planSha256: plan.planSha256, idempotencyKey: "run-journey-0001", runner: { ...codexRunner, capabilities: { ...codexRunner.capabilities, workspaceIsolation: false } },
  }), 422, "IMPROVEMENT_RUNNER_CAPABILITY_MISSING");
  assert.deepEqual(body(missingControl).error.details.missing, ["workspaceIsolation"]);
  journal.check("forged provenance on run", await call(fx.app, "POST", runsUrl, runnerToken, {
    planSha256: plan.planSha256, idempotencyKey: "run-journey-0001", runner: { ...codexRunner, provenance: "trusted-runner" },
  }), 400, "INVALID_IMPROVEMENT_REQUEST");
  const runCreated = journal.check("create run", await call(fx.app, "POST", runsUrl, runnerToken, { planSha256: plan.planSha256, idempotencyKey: "run-journey-0001", runner: codexRunner }), 201);
  const run = body(runCreated).run;
  assert.equal(run.state, "running");
  assert.equal(run.attempt, 1);
  assert.equal(run.provenance, "local-report");
  assert.equal(run.guarantees.some((item: { enforcedBy: string }) => item.enforcedBy === "host-isolation"), false);
  // R3: one active attempt.
  journal.check("second active attempt", await call(fx.app, "POST", runsUrl, runnerToken, { planSha256: plan.planSha256, idempotencyKey: "run-journey-0002", runner: codexRunner }), 409, "IMPROVEMENT_RUN_ACTIVE");

  const send = (sequence: number, event: Record<string, unknown>) => call(fx.app, "POST", `/v1/improvements/runs/${run.id}/events`, runnerToken, { planSha256: plan.planSha256, sequence, event });
  // R4: sequencing and stage order.
  journal.check("analyze started", await send(1, { type: "stage.started", stage: "analyze" }), 201);
  const replayEvent = journal.check("replay event", await send(1, { type: "stage.started", stage: "analyze" }), 200);
  assert.equal(body(replayEvent).replayed, true);
  journal.check("conflicting replay", await send(1, { type: "stage.started", stage: "propose" }), 409, "IMPROVEMENT_EVENT_SEQUENCE_CONFLICT");
  journal.check("sequence gap", await send(3, { type: "stage.completed", stage: "analyze", findingCount: 2 }), 409, "IMPROVEMENT_EVENT_SEQUENCE_CONFLICT");
  journal.check("stage order", await send(2, { type: "stage.started", stage: "propose" }), 409, "IMPROVEMENT_EVENT_INVALID_TRANSITION");
  journal.check("analyze completed", await send(2, { type: "stage.completed", stage: "analyze", findingCount: 2 }), 201);
  journal.check("propose started", await send(3, { type: "stage.started", stage: "propose" }), 201);
  // R5: candidates are validated and identity-bound before evaluation.
  const frozen = {
    type: "candidate.frozen",
    treeSha256: candidateTree,
    fileCount: candidatePackage.files.length,
    identity: { slug: "release-notes-helper", version: "1.1.0", visibility: "public", derivativeOf: null },
    validation: { packageValid: true, scanBlocking: false, protectedDiffClean: true },
  };
  journal.check("unsafe candidate", await send(4, { ...frozen, validation: { packageValid: true, scanBlocking: true, protectedDiffClean: true } }), 422, "IMPROVEMENT_CANDIDATE_UNSAFE");
  journal.check("protected diff changed", await send(4, { ...frozen, validation: { packageValid: true, scanBlocking: false, protectedDiffClean: false } }), 422, "IMPROVEMENT_CANDIDATE_UNSAFE");
  journal.check("identity mismatch", await send(4, { ...frozen, identity: { ...frozen.identity, version: "9.9.9" } }), 422, "IMPROVEMENT_BINDING_MISMATCH");
  journal.check("candidate equals source", await send(4, { ...frozen, treeSha256: source.artifactSha256 }), 422, "IMPROVEMENT_BINDING_MISMATCH");
  journal.check("candidate frozen", await send(4, frozen), 201);
  journal.check("second candidate", await send(5, { ...frozen, treeSha256: "a".repeat(64) }), 409, "IMPROVEMENT_EVENT_INVALID_TRANSITION");
  journal.check("propose completed", await send(5, { type: "stage.completed", stage: "propose", findingCount: 0 }), 201);
  journal.check("evaluate started", await send(6, { type: "stage.started", stage: "evaluate" }), 201);
  // R6: evaluation observations bind to the plan suite and runner declarations.
  const baselineEval = {
    type: "evaluation.recorded",
    subject: "baseline",
    treeSha256: source.artifactSha256,
    suiteSha256: suiteBody.contentSha256,
    observedModel: null,
    cases: { total: 12, passed: 8, failed: 4, errored: 0 },
    protectedCases: { total: 3, failed: 0 },
    holdoutCases: { total: 4, passed: 2 },
    repetitions: 3,
  };
  journal.check("suite digest mismatch", await send(7, { ...baselineEval, suiteSha256: "9".repeat(64) }), 422, "IMPROVEMENT_BINDING_MISMATCH");
  journal.check("case count mismatch", await send(7, { ...baselineEval, cases: { total: 10, passed: 8, failed: 2, errored: 0 } }), 422, "IMPROVEMENT_BINDING_MISMATCH");
  journal.check("unattested model identity", await send(7, { ...baselineEval, observedModel: { provider: "openai", id: "gpt-5.5" } }), 422, "IMPROVEMENT_RUNNER_CAPABILITY_MISSING");
  journal.check("forged evaluation score", await send(7, { ...baselineEval, score: 0.97 }), 400, "INVALID_IMPROVEMENT_REQUEST");
  journal.check("baseline recorded", await send(7, baselineEval), 201);
  journal.check("candidate tree mismatch", await send(8, { ...baselineEval, subject: "candidate", treeSha256: "b".repeat(64) }), 422, "IMPROVEMENT_BINDING_MISMATCH");
  journal.check("candidate recorded", await send(8, {
    ...baselineEval, subject: "candidate", treeSha256: candidateTree,
    cases: { total: 12, passed: 11, failed: 1, errored: 0 }, holdoutCases: { total: 4, passed: 4 },
  }), 201);
  journal.check("complete during evaluate", await send(9, { type: "run.completed", report: report("candidate", guidancePin) }), 409, "IMPROVEMENT_EVENT_INVALID_TRANSITION");
  journal.check("evaluate completed", await send(9, { type: "stage.completed", stage: "evaluate", findingCount: 0 }), 201);
  // R7: reports cannot carry scores, provenance, or unknown reviewers.
  journal.check("forged report score", await send(10, { type: "run.completed", report: { ...report("candidate", guidancePin), score: 0.99 } }), 400, "INVALID_IMPROVEMENT_REQUEST");
  journal.check("forged report provenance", await send(10, { type: "run.completed", report: { ...report("candidate", guidancePin), provenance: "independently-reproduced" } }), 400, "INVALID_IMPROVEMENT_REQUEST");
  const foreignReviewer = report("candidate", { slug: "unplanned-reviewer", version: "1.0.0" });
  journal.check("unplanned reviewer finding", await send(10, { type: "run.completed", report: foreignReviewer }), 422, "IMPROVEMENT_BINDING_MISMATCH");
  const completed = journal.check("run completed", await send(10, { type: "run.completed", report: report("candidate", guidancePin) }), 201);
  const completedRun = body(completed).run;
  assert.equal(completedRun.state, "completed");
  assert.equal(completedRun.terminalReason, "completed");
  assert.equal(completedRun.candidate.treeSha256, candidateTree);
  journal.check("event after completion", await send(11, { type: "stage.started", stage: "analyze" }), 409, "IMPROVEMENT_RUN_TERMINAL");
  journal.check("new attempt after completion", await call(fx.app, "POST", runsUrl, runnerToken, { planSha256: plan.planSha256, idempotencyKey: "run-journey-0003", runner: codexRunner }), 409, "IMPROVEMENT_PLAN_COMPLETED");

  // E1/E2: evidence sharing respects disclosure and exact byte binding.
  const evidenceUrl = `/v1/improvements/runs/${run.id}/evidence`;
  const baselineProposal = { subject: "baseline", slug: "release-notes-helper", version: "1.0.0" };
  const candidateProposal = { subject: "candidate", slug: "release-notes-helper", version: "1.1.0" };
  journal.check("disclosure above plan", await call(fx.app, "POST", evidenceUrl, runnerToken, {
    reportSha256: completedRun.reportSha256, disclosure: "selected-evidence", proposals: [baselineProposal], idempotencyKey: "evidence-journey-0001",
  }), 422, "IMPROVEMENT_DISCLOSURE_NOT_ALLOWED");
  journal.check("report digest mismatch", await call(fx.app, "POST", evidenceUrl, runnerToken, {
    reportSha256: "0".repeat(64), disclosure: "summary", proposals: [baselineProposal], idempotencyKey: "evidence-journey-0001",
  }), 422, "IMPROVEMENT_BINDING_MISMATCH");
  journal.check("candidate proposed to different bytes", await call(fx.app, "POST", evidenceUrl, runnerToken, {
    reportSha256: completedRun.reportSha256, disclosure: "summary", proposals: [{ ...candidateProposal, version: "1.0.0" }], idempotencyKey: "evidence-journey-0001",
  }), 422, "IMPROVEMENT_BINDING_MISMATCH");

  // The author adopts the exact tested tree through the normal submission and review path.
  const adopted = await fx.publish(author, { name: "release-notes-helper", version: "1.1.0", readme: "Summarize release notes. Keep the heading contract." });
  assert.equal(adopted.artifactSha256, candidateTree, "tested tree digest must equal the submitted artifact digest");

  const shared = journal.check("share evidence", await call(fx.app, "POST", evidenceUrl, runnerToken, {
    reportSha256: completedRun.reportSha256, disclosure: "summary", proposals: [baselineProposal, candidateProposal], idempotencyKey: "evidence-journey-0001",
  }), 201);
  const evidence = body(shared).evidence;
  assert.equal(evidence.provenance, "local-report");
  assert.equal(JSON.stringify(evidence).includes(FINDING_TEXT), false, "summary disclosure must not include finding text");
  const sharedReplay = journal.check("replay evidence", await call(fx.app, "POST", evidenceUrl, runnerToken, {
    reportSha256: completedRun.reportSha256, disclosure: "summary", proposals: [baselineProposal, candidateProposal], idempotencyKey: "evidence-journey-0001",
  }), 200);
  assert.equal(body(sharedReplay).evidence.id, evidence.id);

  // E3: nothing appears until the release manager accepts the exact digest.
  const unaccepted = body(await call(fx.app, "GET", compatUrl("release-notes-helper", "1.1.0"))).compatibility;
  assert.deepEqual(unaccepted.evidence, []);
  const managerView = body(await call(fx.app, "GET", compatUrl("release-notes-helper", "1.1.0"), author)).compatibility;
  assert.deepEqual(managerView.manage.evidenceProposals.map((item: { evidenceId: string }) => item.evidenceId), [evidence.id]);
  journal.check("outsider cannot read evidence", await call(fx.app, "GET", `/v1/improvements/evidence/${evidence.id}`, outsider), 404, "IMPROVEMENT_NOT_FOUND");
  journal.check("manager reads proposed evidence", await call(fx.app, "GET", `/v1/improvements/evidence/${evidence.id}`, author), 200);
  const acceptUrl = `/v1/improvements/evidence/${evidence.id}/acceptances`;
  journal.check("non-manager acceptance", await call(fx.app, "POST", acceptUrl, outsider, {
    ...candidateProposal, evidenceSha256: evidence.evidenceSha256, decision: "accept",
  }), 403, "IMPROVEMENT_RELEASE_MANAGER_REQUIRED");
  journal.check("reporter cannot self-accept", await call(fx.app, "POST", acceptUrl, member, {
    ...candidateProposal, evidenceSha256: evidence.evidenceSha256, decision: "accept",
  }), 403, "IMPROVEMENT_RELEASE_MANAGER_REQUIRED");
  journal.check("wrong evidence digest", await call(fx.app, "POST", acceptUrl, author, {
    ...candidateProposal, evidenceSha256: "0".repeat(64), decision: "accept",
  }), 422, "IMPROVEMENT_BINDING_MISMATCH");
  journal.check("accept candidate evidence", await call(fx.app, "POST", acceptUrl, author, {
    ...candidateProposal, evidenceSha256: evidence.evidenceSha256, decision: "accept", reason: "Reviewed the holdout comparison.",
  }), 201);
  journal.check("accept baseline evidence", await call(fx.app, "POST", acceptUrl, author, {
    ...baselineProposal, evidenceSha256: evidence.evidenceSha256, decision: "accept",
  }), 201);
  journal.check("duplicate acceptance", await call(fx.app, "POST", acceptUrl, author, {
    ...candidateProposal, evidenceSha256: evidence.evidenceSha256, decision: "accept",
  }), 409, "IMPROVEMENT_EVIDENCE_REVIEWED");

  // E4: accepted local reports never become measured improvement.
  const accepted = body(await call(fx.app, "GET", compatUrl("release-notes-helper", "1.1.0"))).compatibility;
  assert.equal(accepted.evidence.length, 1);
  const candidateEvidence = accepted.evidence[0];
  assert.equal(candidateEvidence.subject, "candidate");
  assert.equal(candidateEvidence.provenance, "local-report");
  assert.equal(candidateEvidence.relevance, "current");
  assert.equal(candidateEvidence.claim, "locally-reported-improvement");
  for (const condition of ["provenance-below-policy-minimum", "provenance-below-measured-floor", "model-identity-unverified"]) {
    assert.ok(candidateEvidence.unmetConditions.includes(condition), condition);
  }
  assert.equal(candidateEvidence.unmetConditions.includes("evidence-not-accepted"), false);
  assert.equal(candidateEvidence.unmetConditions.includes("independent-evaluator-missing"), false, "deterministic grading needs no evaluator skill");
  const baselineCompat = body(await call(fx.app, "GET", compatUrl("release-notes-helper", "1.0.0"))).compatibility;
  assert.equal(baselineCompat.evidence[0].claim, "tested-baseline");
  assert.equal(baselineCompat.declaration.targets[0].status, "tested");
  journal.note("accepted claims", { candidate: candidateEvidence.claim, baseline: baselineCompat.evidence[0].claim, unmet: [...candidateEvidence.unmetConditions].sort() });

  // E5: a later profile revision makes the evidence stale.
  journal.check("revise profile", await call(fx.app, "PUT", `/v1/improvements/profiles/${profileId}`, runnerToken, {
    profile: { ...profileBody, settings: { reasoningEffort: "medium" } }, expectedRevisionNumber: 1,
  }), 201);
  const stale = body(await call(fx.app, "GET", compatUrl("release-notes-helper", "1.1.0"))).compatibility.evidence[0];
  assert.equal(stale.relevance, "stale");
  assert.ok(stale.unmetConditions.includes("evidence-stale"));
  const staleBaseline = body(await call(fx.app, "GET", compatUrl("release-notes-helper", "1.0.0"))).compatibility;
  assert.equal(staleBaseline.declaration.targets[0].status, "designed-for-untested");

  // E6: audits carry identifiers and codes only.
  const audits = JSON.stringify(fx.improvementStore.auditEvents());
  assert.equal(audits.includes(FINDING_TEXT), false);
  assert.equal(audits.includes(GUIDANCE_URL), false);
  for (const action of ["improvement.plan.create", "improvement.run.create", "improvement.run.event", "improvement.evidence.share", "improvement.evidence.accept"]) {
    assert.ok(fx.improvementStore.auditEvents().some((event) => event.action === action && event.decision === "allow"), action);
  }

  journal.write("memory");
});

test("cancellation, revocation, stale policy, expiry, and no-change outcomes stay bounded", async (t) => {
  const fx = await createJourneyFixture();
  t.after(() => fx.app.close());
  const journal = recorder("recovery");
  const author = await fx.login(users.author);
  const reviewerAuthor = await fx.login(users.reviewerAuthor);
  const member = await fx.login(users.member, { mfa: true });

  const source = await fx.publish(author, { name: "release-notes-helper", version: "1.0.0", readme: "Summarize release notes." });
  const guidance = await fx.publish(reviewerAuthor, { name: "model-guidance-reviewer", version: "1.0.0", readme: "Review against model guidance." });
  const compat = await fx.publish(reviewerAuthor, { name: "app-compat-reviewer", version: "1.0.0", readme: "Review app compatibility." });
  const guidancePin = pin("model-guidance-reviewer", guidance.artifactSha256, ["analyze", "propose"]);
  const compatPin = pin("app-compat-reviewer", compat.artifactSha256, ["analyze"]);
  const profileRevisionId = await fx.createProfile(member, { type: "user", id: users.member.id });
  const sourceRef = { kind: "release", slug: "release-notes-helper", version: "1.0.0", artifactSha256: source.artifactSha256 };
  const base = { context: { type: "user", id: users.member.id }, source: sourceRef, profileRevisionId };

  // R8: cancellation is terminal and idempotent.
  const planA = await fx.createPlan(member, planRequest({ ...base, reviewers: [guidancePin] }), "plan-recovery-0001");
  const runA1 = await fx.createRun(member, planA, "run-recovery-0001");
  const sendA1 = (sequence: number, event: Record<string, unknown>) => call(fx.app, "POST", `/v1/improvements/runs/${runA1.id}/events`, member, { planSha256: planA.planSha256, sequence, event });
  journal.check("analyze started", await sendA1(1, { type: "stage.started", stage: "analyze" }), 201);
  const cancelled = journal.check("cancel run", await call(fx.app, "POST", `/v1/improvements/runs/${runA1.id}/cancel`, member, { reason: "Operator stopped the job." }), 200);
  assert.equal(body(cancelled).run.state, "cancelled");
  assert.equal(body(cancelled).run.cancellation, "requested-unconfirmed");
  journal.check("cancel replay", await call(fx.app, "POST", `/v1/improvements/runs/${runA1.id}/cancel`, member, {}), 200);
  journal.check("late stage completion", await sendA1(2, { type: "stage.completed", stage: "analyze", findingCount: 1 }), 409, "IMPROVEMENT_RUN_TERMINAL");
  journal.check("late run completion", await sendA1(2, { type: "run.completed", report: report("no-change", guidancePin, []) }), 409, "IMPROVEMENT_RUN_TERMINAL");
  const afterLate = body(await call(fx.app, "GET", `/v1/improvements/runs/${runA1.id}`, member));
  assert.equal(afterLate.run.state, "cancelled");
  assert.equal(afterLate.events.length, 1);

  // R9: a revoked reviewer blocks the next stage and fails the run.
  const runA2 = await fx.createRun(member, planA, "run-recovery-0002");
  assert.equal(runA2.attempt, 2);
  const sendA2 = (sequence: number, event: Record<string, unknown>) => call(fx.app, "POST", `/v1/improvements/runs/${runA2.id}/events`, member, { planSha256: planA.planSha256, sequence, event });
  journal.check("attempt two analyze", await sendA2(1, { type: "stage.started", stage: "analyze" }), 201);
  journal.check("revoke reviewer release", await call(fx.app, "POST", "/v1/skills/model-guidance-reviewer/releases/1.0.0/actions", fx.maintainerToken, {
    action: "revoke", reason: "Reviewer package withdrawn.",
  }), 200);
  journal.check("attempt two analyze completed", await sendA2(2, { type: "stage.completed", stage: "analyze", findingCount: 1 }), 201);
  journal.check("revoked reviewer blocks next stage", await sendA2(3, { type: "stage.started", stage: "propose" }), 409, "IMPROVEMENT_AUTHORIZATION_REVOKED");
  const failed = body(await call(fx.app, "GET", `/v1/improvements/runs/${runA2.id}`, member)).run;
  assert.equal(failed.state, "failed");
  assert.equal(failed.terminalReason, "authorization_revoked");
  journal.check("attempts exhausted", await call(fx.app, "POST", `/v1/improvements/plans/${planA.id}/runs`, member, {
    planSha256: planA.planSha256, idempotencyKey: "run-recovery-0003", runner: codexRunner,
  }), 409, "IMPROVEMENT_ATTEMPTS_EXHAUSTED");
  const revokedPreview = await preview(fx, member, planRequest({ ...base, reviewers: [guidancePin] }));
  assert.deepEqual(blockerCodes(revokedPreview), ["REVIEWER_UNAVAILABLE"]);

  // R9: a policy revision after planning makes the plan stale.
  const planB = await fx.createPlan(member, planRequest({ ...base, reviewers: [compatPin] }), "plan-recovery-0002");
  journal.check("member policy after plan", await call(fx.app, "PUT", `/v1/improvements/policies/user/${users.member.id}`, member, {
    policy: { schemaVersion: 1, enabled: true, maxDisclosure: "local-only" }, expectedRevisionNumber: 0,
  }), 201);
  journal.check("stale plan", await call(fx.app, "POST", `/v1/improvements/plans/${planB.id}/runs`, member, {
    planSha256: planB.planSha256, idempotencyKey: "run-recovery-0004", runner: codexRunner,
  }), 409, "IMPROVEMENT_PLAN_STALE");

  // R10: plan expiry.
  const planC = await fx.createPlan(member, planRequest({ ...base, reviewers: [compatPin], resultSharing: "local-only", expiresInMinutes: 5 }), "plan-recovery-0003");
  const runC = await fx.createRun(member, planC, "run-recovery-0005");
  const sendC = (sequence: number, event: Record<string, unknown>) => call(fx.app, "POST", `/v1/improvements/runs/${runC.id}/events`, member, { planSha256: planC.planSha256, sequence, event });
  journal.check("expiring run started", await sendC(1, { type: "stage.started", stage: "analyze" }), 201);
  fx.advanceClock(10 * 60_000);
  journal.check("event after expiry", await sendC(2, { type: "stage.completed", stage: "analyze", findingCount: 0 }), 409, "IMPROVEMENT_PLAN_EXPIRED");
  assert.equal(body(await call(fx.app, "GET", `/v1/improvements/runs/${runC.id}`, member)).run.state, "expired");
  journal.check("new run on expired plan", await call(fx.app, "POST", `/v1/improvements/plans/${planC.id}/runs`, member, {
    planSha256: planC.planSha256, idempotencyKey: "run-recovery-0006", runner: codexRunner,
  }), 409, "IMPROVEMENT_PLAN_EXPIRED");

  // AC-14: analysis-only plans end with a valid no-change result; local-only results stay local.
  const planD = await fx.createPlan(member, planRequest({ ...base, reviewers: [compatPin], resultSharing: "local-only" }), "plan-recovery-0004");
  const runD = await fx.createRun(member, planD, "run-recovery-0007", { ...codexRunner, adapter: "claude-code", adapterVersion: "2.1.0" });
  const sendD = (sequence: number, event: Record<string, unknown>) => call(fx.app, "POST", `/v1/improvements/runs/${runD.id}/events`, member, { planSha256: planD.planSha256, sequence, event });
  journal.check("no-change analyze", await sendD(1, { type: "stage.started", stage: "analyze" }), 201);
  journal.check("no-change analyze completed", await sendD(2, { type: "stage.completed", stage: "analyze", findingCount: 0 }), 201);
  journal.check("analysis-only cannot freeze", await sendD(3, {
    type: "candidate.frozen", treeSha256: "a".repeat(64), fileCount: 2,
    identity: { slug: "release-notes-helper", version: "1.1.0", visibility: "public", derivativeOf: null },
    validation: { packageValid: true, scanBlocking: false, protectedDiffClean: true },
  }), 409, "IMPROVEMENT_EVENT_INVALID_TRANSITION");
  journal.check("candidate disposition without candidate", await sendD(3, { type: "run.completed", report: report("candidate", compatPin, []) }), 409, "IMPROVEMENT_EVENT_INVALID_TRANSITION");
  journal.check("local-only report cannot upload findings", await sendD(3, { type: "run.completed", report: report("recommend", compatPin) }), 422, "IMPROVEMENT_DISCLOSURE_NOT_ALLOWED");
  const noChange = journal.check("no-change completed", await sendD(3, { type: "run.completed", report: report("no-change", compatPin, []) }), 201);
  assert.equal(body(noChange).run.report.disposition, "no-change");
  journal.check("local-only cannot share", await call(fx.app, "POST", `/v1/improvements/runs/${runD.id}/evidence`, member, {
    reportSha256: body(noChange).run.reportSha256, disclosure: "summary", proposals: [], idempotencyKey: "evidence-recovery-0001",
  }), 422, "IMPROVEMENT_DISCLOSURE_NOT_ALLOWED");

  journal.write("memory");
});

test("local evidence respects destination governance and static findings never mark a declared target tested", async (t) => {
  const fx = await createJourneyFixture();
  t.after(() => fx.app.close());
  const journal = recorder("evidence-governance");
  fx.submissionStore.setSharingSettings({ organizationVisibilityEnabled: true });
  const author = await fx.login(users.author, { mfa: true });
  const orgOwner = await fx.login(users.orgOwner, { mfa: true });
  const reviewerAuthor = await fx.login(users.reviewerAuthor);
  const organization = journal.check("create destination organization", await call(fx.app, "POST", "/v1/organizations", orgOwner, { name: "Evidence owners" }), 201);
  const orgId = body(organization).organization.id as string;
  const submitted = await fx.submit(author, { name: "governed-source", version: "1.0.0", visibility: "organization", readme: "Preserve the output contract." });
  const declaration = journal.check("declare source target", await call(fx.app, "POST", "/v1/improvements/releases/governed-source/1.0.0/declarations", author, {
    declaration: declarationV1, expectedRevisionNumber: 0,
  }), 201);
  const revision = body(declaration).revision;
  journal.check("approve source target", await call(fx.app, "POST", `/v1/improvements/releases/governed-source/1.0.0/declarations/${revision.id}/review`, fx.maintainerToken, {
    decision: "approve", artifactSha256: submitted.artifactSha256, declarationSha256: revision.declarationSha256,
  }), 200);
  await fx.approveAndPublish(submitted.submissionId);
  fx.improvementStore.setSkillGovernance("governed-source", { visibility: "organization", teams: [], organizationIds: [orgId] });
  const helper = await fx.publish(author, { name: "unrelated-public", version: "1.0.0", readme: "Unrelated public source." });
  const reviewer = await fx.publish(reviewerAuthor, { name: "boundary-reviewer", version: "1.0.0", readme: "Analyze instructions." });
  const reviewerPin = pin("boundary-reviewer", reviewer.artifactSha256, ["analyze"]);
  const profileRevisionId = await fx.createProfile(author, { type: "user", id: users.author.id });
  const policyUrl = `/v1/improvements/policies/organization/${orgId}`;
  const proposal = { subject: "baseline", slug: "governed-source", version: "1.0.0" };
  let completed: { id: string; reportSha256: string } | undefined;
  for (const [index, parent] of [null, { slug: "unrelated-public", version: "1.0.0", artifactSha256: helper.artifactSha256 }].entries()) {
    const plan = await fx.createPlan(author, planRequest({
      context: { type: "user", id: users.author.id },
      source: { kind: "local", treeSha256: submitted.artifactSha256, parent },
      reviewers: [reviewerPin], profileRevisionId,
    }), `local-boundary-plan-${index}`);
    const run = await fx.createRun(author, plan, `local-boundary-run-${index}`);
    const send = (sequence: number, event: Record<string, unknown>) => call(fx.app, "POST", `/v1/improvements/runs/${run.id}/events`, author, { planSha256: plan.planSha256, sequence, event });
    journal.check(`analyze start ${index}`, await send(1, { type: "stage.started", stage: "analyze" }), 201);
    journal.check(`analyze finish ${index}`, await send(2, { type: "stage.completed", stage: "analyze", findingCount: 0 }), 201);
    const finished = journal.check(`analysis-only completion ${index}`, await send(3, { type: "run.completed", report: report("no-change", reviewerPin, []) }), 201);
    completed = body(finished).run;
    assert.ok(completed);
    journal.check(`missing destination policy ${index}`, await call(fx.app, "POST", `/v1/improvements/runs/${run.id}/evidence`, author, {
      reportSha256: completed.reportSha256, disclosure: "summary", proposals: [proposal], idempotencyKey: `destination-missing-${index}`,
    }), 422, "IMPROVEMENT_DISCLOSURE_NOT_ALLOWED");
  }
  assert.ok(completed);
  const evidenceUrl = `/v1/improvements/runs/${completed.id}/evidence`;
  const share = (key: string) => call(fx.app, "POST", evidenceUrl, author, {
    reportSha256: completed!.reportSha256, disclosure: "summary", proposals: [proposal], idempotencyKey: key,
  });
  for (const [index, policy] of [
    { schemaVersion: 1, maxDisclosure: "local-only" },
    { schemaVersion: 1, maxDisclosure: "summary", enabled: false },
    { schemaVersion: 1, maxDisclosure: "summary", enabled: true },
  ].entries()) {
    journal.check(`destination policy ${index + 1}`, await call(fx.app, "PUT", policyUrl, orgOwner, { policy, expectedRevisionNumber: index }), 201);
    if (index < 2) journal.check(`destination ceiling ${index + 1}`, await share(`destination-ceiling-${index}`), 422, "IMPROVEMENT_DISCLOSURE_NOT_ALLOWED");
  }
  const shared = body(journal.check("allowed destination sharing", await share("destination-allowed"), 201)).evidence;
  journal.check("accept static evidence", await call(fx.app, "POST", `/v1/improvements/evidence/${shared.id}/acceptances`, author, {
    ...proposal, evidenceSha256: shared.evidenceSha256, decision: "accept",
  }), 201);
  const projection = body(await call(fx.app, "GET", compatUrl("governed-source", "1.0.0"), author)).compatibility;
  assert.equal(projection.evidence[0].claim, "static-findings-only");
  assert.equal(projection.declaration.targets[0].status, "designed-for-untested");
  journal.check("disable operator policy", await call(fx.app, "PUT", `/v1/improvements/policies/user/${users.author.id}`, author, {
    policy: { schemaVersion: 1, enabled: false }, expectedRevisionNumber: 0,
  }), 201);
  journal.check("current policy blocks new sharing", await share("destination-disabled-operator"), 422, "IMPROVEMENT_DISCLOSURE_NOT_ALLOWED");
  journal.check("enable operator policy", await call(fx.app, "PUT", `/v1/improvements/policies/user/${users.author.id}`, author, {
    policy: { schemaVersion: 1, enabled: true }, expectedRevisionNumber: 1,
  }), 201);
  journal.check("revoke reviewer after completion", await call(fx.app, "POST", "/v1/skills/boundary-reviewer/releases/1.0.0/actions", fx.maintainerToken, { action: "revoke", reason: "Reviewer withdrawn." }), 200);
  journal.check("revoked reviewer blocks new sharing", await share("destination-revoked-reviewer"), 422, "IMPROVEMENT_DISCLOSURE_NOT_ALLOWED");
  journal.write("memory");
});

const defaultDataRoute = {
  inference: "cloud",
  provider: "openai",
  model: "gpt-5.5",
  contextCategories: ["subject-package", "reviewer-packages", "profile"],
};

function planRequest(overrides: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    suiteRevisionId: null,
    goals: { objectives: ["task-success"], protectedRequirements: [] },
    guidance: [],
    candidate: { maxCandidates: 1, identity: null },
    budget: { maxModelCalls: 40, maxTokens: null, maxWallMinutes: 60 },
    dataRoute: defaultDataRoute,
    resultSharing: "summary",
    expiresInMinutes: 120,
    ...overrides,
  };
}

function pin(slug: string, artifactSha256: string, roles: string[]) {
  return { slug, version: "1.0.0", artifactSha256, roles };
}

function report(disposition: string, reviewer: { slug: string; version: string }, findings?: unknown[]) {
  return {
    schemaVersion: 1,
    disposition,
    findings: findings ?? [
      { id: "f1", reviewer: { slug: reviewer.slug, version: reviewer.version }, severity: "medium", category: "instructions", summary: FINDING_TEXT, disposition: "addressed" },
      { id: "f2", reviewer: { slug: reviewer.slug, version: reviewer.version }, severity: "low", category: "output", summary: "Consider a stricter heading format.", disposition: "rejected", reason: "Conflicts with the protected output contract." },
    ],
    configurationChanges: [],
    resources: { modelCalls: 18, tokens: null, wallMs: 240000, cost: "unknown" },
  };
}

function compatUrl(slug: string, version: string): string {
  return `/v1/improvements/releases/${slug}/${version}/compatibility`;
}

async function preview(fx: JourneyFixture, token: string, request: Record<string, unknown>) {
  const response = await call(fx.app, "POST", "/v1/improvements/plans/preview", token, { request });
  assert.equal(response.statusCode, 200, response.body);
  return body(response);
}

function blockerCodes(result: { effectivePolicy: { blockers: Array<{ code: string }> } }): string[] {
  return [...new Set(result.effectivePolicy.blockers.map((item) => item.code))].sort();
}

function constraintSummary(result: { effectivePolicy: { constraints: Array<{ source: { type: string; id: string }; reason: string }> } }): string[] {
  return result.effectivePolicy.constraints.map((item) => `${item.source.type}:${item.source.id}:${item.reason}`).sort();
}

function packageFiles(name: string, version: string, visibility: string, readme: string) {
  const manifest = {
    name,
    title: name.split("-").map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" "),
    summary: `${name} journey fixture skill.`,
    version,
    license: "Apache-2.0",
    visibility,
    platforms: [{ name: "codex", install_target: "codex-skill" }],
    tags: ["journey"],
  };
  return {
    manifest,
    files: [
      { path: "skill.json", content: JSON.stringify(manifest) },
      { path: "README.md", content: readme },
    ],
  };
}

type JourneyFixture = Awaited<ReturnType<typeof createJourneyFixture>>;

async function createJourneyFixture() {
  const authStore = new MemoryAuthStore("closed");
  const organizationStore = new MemoryOrganizationStore();
  const teamStore = new MemoryTeamStore({ organizationStore });
  const teamService = new TeamService(teamStore);
  const organizationService = new OrganizationService(organizationStore, teamService);
  // Publication consults the improvement store; declaration writes read the submission store's publication state.
  const submissionStore = new MemorySubmissionStore({
    publicationGuard: { assertReleasePublishable: (release) => improvementStore.assertReleasePublishable(release) },
  });
  const submissionService = new SubmissionService(submissionStore);
  const improvementStore = new MemoryImprovementStore({ releases: submissionStore });
  let clock = Date.parse("2026-09-26T00:00:00.000Z");
  let afterNextReleaseRead: (() => Promise<void>) | null = null;
  // The improvement service reads releases through this view, so a journey can interleave work between that read and the store write.
  class InterleavingSubmissionService extends SubmissionService {
    override async getSkillManagement(input: Parameters<SubmissionService["getSkillManagement"]>[0]) {
      const management = await super.getSkillManagement(input);
      const interleave = afterNextReleaseRead;
      afterNextReleaseRead = null;
      if (interleave) await interleave();
      return management;
    }
  }
  const improvementService = new ImprovementService(improvementStore, {
    submissionService: new InterleavingSubmissionService(submissionStore),
    teamService,
    organizationService,
  }, { now: () => new Date(clock) });
  const app = buildApp({
    skillRepository: new MemorySkillRepository([]),
    authService: new AuthService(authStore),
    submissionService,
    teamService,
    organizationService,
    improvementService,
  });
  for (const user of Object.values(users)) {
    authStore.addUser({
      id: user.id,
      email: user.email,
      name: user.name,
      status: "active",
      emailVerifiedAt: new Date(),
      roles: user.roles,
      passwordHash: await hashPassword(PASSWORD),
    });
    organizationStore.addKnownUser(user);
    teamStore.addKnownUser(user);
  }
  const sessions = new Map<string, string>();
  const login = async (user: TestUser, options: { mfa?: boolean } = {}) => {
    const cached = sessions.get(user.id);
    if (cached) return cached;
    const token = options.mfa ? await loginWithMfa(app, user) : await loginPassword(app, user);
    sessions.set(user.id, token);
    return token;
  };
  const maintainerToken = await login(users.maintainer, { mfa: true });

  const reviewArtifactSha = async (submissionId: string) => {
    const preview = await call(app, "GET", `/v1/review/submissions/${submissionId}/bundle?platform=codex`, maintainerToken);
    assert.equal(preview.statusCode, 200, preview.body);
    return sha256(preview.body);
  };
  const submit = async (token: string, input: { name: string; version: string; visibility?: string; readme: string }) => {
    const pkg = packageFiles(input.name, input.version, input.visibility ?? "public", input.readme);
    const submitted = await call(app, "POST", "/v1/submissions", token, { release: releaseMetadata, manifest: pkg.manifest, files: pkg.files });
    assert.equal(submitted.statusCode, 202, submitted.body);
    const submissionId = submitted.json().submission.id as string;
    return { submissionId, artifactSha256: await reviewArtifactSha(submissionId), files: pkg.files };
  };
  const approve = async (submissionId: string) => {
    const artifactSha256 = await reviewArtifactSha(submissionId);
    const approved = await call(app, "POST", `/v1/review/submissions/${submissionId}/actions`, maintainerToken, { action: "approve", artifactSha256 });
    assert.equal(approved.statusCode, 200, approved.body);
  };
  const publishAttempt = (submissionId: string) => call(app, "POST", `/v1/review/submissions/${submissionId}/actions`, maintainerToken, { action: "publish" });
  const approveAndPublish = async (submissionId: string) => {
    await approve(submissionId);
    const published = await publishAttempt(submissionId);
    assert.equal(published.statusCode, 200, published.body);
  };
  const publish = async (token: string, input: { name: string; version: string; visibility?: string; readme: string }) => {
    const submitted = await submit(token, input);
    await approveAndPublish(submitted.submissionId);
    return submitted;
  };
  const createProfile = async (token: string, owner: { type: string; id: string }) => {
    const response = await call(app, "POST", "/v1/improvements/profiles", token, { owner, profile: profileBody });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().profile.latest.id as string;
  };
  const createToken = async (session: string, scopes: string[]) => {
    const response = await call(app, "POST", "/v1/auth/api-tokens", session, { name: `Improvement ${scopes.length}`, scopes });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().token.token as string;
  };
  const createPlan = async (token: string, request: Record<string, unknown>, idempotencyKey: string) => {
    const response = await call(app, "POST", "/v1/improvements/plans", token, { request, idempotencyKey });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().plan as { id: string; planSha256: string };
  };
  const createRun = async (token: string, plan: { id: string; planSha256: string }, idempotencyKey: string, runner: typeof codexRunner = codexRunner) => {
    const response = await call(app, "POST", `/v1/improvements/plans/${plan.id}/runs`, token, { planSha256: plan.planSha256, idempotencyKey, runner });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().run as { id: string; attempt: number };
  };
  return {
    app,
    submissionStore,
    improvementStore,
    maintainerToken,
    login,
    submit,
    approve,
    publishAttempt,
    approveAndPublish,
    publish,
    createProfile,
    createToken,
    createPlan,
    createRun,
    advanceClock: (ms: number) => { clock += ms; },
    afterNextReleaseRead: (work: () => Promise<void>) => { afterNextReleaseRead = work; },
  };
}

async function loginPassword(app: JourneyApp, user: TestUser): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: PASSWORD } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().token as string;
}

async function loginWithMfa(app: JourneyApp, user: TestUser): Promise<string> {
  const setup = await loginPassword(app, user);
  const enrollment = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/enroll",
    headers: { authorization: `Bearer ${setup}` },
    payload: { password: PASSWORD },
  });
  assert.equal(enrollment.statusCode, 201, enrollment.body);
  const confirm = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/confirm",
    headers: { authorization: `Bearer ${setup}` },
    payload: { factorId: enrollment.json().enrollment.factorId, code: generateTotpCode(enrollment.json().enrollment.secret) },
  });
  assert.equal(confirm.statusCode, 200, confirm.body);
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    payload: { challengeToken: login.json().challengeToken, recoveryCode: confirm.json().mfa.recoveryCodes[0] },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return verify.json().token as string;
}

function call(app: JourneyApp, method: "GET" | "POST" | "PUT", url: string, token?: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

// Response bodies are JSON; the journeys assert their shape explicitly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function body(response: ResponseLike): any {
  return response.json();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Records deterministic, sanitized journey steps (status and error codes only) as repeatable JSON evidence. */
function recorder(journey: string) {
  const steps: Array<Record<string, unknown>> = [];
  return {
    check<T extends ResponseLike>(step: string, response: T, status: number, code?: string): T {
      assert.equal(response.statusCode, status, `${journey}/${step}: ${response.body}`);
      if (code) {
        const error = (response.json() as { error?: { code?: string } }).error;
        assert.equal(error?.code, code, `${journey}/${step}: ${response.body}`);
      }
      steps.push({ step, status, ...(code ? { code } : {}) });
      return response;
    },
    note(step: string, value: unknown) {
      steps.push({ step, value });
    },
    write(backend: "memory" | "postgres") {
      const directory = process.env.MYSKILLS_JOURNEY_EVIDENCE_DIR ?? join(tmpdir(), "myskills-journey-evidence");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, `skill-improvement-${journey}.${backend}.json`),
        `${JSON.stringify({ schemaVersion: 1, journey, backend, steps }, null, 2)}\n`,
      );
    },
  };
}
