import type { ArchitectureSkillRef } from "@myskills-app/core";

/**
 * The registry visibility values accepted by architecture references. Keep
 * this vocabulary separate from runtime exposure and from organization grant
 * policy: the latter may allow only a subset of these values.
 */
export const patternMigrationReleaseVisibilities = [
  "public",
  "authenticated",
  "organization",
  "team",
  "private",
  "explicit-users",
] as const;

export type PatternMigrationReleaseVisibility = (typeof patternMigrationReleaseVisibilities)[number];

export type PatternMigrationReleaseDecisionCode =
  | "exact_release_match"
  | "release_visibility_not_allowed"
  | "release_not_visible";

export interface PatternMigrationReleaseCandidate {
  readonly slug: string;
  readonly version: string;
  readonly digest: string;
}

export type PatternMigrationReleaseDecision =
  | { readonly allowed: true; readonly code: "exact_release_match" }
  | { readonly allowed: false; readonly code: Exclude<PatternMigrationReleaseDecisionCode, "exact_release_match"> };

export interface EvaluatePatternMigrationReleaseInput {
  readonly reference: Pick<ArchitectureSkillRef, "slug" | "version" | "digest" | "packageVisibility">;
  /** Visibility returned by the scoped registry lookup, when one was found. */
  readonly resolvedVisibility?: string | null;
  /** Exact release metadata returned by the release lookup, when found. */
  readonly release?: PatternMigrationReleaseCandidate | null;
  /** Whether the server-derived scope authorized the resolved skill. */
  readonly authorized: boolean;
  /** A disabled instance visibility gate is a failed exact-release decision. */
  readonly visibilityEnabled?: boolean;
  /** Optional narrower vocabulary, for example organization grants. */
  readonly allowedVisibilities?: readonly string[];
  /** Organization grant paths require the registry visibility to match exactly. */
  readonly requireVisibilityMatch?: boolean;
  /** Preserve the existing resolver guard against organization visibility widening. */
  readonly rejectOrganizationVisibilityWidening?: boolean;
}

/**
 * Evaluate the pure, provider-independent part of an exact release check.
 * Repository/provider adapters remain responsible for obtaining the values;
 * this function only combines those values into one bounded decision shape.
 */
export function evaluatePatternMigrationRelease(
  input: EvaluatePatternMigrationReleaseInput,
): PatternMigrationReleaseDecision {
  if (input.allowedVisibilities && !input.allowedVisibilities.includes(input.reference.packageVisibility)) {
    return { allowed: false, code: "release_visibility_not_allowed" };
  }

  const exactRelease = input.release;
  const identityMatches = Boolean(
    exactRelease
    && exactRelease.slug === input.reference.slug
    && exactRelease.version === input.reference.version
    && exactRelease.digest === input.reference.digest,
  );
  if (!input.authorized || !identityMatches || !input.resolvedVisibility) {
    return { allowed: false, code: "release_not_visible" };
  }

  if (input.requireVisibilityMatch !== false && input.resolvedVisibility !== input.reference.packageVisibility) {
    return { allowed: false, code: "release_not_visible" };
  }
  if (
    input.rejectOrganizationVisibilityWidening !== false
    && input.resolvedVisibility === "organization"
    && input.reference.packageVisibility !== "organization"
  ) {
    return { allowed: false, code: "release_not_visible" };
  }
  if (input.visibilityEnabled === false) {
    return { allowed: false, code: "release_not_visible" };
  }
  return { allowed: true, code: "exact_release_match" };
}
