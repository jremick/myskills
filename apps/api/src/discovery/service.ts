import { AppError, taskDiscoveryLimits, type PublicSkill, type SkillRepository, type TaskDiscoveryInput, type TaskDiscoveryResponse, type TaskDiscoveryResult } from "@myskills-app/core";
import type { PublicReleaseMetadata } from "../submissions/types.js";

interface DiscoveryOptions {
  repository: SkillRepository;
  readRelease(input: { slug: string; version: string; actorId: string | null }): Promise<PublicReleaseMetadata | null>;
  /** Resolve the live credential each time; never downgrade a revoked token to anonymous. */
  readActor(): Promise<string | null>;
}

const stopWords = new Set("a an and are as at be been but by can could do for from have help i in into is it me my of on or our please should that the their them there these they this to us use using want was we were will with would you your".split(" "));
const uncertainty = "Word overlap does not establish quality, trust, permission to execute or task success. It does not understand intent, negation or synonyms.";

function words(value: string): string[] {
  return [...new Set((value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(term => term.length > 1 && !stopWords.has(term)))];
}

function eligible(skill: PublicSkill | null): skill is PublicSkill & { latestVersion: string } {
  return Boolean(skill && skill.lifecycleStatus === "approved" && skill.reviewStatus === "approved" && skill.securityStatus === "passed" && skill.latestVersion);
}

function relevance(skill: PublicSkill, terms: string[]): TaskDiscoveryResult["relevance"] {
  const title = new Set(words(`${skill.slug} ${skill.title}`));
  const tags = new Set(words(skill.tags.slice(0, 32).map(t => t.slice(0, 100)).join(" ")));
  const summary = new Set(words(skill.summary.slice(0, 4_000)));
  const matchedTerms = terms.filter(t => title.has(t) || tags.has(t) || summary.has(t));
  const weight = terms.reduce((sum, t) => sum + (title.has(t) ? 3 : tags.has(t) ? 2 : summary.has(t) ? 1 : 0), 0);
  const coverage = matchedTerms.length / terms.length;
  return { score: Math.round(weight / (terms.length * 3) * 10_000) / 10_000, matchedTerms, label: coverage >= 0.6 ? "strong-word-overlap" : coverage >= 0.25 ? "partial-word-overlap" : "limited-word-overlap" };
}

function safeMetadata(skill: PublicSkill): PublicSkill {
  // Explicit projection prevents accidental transport of repository-only fields.
  return { slug: skill.slug, title: skill.title.slice(0, 200), summary: skill.summary.slice(0, 4_000), lifecycleStatus: skill.lifecycleStatus, visibility: skill.visibility, latestVersion: skill.latestVersion, reviewStatus: skill.reviewStatus, securityStatus: skill.securityStatus, tags: skill.tags.slice(0, 32).map(t => t.slice(0, 100)), platforms: skill.platforms.slice(0, 20).map(p => ({ name: p.name.slice(0, 100), installTarget: p.installTarget.slice(0, 100), status: p.status })) };
}

export async function discoverTask(input: TaskDiscoveryInput, options: DiscoveryOptions): Promise<TaskDiscoveryResponse> {
  if (typeof input.task !== "string" || !input.task.trim() || input.task.length > taskDiscoveryLimits.taskCharacters || !Number.isInteger(input.limit ?? 10) || (input.limit ?? 10) < 1 || (input.limit ?? 10) > taskDiscoveryLimits.results) {
    throw new AppError("Use a task of 1–4,000 characters and a limit of 1–20.", "INVALID_TASK_DISCOVERY_INPUT", 400);
  }
  const actorId = await options.readActor();
  const allTerms = words(input.task);
  const terms = allTerms.slice(0, taskDiscoveryLimits.taskTerms);
  const response: TaskDiscoveryResponse = { schemaVersion: 1, method: "lexical-v1", fallback: "ordinary-search-available", provider: { status: "disabled", reason: "provider-not-configured", calls: 0, reportedCost: 0 }, catalog: { limit: 500, truncated: false }, taskTermsTruncated: allTerms.length > taskDiscoveryLimits.taskTerms, uncertainty: [uncertainty], results: [] };
  if (response.taskTermsTruncated) response.uncertainty.push("Only the first 64 distinct task terms were evaluated.");
  if (!terms.length) return response;
  // API-owned visibility/lifecycle filtering precedes ranking. No package body,
  // credentials, task cache, provider call, activation or local execution exists.
  const catalog = await options.repository.searchVisibleSkills({ actorId, limit: taskDiscoveryLimits.catalogEntries + 1 });
  response.catalog.truncated = catalog.length > taskDiscoveryLimits.catalogEntries;
  if (response.catalog.truncated) response.uncertainty.push("Catalog limit reached: only the first 500 authorized entries in slug order were evaluated. Ordinary search can reach other entries.");
  const ranked = catalog.slice(0, taskDiscoveryLimits.catalogEntries).filter(eligible).map(skill => ({ skill, relevance: relevance(skill, terms) })).filter(r => r.relevance.score > 0).sort((a, b) => b.relevance.score - a.relevance.score || (a.skill.slug < b.skill.slug ? -1 : a.skill.slug > b.skill.slug ? 1 : 0)).slice(0, input.limit ?? 10);
  // Each result is bound to the release selected during authorized catalog read.
  // Re-read both current visibility and that exact release before returning it.
  const current = await Promise.all(ranked.map(async candidate => {
    const [skill, release] = await Promise.all([
      options.repository.getVisibleSkillBySlug(candidate.skill.slug, actorId),
      options.readRelease({ slug: candidate.skill.slug, version: candidate.skill.latestVersion, actorId }),
    ]);
    if (!eligible(skill) || skill.latestVersion !== candidate.skill.latestVersion || !release || release.slug !== skill.slug || release.version !== candidate.skill.latestVersion || release.lifecycleStatus !== "approved" || release.reviewStatus !== "approved" || release.securityStatus !== "passed" || !/^[a-f0-9]{64}$/i.test(release.artifact.sha256)) return null;
    const score = relevance(skill, terms);
    if (!score.score) return null;
    return { skill: safeMetadata(skill), release: { slug: release.slug, version: release.version, sha256: release.artifact.sha256, reviewStatus: "approved", securityStatus: "passed" }, relevance: score } satisfies TaskDiscoveryResult;
  }));
  if (await options.readActor() !== actorId) throw new AppError("Authentication is required.", "AUTHENTICATION_REQUIRED", 401);
  response.results = current.filter((r): r is NonNullable<typeof r> => r !== null).sort((a, b) => b.relevance.score - a.relevance.score || (a.skill.slug < b.skill.slug ? -1 : a.skill.slug > b.skill.slug ? 1 : 0));
  if (response.results.length < ranked.length) response.uncertainty.push("Some matches changed or became unavailable during discovery. Run the task again for current results.");
  return response;
}
