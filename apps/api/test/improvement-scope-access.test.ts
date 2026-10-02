import assert from "node:assert/strict";
import test from "node:test";
import { resolveImprovementScopeRole, isImprovementScopeWriter } from "../src/improvements/scope-access.js";
import { packageEvaluationSummary, type PackageEvaluationResult } from "@myskills-app/core";

test("suite access requires parent organization membership regardless of external release access", async () => {
  let organizationMember = false;
  const scope = { type: "team" as const, id: "team" };
  const access = { team: async () => ({ role: "owner" as const, organizationId: "organization" }), organization: async () => organizationMember ? "member" as const : null };
  assert.equal(await resolveImprovementScopeRole("external", scope, access), null);
  organizationMember = true;
  const role = await resolveImprovementScopeRole("member", scope, access);
  assert.equal(role, "owner"); assert.equal(isImprovementScopeWriter(scope, role), true);
  organizationMember = false;
  assert.equal(await resolveImprovementScopeRole("revoked", scope, access), null);
  assert.equal(isImprovementScopeWriter({ type: "organization", id: "org" }, "member"), false);
  assert.equal(isImprovementScopeWriter({ type: "organization", id: "org" }, "admin"), true);
  assert.equal(await resolveImprovementScopeRole("outsider", { type: "user", id: "owner" }, access), null);
});

test("public projection excludes all private suite and assertion identities but preserves provider skips", () => {
  const result: PackageEvaluationResult = { schemaVersion: 1, artifactSha256: "a".repeat(64), suiteSha256: "b".repeat(64), target: { platform: "codex", context: "release" }, runner: { id: "package-static", version: "1" }, provenance: "api-owned", status: "skipped", totals: { pass: 3, fail: 0, warning: 0, skipped: 1, incompatible: 0 }, assertions: [{ id: "PRIVATE-ASSERTION-CANARY", kind: "behavior", scope: "provider-behavior", outcome: "skipped", code: "provider_unconfigured" }] };
  const summary = packageEvaluationSummary(result);
  assert.equal(summary.totals.skipped, 1); assert.equal(summary.artifactSha256, result.artifactSha256);
  assert.equal(JSON.stringify(summary).includes(result.suiteSha256), false);
  assert.equal(JSON.stringify(summary).includes("PRIVATE-ASSERTION-CANARY"), false);
  assert.equal("assertions" in summary, false);
});
