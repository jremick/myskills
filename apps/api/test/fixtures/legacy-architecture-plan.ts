import { architectureSyncOrderedDigest, architectureSyncPlanDigest, architectureSyncStepIdempotencyKey } from "@myskills-app/core";
import type { ArchitectureSyncCreateRunStoreInput } from "../../src/architecture-sync/types.js";

/** Exact097 creation representation: generated step-N IDs precede both digests.
 * Seed through the real store, never rewrite an already persisted journal. */
export function legacyArchitecturePlanCreation(input: ArchitectureSyncCreateRunStoreInput): ArchitectureSyncCreateRunStoreInput {
  const original = structuredClone(input.run);
  const placeholders = original.steps.map((step, index) => ({ ...step, id: `step-${index + 1}`, idempotencyKey: "pending" }));
  const planDigest = architectureSyncPlanDigest(placeholders);
  const run = { ...original, digests: { ...original.digests, planDigest }, steps: placeholders.map(step => ({ ...step, idempotencyKey: architectureSyncStepIdempotencyKey({ identity: original.identity, planDigest, step }) })) };
  const metadata = { ...run.metadata };
  delete metadata.reviewDigest;
  run.metadata = { ...metadata, reviewDigest: architectureSyncOrderedDigest({ identity: run.identity, digests: { desiredDigest: run.digests.desiredDigest, compiledDigest: run.digests.compiledDigest, observedDigest: run.digests.observedDigest, planDigest }, steps: run.steps.map(({ state: _state, ...step }) => step), capabilities: run.capabilities, metadata }) };
  return { ...input, run, intentDigest: architectureSyncOrderedDigest({ identity: run.identity, digests: run.digests, steps: run.steps, capabilities: run.capabilities, metadata: run.metadata }) };
}
