import type { PublicSkill } from "./index.js";

export const taskDiscoveryLimits = { taskCharacters: 4_000, taskTerms: 64, catalogEntries: 500, results: 20 } as const;

export interface TaskDiscoveryInput { task: string; limit?: number }
export interface TaskDiscoveryResult {
  skill: PublicSkill;
  release: { slug: string; version: string; sha256: string; reviewStatus: "approved"; securityStatus: "passed" };
  /** Word overlap only. This score is not a probability or a trust assessment. */
  relevance: { score: number; matchedTerms: string[]; label: "strong-word-overlap" | "partial-word-overlap" | "limited-word-overlap" };
}
export interface TaskDiscoveryResponse {
  schemaVersion: 1;
  method: "lexical-v1";
  fallback: "ordinary-search-available";
  provider: { status: "disabled"; reason: "provider-not-configured"; calls: 0; reportedCost: 0 };
  catalog: { limit: 500; truncated: boolean };
  taskTermsTruncated: boolean;
  uncertainty: string[];
  results: TaskDiscoveryResult[];
}
