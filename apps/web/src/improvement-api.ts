export interface ImprovementScope { type: "user" | "team" | "organization"; id: string }
export interface OptimizationTarget {
  id: string;
  models?: { provider: string; id: string }[];
  apps?: { id: string; version?: string }[];
  environment?: { os?: string[]; requiredCapabilities?: string[]; network?: string };
}
export interface OptimizationDeclaration {
  schemaVersion: 1;
  intent: "unspecified" | "portable" | "targeted";
  targets: OptimizationTarget[];
  objectives: string[];
  limitations: string[];
}
export interface DeclarationRevision {
  id: string;
  revisionNumber: number;
  kind: "declaration" | "attestation";
  declaration: OptimizationDeclaration;
  declarationSha256: string;
  review: { decision: "approve" | "reject" } | null;
}
export interface ImprovementCompatibility {
  schemaVersion: 1;
  declaration: { status: string; revision: DeclarationRevision | null; targets: { target: OptimizationTarget; status: string }[] };
  attestation: { status: string; revision: DeclarationRevision | null };
  evidence: { evidenceId: string; provenance: string; claim: string; relevance: string; acceptedAt: string; profile: { target: { model: { provider: string; id: string }; app: { id: string; version?: string } } } }[];
  manage?: { pendingRevisions: DeclarationRevision[]; evidenceProposals: { evidenceId: string; subject: "baseline" | "candidate"; createdAt: string }[] };
}
export interface ImprovementReviewerPin { slug: string; version: string; artifactSha256: string; roles: string[] }
export interface ImprovementPolicyRevision {
  id: string;
  revisionNumber: number;
  policy: { schemaVersion: 1; enabled: boolean; reviewers: ImprovementReviewerPin[]; reviewerAllowlist?: string; inference?: { routes: string[] | null; providers: string[] | null; models: string[] | null }; limits?: Record<string, number | null>; [key: string]: unknown };
}
export interface ImprovementProfileDocument { id: string; latest: { id: string; revisionNumber: number } }
export interface ImprovementPreview { effectivePolicy: { status: "allowed" | "blocked"; blockers: { code: string; message: string }[]; warnings: { code: string; message: string }[] }; plan: unknown; planSha256: string | null }
export interface ImprovementPlanRecord { id: string; planSha256: string; expiresAt: string }
export interface ImprovementClient {
  compatibility(slug: string, version: string): Promise<ImprovementCompatibility>;
  declare(slug: string, version: string, input: { declaration: OptimizationDeclaration; expectedRevisionNumber: number }): Promise<DeclarationRevision>;
  reviewDeclaration(slug: string, version: string, revisionId: string, input: { decision: "approve" | "reject"; artifactSha256: string; declarationSha256: string }): Promise<void>;
  policy(scope: ImprovementScope): Promise<ImprovementPolicyRevision | null>;
  savePolicy(scope: ImprovementScope, input: { policy: ImprovementPolicyRevision["policy"]; expectedRevisionNumber: number }): Promise<ImprovementPolicyRevision>;
  createProfile(owner: ImprovementScope, profile: Record<string, unknown>): Promise<ImprovementProfileDocument>;
  preview(request: Record<string, unknown>): Promise<ImprovementPreview>;
  createPlan(request: Record<string, unknown>, idempotencyKey: string): Promise<ImprovementPlanRecord>;
  evidence(id: string): Promise<{ evidenceSha256: string; summary: unknown; provenance: string }>;
  acceptEvidence(id: string, input: { slug: string; version: string; subject: string; evidenceSha256: string; decision: "accept" | "reject" }): Promise<void>;
}

export function createImprovementClient(request: <T>(path: string, init?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown }) => Promise<T>): ImprovementClient {
  const release = (slug: string, version: string) => `/v1/improvements/releases/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`;
  const scopePath = (scope: ImprovementScope) => `/v1/improvements/policies/${scope.type}/${encodeURIComponent(scope.id)}`;
  return {
    async compatibility(slug, version) { return (await request<{ compatibility: ImprovementCompatibility }>(`${release(slug, version)}/compatibility`)).compatibility; },
    async declare(slug, version, input) { return (await request<{ revision: DeclarationRevision }>(`${release(slug, version)}/declarations`, { method: "POST", body: input })).revision; },
    async reviewDeclaration(slug, version, id, input) { await request(`${release(slug, version)}/declarations/${encodeURIComponent(id)}/review`, { method: "POST", body: input }); },
    async policy(scope) { return (await request<{ revision: ImprovementPolicyRevision | null }>(scopePath(scope))).revision; },
    async savePolicy(scope, input) { return (await request<{ revision: ImprovementPolicyRevision }>(scopePath(scope), { method: "PUT", body: input })).revision; },
    async createProfile(owner, profile) { return (await request<{ profile: ImprovementProfileDocument }>("/v1/improvements/profiles", { method: "POST", body: { owner, profile } })).profile; },
    async preview(input) { return request<ImprovementPreview>("/v1/improvements/plans/preview", { method: "POST", body: { request: input } }); },
    async createPlan(input, idempotencyKey) { return (await request<{ plan: ImprovementPlanRecord }>("/v1/improvements/plans", { method: "POST", body: { request: input, idempotencyKey } })).plan; },
    async evidence(id) { return (await request<{ evidence: { evidenceSha256: string; summary: unknown; provenance: string } }>(`/v1/improvements/evidence/${encodeURIComponent(id)}`)).evidence; },
    async acceptEvidence(id, input) { await request(`/v1/improvements/evidence/${encodeURIComponent(id)}/acceptances`, { method: "POST", body: input }); },
  };
}
