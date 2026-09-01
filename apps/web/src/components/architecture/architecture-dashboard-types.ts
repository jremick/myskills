import type { ArchitecturePattern, ArchitecturePatternId } from "../../api.js";

export interface WebSessionLike {
  user: {
    email: string;
  };
}

export type ArchitectureLoadState = "loading" | "ready" | "error" | "unsupported";

export type OrganizationChoice = {
  id: string;
  name: string;
  slug: string;
};

export interface ArchitectureRevisionSummaryLike {
  revision?: number;
  revisionNumber?: number;
  version?: string;
}

export const BUILTIN_PATTERNS: ArchitecturePattern[] = [
  {
    id: "flat" as ArchitecturePatternId,
    name: "Flat library",
    description: "Expose a curated set of skills from one predictable entry point.",
    supportsNestedRouters: false,
    status: "available",
  },
  {
    id: "domain-router" as ArchitecturePatternId,
    name: "Domain router",
    description: "Route requests through domain-specific branches before selecting a leaf skill.",
    supportsNestedRouters: false,
    status: "available",
  },
  {
    id: "multi-level-router" as ArchitecturePatternId,
    name: "Multi-level router",
    description: "Compose router, sub-router, and leaf skills for larger skill libraries.",
    supportsNestedRouters: true,
    status: "available",
  },
];
