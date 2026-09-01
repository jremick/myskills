import test from "node:test";
import assert from "node:assert/strict";
import {
  AppError,
  assertNever,
  reviewStatuses,
  securityStatuses,
  skillAccessReasons,
  skillLifecycleStatuses,
  visibilityScopes,
  type PublicSkill,
} from "../src/index.js";

test("exports stable skill contract value sets", () => {
  assert.deepEqual(skillLifecycleStatuses, [
    "draft",
    "private",
    "submitted",
    "review",
    "approved",
    "deprecated",
    "unpublished",
    "revoked",
    "archived",
  ]);
  assert.deepEqual(reviewStatuses, ["unreviewed", "changes-requested", "approved", "rejected"]);
  assert.deepEqual(securityStatuses, ["not-run", "passed", "warning", "failed"]);
  assert.deepEqual(visibilityScopes, ["public", "authenticated", "organization", "team", "private", "explicit-users"]);
  assert.deepEqual(skillAccessReasons, ["public", "authenticated", "owner", "team", "explicit-user", "organization"]);
});

test("public skill contract carries release and sharing metadata", () => {
  const skill: PublicSkill = {
    slug: "release-notes-helper",
    title: "Release Notes Helper",
    summary: "Turns merged changes into concise release notes.",
    lifecycleStatus: "approved",
    visibility: "team",
    latestVersion: "0.1.0",
    reviewStatus: "approved",
    securityStatus: "passed",
    platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }],
    tags: ["release"],
    access: {
      canManageSharing: false,
      reasons: ["team"],
    },
  };

  assert.equal(skill.latestVersion, "0.1.0");
  assert.equal(skill.access?.canManageSharing, false);
  assert.deepEqual(skill.access?.reasons, ["team"]);
});

test("AppError and assertNever preserve API error metadata", () => {
  const error = new AppError("Owner access is required.", "OWNER_ROLE_REQUIRED", 403, { role: "owner" });

  assert.equal(error.message, "Owner access is required.");
  assert.equal(error.code, "OWNER_ROLE_REQUIRED");
  assert.equal(error.statusCode, 403);
  assert.deepEqual(error.details, { role: "owner" });
  assert.throws(() => assertNever("unexpected" as never), /Unhandled value: unexpected/);
});
