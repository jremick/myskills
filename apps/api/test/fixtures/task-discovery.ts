import { hashSessionToken } from "@myskills-app/auth";
import { parseSkillManifest } from "@myskills-app/skill-package";
import type { PublicSkill } from "@myskills-app/core";
import { buildApp } from "../../src/app.js";
import { AuthService } from "../../src/auth/service.js";
import { MemoryAuthStore } from "../../src/auth/memory-auth-store.js";
import { MemorySkillRepository } from "../../src/repositories/memory-skill-repository.js";
import { MemorySubmissionStore } from "../../src/submissions/memory-submission-store.js";
import { SubmissionService } from "../../src/submissions/service.js";

// Fixed, synthetic relevance judgments recorded before ranking implementation.
// A result is relevant only when its documented job satisfies the task.
export const taskCases = [
  { id: "release", task: "Write release notes for merged changes and explain upgrade risks", relevant: ["release-notes"] },
  { id: "review", task: "Review code for correctness and concurrency races", relevant: ["code-review"] },
  { id: "incident", task: "Prepare an incident timeline and recovery report", relevant: ["incident-report", "team-incident"] },
  { id: "meeting", task: "Turn meeting notes into decisions and action items", relevant: ["meeting-notes", "private-notes"] },
  { id: "docs", task: "Explain API endpoints in developer documentation", relevant: ["api-docs"] },
  { id: "ambiguous", task: "Review release documentation", relevant: ["code-review", "release-notes", "api-docs"] },
  { id: "no-match", task: "Calibrate a telescope for exoplanet photometry", relevant: [] },
  { id: "empty-terms", task: "Please help me with this", relevant: [] },
] as const;

export const discoveryCorpus = [
  ["release-notes", "Release notes", "Write concise release notes from merged changes, upgrade risks and decisions.", "public"],
  ["code-review", "Code review", "Review code correctness, concurrency races and regression risks.", "public"],
  ["incident-report", "Incident report", "Prepare an incident timeline, recovery actions and report.", "public"],
  ["meeting-notes", "Meeting notes", "Turn meeting notes into decisions and action items.", "public"],
  ["api-docs", "API documentation", "Explain API endpoints in developer documentation.", "public"],
  ["team-incident", "Team incident", "Prepare a detailed incident timeline and recovery report.", "team"],
  ["private-notes", "Private meeting notes", "Turn meeting notes into decisions and action items.", "private"],
  ["hidden-review", "Secret code review", "Review code correctness, concurrency races and regression risks.", "private"],
] as const;

export async function discoveryFixture() {
  const authStore = new MemoryAuthStore("closed");
  const token = "synthetic-discovery-reader-session";
  authStore.addUser({ id: "reader", email: "reader@example.test", name: "Reader", status: "active", roles: ["user"], emailVerifiedAt: new Date() });
  await authStore.createSession({ userId: "reader", tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60_000), mfaVerifiedAt: null });
  const submissionStore = new MemorySubmissionStore({
    teams: [{ id: "discovery-team" }],
    teamMemberships: [{ userId: "reader", teamId: "discovery-team" }],
    teamGrants: [{ slug: "team-incident", teamId: "discovery-team" }],
  });
  const submissions = new SubmissionService(submissionStore);
  const rows: Array<PublicSkill & { ownerUserId: string }> = [];
  for (const [slug, title, summary, visibility] of discoveryCorpus) {
    const owner = slug === "private-notes" ? "reader" : "author";
    const manifest = parseSkillManifest({ name: slug, title, summary, visibility, version: "1.0.0", license: "Apache-2.0", tags: [], platforms: [{ name: "codex", install_target: "codex-skill", status: "supported" }] });
    const submission = await submissions.createSubmission({ actor: { id: owner, roles: ["author"] }, manifest, files: [{ path: "skill.json", content: JSON.stringify(manifest) }, { path: "SKILL.md", content: `# ${title}\n\n${summary}\n` }] });
    const actor = { id: "reviewer", roles: ["maintainer" as const], mfaVerified: true };
    await submissions.performReviewAction({ actor, submissionId: submission.id, action: "approve", artifactSha256: submission.artifact.sha256 });
    await submissions.performReviewAction({ actor, submissionId: submission.id, action: "publish" });
    rows.push({ slug, title, summary, visibility, latestVersion: "1.0.0", lifecycleStatus: "approved", reviewStatus: "approved", securityStatus: "passed", platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }], tags: [], ownerUserId: owner });
  }
  rows.push({ ...rows[0]!, slug: "archived-release", lifecycleStatus: "archived" }, { ...rows[0]!, slug: "unsafe-release", securityStatus: "failed" });
  const repository = new MemorySkillRepository(rows);
  repository.addTeam({ id: "discovery-team" });
  repository.addTeamMembership("reader", { id: "discovery-team", name: "Discovery team", role: "member" });
  repository.addTeamGrant("team-incident", "discovery-team");
  const authService = new AuthService(authStore);
  const app = buildApp({ skillRepository: repository, submissionService: submissions, authService });
  const request = (task: string, authenticated = true, extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/v1/skills/discover", headers: authenticated ? { authorization: `Bearer ${token}` } : {}, payload: { task, limit: 3, ...extra } });
  return { app, repository, rows, authStore, authService, submissionStore, submissions, request, token };
}
