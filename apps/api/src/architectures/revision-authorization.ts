import type {
  ArchitectureOwnerReference,
  ArchitectureRevisionAuthorizationSnapshot,
  ArchitectureSpec,
  CreateArchitectureRevisionInput,
} from "./types.js";

export type ArchitectureRevisionAuthorizationIntentDecisionCode =
  | "snapshot_missing"
  | "snapshot_conflict"
  | "snapshot_release_mismatch";

export type ArchitectureRevisionAuthorizationIntentDecision =
  | { readonly allowed: true; readonly code: "snapshot_valid" | "snapshot_not_required" }
  | { readonly allowed: false; readonly code: ArchitectureRevisionAuthorizationIntentDecisionCode };

/**
 * Build the server-owned intent passed from the exact registry preflight to a
 * revision store. The caller supplies only data obtained from an authorized
 * registry lookup; the returned object is deeply immutable and canonicalized
 * for deterministic transaction checks.
 */
export function freezeArchitectureRevisionAuthorizationSnapshot(
  input: ArchitectureRevisionAuthorizationSnapshot,
): ArchitectureRevisionAuthorizationSnapshot {
  const owner = Object.freeze({ type: input.owner.type, id: input.owner.id });
  const organizationIds = Object.freeze(uniqueSorted(input.organizationIds));
  const releases = Object.freeze(input.releases
    .map((release) => Object.freeze({
      id: release.id,
      slug: release.slug,
      version: release.version,
      digest: release.digest,
      packageVisibility: release.packageVisibility,
    }))
    .sort((left, right) => left.id.localeCompare(right.id)));
  return Object.freeze({
    actorId: input.actorId,
    architectureId: input.architectureId,
    owner,
    organizationIds,
    releases,
  });
}

/**
 * Compare a preflight intent with the server-authoritative revision request.
 * This is deliberately pure: the Postgres adapter performs the database
 * recheck after this identity binding succeeds.
 */
export function evaluateArchitectureRevisionAuthorizationIntent(
  input: Pick<CreateArchitectureRevisionInput, "actor" | "architectureId" | "spec" | "authorizationSnapshot"> & {
    actorId: string;
    owner: ArchitectureOwnerReference;
    spec: ArchitectureSpec;
  },
): ArchitectureRevisionAuthorizationIntentDecision {
  const snapshot = input.authorizationSnapshot;
  if (!snapshot) return { allowed: true, code: "snapshot_not_required" };
  if (
    snapshot.actorId !== input.actorId
    || snapshot.architectureId !== input.architectureId
    || snapshot.owner.type !== input.owner.type
    || snapshot.owner.id !== input.owner.id
  ) {
    return { allowed: false, code: "snapshot_conflict" };
  }

  const references = new Map(input.spec.skills.map((skill) => [skill.id, skill]));
  if (references.size !== input.spec.skills.length || snapshot.releases.length !== input.spec.skills.length) {
    return { allowed: false, code: "snapshot_release_mismatch" };
  }
  for (const release of snapshot.releases) {
    const reference = references.get(release.id);
    if (!reference || !sameRelease(reference, release)) {
      return { allowed: false, code: "snapshot_release_mismatch" };
    }
  }
  return { allowed: true, code: "snapshot_valid" };
}

function sameRelease(
  reference: ArchitectureSpec["skills"][number],
  release: ArchitectureRevisionAuthorizationSnapshot["releases"][number],
): boolean {
  return reference.slug === release.slug
    && reference.version === release.version
    && reference.digest === release.digest
    && reference.packageVisibility === release.packageVisibility;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
