import type { PublicSkill } from "./index.js";

/** A discovery relationship. It never grants access, pins a release or installs skills. */
export type BundleKind = "curated" | "source";
export type BundleVisibility = "public" | "authenticated" | "team" | "private";
export type RegistryView = "grouped" | "list" | "outline";
export interface BundleMembership {
  id: string;
  name: string;
  kind: BundleKind;
}
export interface BundleSummary extends BundleMembership {
  purpose: string;
  visibility: BundleVisibility;
  revision: number;
  owner: { type: "user" | "team"; id: string; name: string };
  source: {
    entryId: string;
    repositoryId: string;
    fullName: string;
    path: string;
  } | null;
  memberCount: number;
  preview: Array<{ slug: string }>;
  canEdit: boolean;
  /** Only disclosed to current curators. Counts always describe visible members. */
  partial: boolean;
  match: "bundle" | "members" | "all";
  updatedAt: string;
}
export interface BundleInput {
  kind: BundleKind;
  name: string;
  purpose: string;
  owner: { type: "user" } | { type: "team"; id: string };
  visibility: BundleVisibility;
  memberSlugs: string[];
  sourceEntryId?: string;
}
export interface BundleMember {
  skill: PublicSkill;
  memberships: BundleMembership[];
}
export type RegistryCatalogRow =
  | { kind: "bundle"; bundle: BundleSummary }
  | ({ kind: "skill"; match?: "skill" | "bundle" } & BundleMember);
export interface RegistryCatalog {
  rows: RegistryCatalogRow[];
  totalSkills: number;
  totalBundles: number;
  nextCursor: string | null;
  snapshot: string;
}
export interface BundleMembersPage {
  skills: BundleMember[];
  total: number;
  nextCursor: string | null;
  match: BundleSummary["match"];
}
export interface BundlePageInput {
  query?: string;
  cursor?: string;
  limit?: number;
}
export interface BundleSourceSelection {
  entryId: string;
  title: string;
  repositoryId: string;
  path: string;
  skills: PublicSkill[];
}
export interface LibraryBundleReference {
  id: string;
  revisionSaved: number;
  revision: number | null;
  state: "available" | "unavailable";
  memberCount: number | null;
}
