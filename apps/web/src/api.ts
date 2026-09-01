import type {
  AccessibleArchitectureOutline,
  ArchitectureTarget,
  ArchitectureTargetAdapterDescriptor,
  ArchitectureTargetCapabilities,
  ArchitectureTargetHealth,
  ArchitectureTargetObservation,
  ArchitectureTargetMetadata,
  ArchitectureTargetOwnerReference,
  ArchitectureDiagramArtifactV1,
  ArchitecturePatternMigrationMapping as CoreArchitecturePatternMigrationMapping,
  ArchitecturePatternMigrationResult as CoreArchitecturePatternMigrationResult,
  OrganizationMembershipRole,
  OrganizationPolicyRevision,
  OrganizationPolicyV1,
  ArchitectureSpecV1,
  ArchitectureSyncPlan as CoreArchitectureSyncPlan,
  CompiledArchitecture,
  ObservedArchitectureState,
  PublicSkill,
  SharingSettings,
  SkillSharingDetails,
  TeamSharedSkillGroup,
  VisibilityScope,
} from "@myskills-app/core";

export interface ReleaseMetadata {
  slug: string;
  title: string;
  summary: string;
  version: string;
  lifecycleStatus: "approved" | "deprecated";
  reviewStatus: "approved";
  securityStatus: "passed";
  publishedAt: string;
  platforms: Array<{ name: string; installTarget: string; status: string }>;
  artifact: {
    sha256: string;
    byteSize: number;
    contentType: string;
  };
}

export interface WebAuthUser {
  id: string;
  email: string;
  name: string;
  status: string;
  roles: string[];
  emailVerified: boolean;
  mfaVerified: boolean;
}

export type AdminRegistrationMode = "closed" | "request" | "open";

export interface AdminRegistrationSettings {
  mode: AdminRegistrationMode;
}

export interface RegistrationInvitation {
  email: string;
  expiresAt: string;
}

export type AdminSharingSettings = SharingSettings;

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  status: "pending" | "active" | "disabled" | "deleted";
  roles: string[];
  emailVerified: boolean;
  mfaEnabled: boolean;
}

export type ApiTokenScope = "profile:read" | "skills:read" | "architectures:read" | "skills:submit" | "review:read" | "review:write";

export interface ApiToken {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: ApiTokenScope[];
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreatedApiToken extends ApiToken {
  token: string;
}

export interface AdminApiToken extends ApiToken {
  user: {
    id: string;
    email: string;
    name: string;
    status: string;
    roles: string[];
  };
}

export interface MfaFactor {
  id: string;
  type: "totp";
  status: "pending" | "enabled" | "disabled";
  label: string;
  enabledAt: string | null;
  createdAt: string;
}

export interface MfaStatus {
  totpEnabled: boolean;
  recoveryCodesRemaining: number;
  factors: MfaFactor[];
}

export interface TotpEnrollment {
  factorId: string;
  label: string;
  secret: string;
  otpauthUrl: string;
}

export interface ConfirmMfaResult {
  factor: MfaFactor;
  recoveryCodes: string[];
}

export interface ProviderRoleMappingInput {
  claim: string;
  value: string;
  role: string;
}

export interface AdminProviderConfig {
  key: string;
  type: "oidc" | "saml" | "cloudflare_access" | "github" | "google";
  displayName: string;
  issuer: string | null;
  clientId: string | null;
  enabled: boolean;
  roleMappings: ProviderRoleMappingInput[];
}

export interface UpsertAdminProviderInput {
  type: AdminProviderConfig["type"];
  displayName: string;
  issuer?: string;
  clientId?: string;
  enabled?: boolean;
  roleMappings?: ProviderRoleMappingInput[];
}

export interface AdminAuditEvent {
  id: string;
  actorUserId: string | null;
  action: string;
  decision: "allow" | "deny";
  resourceType: string;
  resourceId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: "owner" | "member";
}

export interface TeamInvitation {
  id: string;
  teamId: string;
  teamName: string;
  email: string;
  status: "pending" | "accepted" | "revoked";
  createdAt: string;
}

export interface TeamRecord {
  id: string;
  name: string;
  slug: string;
  organizationId?: string | null;
  role: "owner" | "member";
  members: TeamMember[];
  invitations: TeamInvitation[];
  createdAt: string;
  updatedAt: string;
}

export interface TeamDashboard {
  teams: TeamRecord[];
  invitations: TeamInvitation[];
}

/** Organization and target management projections are server-owned. */
export type OrganizationStatus = "provisioning" | "active" | "suspended" | "archived";
export type OrganizationRole = OrganizationMembershipRole;

export interface OrganizationRecord {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  currentPolicyRevisionId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationListItem extends OrganizationRecord {
  role: OrganizationRole;
}

export type OrganizationPolicyRevisionRecord = OrganizationPolicyRevision;

export interface OrganizationDetail extends OrganizationListItem {
  currentPolicy: OrganizationPolicyRevisionRecord | null;
}

export interface OrganizationMembershipRecord {
  id: string;
  organizationId: string;
  userId: string;
  email: string;
  name: string;
  role: OrganizationRole;
  invitedByUserId: string | null;
  removedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type OrganizationInvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface OrganizationInvitationRecord {
  id: string;
  organizationId: string;
  organizationName: string;
  email: string;
  normalizedEmail: string;
  role: OrganizationRole;
  status: OrganizationInvitationStatus;
  invitedByUserId: string | null;
  acceptedByUserId: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationDetailBundle {
  organization: OrganizationDetail;
  members: OrganizationMembershipRecord[];
  invitations: OrganizationInvitationRecord[];
  policies: OrganizationPolicyRevisionRecord[];
  teams: TeamRecord[];
}

export interface ArchitectureTargetRecord extends Omit<ArchitectureTarget, "createdAt" | "updatedAt"> {
  createdAt: string;
  updatedAt: string;
  health: ArchitectureTargetHealth | null;
}

export type ArchitectureTargetObservationRecord = ArchitectureTargetObservation;

/**
 * Architecture contracts intentionally live at the API boundary.  The web
 * client can render the server's compiled projection, but it must not infer
 * grants or compile an architecture locally.
 */
export type ArchitectureScope = "personal" | "work" | "team";
export type ArchitecturePatternId = "flat" | "domain-router" | "multi-level-router" | string;
export type ArchitectureOwnerType = "user" | "team";

export interface ArchitectureOwnerReference {
  type: ArchitectureOwnerType;
  id: string;
}

/**
 * Access is an API decision, not a browser-side policy calculation.  The web
 * app uses canAppend only to decide whether to offer editor write controls.
 */
export interface ArchitectureAccessMetadata {
  owner: ArchitectureOwnerReference;
  ownerType: ArchitectureOwnerType;
  ownerId: string;
  policyVersion: number;
  accessPolicyVersion: number;
  role: "owner" | "member" | "none";
  canList: boolean;
  canRead: boolean;
  canPreview: boolean;
  canCreate: boolean;
  canAppend: boolean;
  canManage: boolean;
  reasons: string[];
  allowedOrganizationIds?: string[];
}

export interface ArchitecturePattern {
  id: ArchitecturePatternId;
  version?: number;
  name: string;
  description: string;
  level?: string;
  supportsNestedRouters?: boolean;
  status?: "available" | "planned" | "unsupported" | string;
}

export interface ArchitectureProfile {
  id: string;
  name: string;
  scope?: ArchitectureScope | string;
  description?: string;
  teamId?: string | null;
  environmentIds?: string[];
}

export interface ArchitectureEnvironment {
  id: string;
  name: string;
  key?: string;
  description?: string;
  profileIds?: string[];
  kind?: ArchitectureScope | string;
  profileId?: string;
}

export interface ArchitectureRevisionSummary {
  id: string;
  architectureId: string;
  revisionNumber: number;
  revision?: number;
  version?: string;
  message?: string;
  patternId?: ArchitecturePatternId;
  createdAt: string;
  nodeCount?: number;
  skillCount?: number;
  status?: "draft" | "published" | "archived" | "conflict" | string;
  spec?: ArchitectureSpecV1;
  createdByUserId?: string;
}

export interface ArchitectureRevisionRecord extends ArchitectureRevisionSummary {
  message: string;
  spec: ArchitectureSpecV1;
  createdByUserId: string;
}

export interface ArchitectureSummary {
  id: string;
  name: string;
  description?: string;
  patternId: ArchitecturePatternId;
  scope?: ArchitectureScope | string;
  ownerName?: string;
  ownerUserId?: string | null;
  ownerTeamId?: string | null;
  owner?: ArchitectureOwnerReference;
  ownerType?: ArchitectureOwnerType;
  ownerId?: string;
  accessPolicyVersion?: number;
  access?: ArchitectureAccessMetadata;
  currentRevisionId?: string | null;
  revisionCount?: number;
  latestRevision?: ArchitectureRevisionSummary | null;
  updatedAt?: string;
  status?: "draft" | "active" | "archived" | "conflict" | string;
}

export interface ArchitectureDetail extends Omit<ArchitectureSummary, "latestRevision"> {
  revisions?: ArchitectureRevisionSummary[];
  latestRevision?: ArchitectureRevisionRecord | null;
}

/** Server-owned architecture grants. The browser only submits a complete set of organization IDs. */
export interface ArchitectureOrganizationGrantRecord {
  architectureId: string;
  organizationId: string;
  accessLevel: "read";
  createdByUserId: string | null;
  createdUnderPolicyRevisionId: string;
  createdAt: string;
}

export interface ArchitectureOrganizationGrantsResult {
  architectureId: string;
  currentRevisionId: string | null;
  grants: ArchitectureOrganizationGrantRecord[];
  organizationIds: string[];
  addedOrganizationIds?: string[];
  removedOrganizationIds?: string[];
  changed?: boolean;
}

export type ArchitecturePatternMigrationMapping = CoreArchitecturePatternMigrationMapping;
export type ArchitecturePatternMigrationResult = CoreArchitecturePatternMigrationResult;

export interface ArchitecturePatternMigrationPreviewResult {
  sourceArchitectureId: string;
  sourceRevisionId: string;
  expectedCurrentRevisionId: string;
  migration: ArchitecturePatternMigrationResult;
}

export interface ArchitecturePatternMigrationPersisted {
  targetArchitecture?: ArchitectureSummary;
  /**
   * The create route returns the redacted revision summary projection. Full
   * specs remain available only through the authorized revision route.
   */
  targetRevision?: ArchitectureRevisionSummary;
  lineage?: {
    targetArchitectureId?: string;
    targetRevisionId?: string;
    targetPatternId?: ArchitecturePatternId;
    sourceArchitectureId?: string;
    sourceRevisionId?: string;
  };
}

export interface ArchitecturePatternMigrationCreateResult extends ArchitecturePatternMigrationPreviewResult {
  created: boolean;
  replayed: boolean;
  persisted?: ArchitecturePatternMigrationPersisted;
}

export interface ArchitectureTopologyNode {
  id: string;
  kind: "router" | "skill" | "group" | string;
  label: string;
  slug?: string;
  title?: string;
  description?: string;
  position?: { x: number; y: number };
  depth?: number;
}

export interface ArchitectureTopologyEdge {
  id?: string;
  from: string;
  to: string;
  relationship?: "contains" | "routes-to" | "selects" | string;
  label?: string;
}

export interface ArchitectureOutlineNode {
  id: string;
  kind: "router" | "skill" | "group" | string;
  label: string;
  depth?: number;
  children?: ArchitectureOutlineNode[];
}

export interface ArchitectureCompiledSkill {
  id?: string;
  slug: string;
  title?: string;
  version?: string;
  digest?: string;
  exposure?: "included" | "excluded" | "conditional" | string;
  reason?: string;
}

export type ArchitectureSyncChangeType =
  | "noop"
  | "install"
  | "update"
  | "register"
  | "change-exposure"
  | "disable"
  | "remove"
  | "move"
  | "conflict"
  | "unsupported"
  | "unknown"
  | string;

export interface ArchitectureSyncChange {
  id?: string;
  type: ArchitectureSyncChangeType;
  subject: string;
  detail?: string;
  severity?: "info" | "warning" | "error" | string;
}

export interface ArchitectureSyncPlan {
  status: "noop" | "changes" | "conflict" | "unsupported" | "unknown" | string;
  target?: string;
  generatedAt?: string;
  changes: ArchitectureSyncChange[];
  warnings?: string[];
  errors?: string[];
  dryRun?: boolean;
  canApply?: boolean;
  requiresApproval?: boolean;
  targetId?: string;
  environmentId?: string;
  architectureId?: string;
  revisionDigest?: string;
  items?: Array<{
    action: ArchitectureSyncChangeType;
    nodeId: string;
    kind?: string;
    skillRefId?: string;
    reason?: string;
    desired?: unknown;
    observed?: unknown;
  }>;
  summary?: Record<string, number>;
}

/**
 * Raw response returned by POST /v1/architectures/:id/preview.
 *
 * This is deliberately an exact API projection. The browser renders the
 * server's compiled result and does not normalize alternate wrappers or
 * compile an architecture locally.
 */
export type ArchitecturePreviewRevision = ArchitectureRevisionRecord;

export type ArchitecturePreviewCompiled = CompiledArchitecture;

export interface ArchitecturePreviewGraph {
  digest: string;
  nodes: Array<{
    id: string;
    kind: "router" | "leaf";
    label: string;
    depth: number;
    x: number;
    y: number;
    skillRefId?: string;
  }>;
  edges: CompiledArchitecture["edges"];
  mermaid: string;
}

export type ArchitecturePreviewOutline = Omit<AccessibleArchitectureOutline, "html">;
export type ArchitecturePreviewPlan = CoreArchitectureSyncPlan;
export type ArchitectureObservedFixture = ObservedArchitectureState;

export interface ArchitecturePreview {
  /** Omitted when an organization-only reader receives a safe projection. */
  revision?: ArchitecturePreviewRevision;
  compiled: ArchitecturePreviewCompiled;
  graph: ArchitecturePreviewGraph;
  outline: ArchitecturePreviewOutline;
  diagram: ArchitectureDiagramArtifactV1;
  plan?: ArchitecturePreviewPlan;
}

/** Raw response returned by POST /v1/architectures/:id/draft-preview. */
export interface ArchitectureDraftPreview {
  draft: {
    expectedCurrentRevisionId: string | null;
    spec: ArchitectureSpecV1;
  };
  compiled: ArchitecturePreviewCompiled;
  graph: ArchitecturePreviewGraph;
  outline: ArchitecturePreviewOutline;
  diagram: ArchitectureDiagramArtifactV1;
  plan?: ArchitecturePreviewPlan;
}

export interface ArchitectureWorkspace {
  patterns: ArchitecturePattern[];
  architectures: ArchitectureSummary[];
  profiles: ArchitectureProfile[];
  environments: ArchitectureEnvironment[];
}

export interface ReviewSubmissionSummary {
  id: string;
  slug: string;
  title: string;
  version: string;
  visibility: string;
  lifecycleStatus: string;
  reviewStatus: string;
  securityStatus: string;
  approvedArtifactSha256: string | null;
  platforms: Array<{ name: string; installTarget: string; status: string }>;
  findingCount: number;
  createdAt: string;
  allowedActions: ReviewActionName[];
}

export type ReviewActionName = "approve" | "request-changes" | "reject" | "publish";
export type SubmissionOwnerActionName = "withdraw";
export type ReleaseLifecycleActionName = "deprecate" | "unpublish" | "revoke" | "restore" | "delete";
export type SkillLifecycleActionName = "archive" | "restore" | "delete";

export interface ReviewActionResult {
  id: string;
  slug: string;
  version: string;
  visibility: string;
  lifecycleStatus: string;
  reviewStatus: string;
  securityStatus: string;
  approvedArtifactSha256: string | null;
  publishedAt: string | null;
}

export interface SubmissionScanFinding {
  category: string;
  severity: "warning" | "blocking";
  message: string;
  path?: string;
}

export interface SubmitArchiveInput {
  filename: string;
  contentBase64: string;
}

export interface SubmitSkillResult {
  submission: {
    id: string;
    slug: string;
    version: string;
    reviewStatus: string;
    securityStatus: string;
  };
  scan: {
    status: string;
    findingCount: number;
    findings: SubmissionScanFinding[];
  };
}

export interface UserSubmissionSummary {
  id: string;
  slug: string;
  title: string;
  summary: string;
  version: string;
  visibility: string;
  lifecycleStatus: string;
  reviewStatus: string;
  securityStatus: string;
  platforms: Array<{ name: string; installTarget: string; status: string }>;
  findingCount: number;
  artifact: {
    sha256: string;
    byteSize: number;
    contentType: string;
  };
  createdAt: string;
  publishedAt: string | null;
  allowedActions: Array<"export" | SubmissionOwnerActionName>;
}

export interface SkillManagementSummary {
  slug: string;
  title: string;
  summary: string;
  lifecycleStatus: string;
  visibility: VisibilityScope;
  tags: string[];
  allowedActions: Array<"edit" | SkillLifecycleActionName>;
}

export interface SkillReleaseSummary {
  id: string;
  slug: string;
  version: string;
  lifecycleStatus: string;
  reviewStatus: string;
  securityStatus: string;
  publishedAt: string | null;
  platforms: Array<{ name: string; installTarget: string; status: string }>;
  findingCount: number;
  allowedActions: ReleaseLifecycleActionName[];
}

export interface SkillPackageBundle {
  files: Array<{ path: string; content: string }>;
}

export interface ReviewSubmissionBundle {
  artifactSha256: string;
  payload: SkillPackageBundle;
}

export type LoginResult =
  | { mfaRequired: false; expiresAt: string; user: WebAuthUser }
  | { mfaRequired: true; challengeToken: string; expiresAt: string; user: WebAuthUser };

export interface SessionResult {
  expiresAt: string;
  user: WebAuthUser;
}

export interface RegistryClient {
  searchSkills(query: string): Promise<PublicSkill[]>;
  getSkill(slug: string): Promise<PublicSkill>;
  getRelease(slug: string, version: string): Promise<ReleaseMetadata>;
  login(input: { email: string; password: string }): Promise<LoginResult>;
  registerWithInvitation(input: { email: string; password: string; name?: string; inviteToken: string }): Promise<{ status: "pending" | "active" }>;
  requestPasswordReset(input: { email: string }): Promise<{ status: "pending" }>;
  confirmPasswordReset(input: { token: string; password: string }): Promise<{ status: "reset" }>;
  confirmEmailVerification(input: { token: string }): Promise<{ status: "verified" }>;
  verifyMfa(input: { challengeToken: string; codeOrRecoveryCode: string }): Promise<SessionResult>;
  getMe(token?: string): Promise<WebAuthUser>;
  logout(token?: string): Promise<void>;
  changePassword(input: { currentPassword: string; password: string }, token?: string): Promise<{ status: "changed" }>;
  requestEmailChange(input: { email: string; password: string }, token?: string): Promise<{ status: "pending" }>;
  confirmEmailChange(input: { token: string }): Promise<{ status: "changed" }>;
  getMfaStatus(token?: string): Promise<MfaStatus>;
  startTotpEnrollment(input: { password: string; label?: string }, token?: string): Promise<TotpEnrollment>;
  confirmTotpEnrollment(input: { factorId: string; code: string }, token?: string): Promise<ConfirmMfaResult>;
  disableTotpMfa(input: { password: string }, token?: string): Promise<{ status: "disabled"; disabledFactors: number }>;
  listApiTokens(token?: string): Promise<ApiToken[]>;
  createApiToken(input: { name: string; scopes: ApiTokenScope[]; expiresAt?: string }, token?: string): Promise<CreatedApiToken>;
  revokeApiToken(tokenId: string, token?: string): Promise<ApiToken>;
  getAdminRegistration(token?: string): Promise<AdminRegistrationSettings>;
  updateAdminRegistration(mode: AdminRegistrationMode, token?: string): Promise<AdminRegistrationSettings>;
  createRegistrationInvitation(input: { email: string; name?: string }, token?: string): Promise<RegistrationInvitation>;
  getAdminSharing(token?: string): Promise<AdminSharingSettings>;
  updateAdminSharing(settings: AdminSharingSettings, token?: string): Promise<AdminSharingSettings>;
  listAdminUsers(token?: string): Promise<AdminUser[]>;
  performAdminUserAction(userId: string, action: "approve" | "activate" | "disable" | "delete", reason?: string, token?: string): Promise<AdminUser>;
  updateAdminUserRoles(userId: string, roles: string[], reason: string, token?: string): Promise<AdminUser>;
  listAdminApiTokens(token?: string): Promise<AdminApiToken[]>;
  revokeAdminApiToken(tokenId: string, token?: string): Promise<AdminApiToken>;
  listAdminProviders(token?: string): Promise<AdminProviderConfig[]>;
  upsertAdminProvider(key: string, input: UpsertAdminProviderInput, token?: string): Promise<AdminProviderConfig>;
  listAdminAudit(limit?: number, token?: string): Promise<AdminAuditEvent[]>;
  submitArchive(input: SubmitArchiveInput, token?: string): Promise<SubmitSkillResult>;
  listUserSubmissions(token?: string): Promise<UserSubmissionSummary[]>;
  exportUserSubmission(submissionId: string, token?: string): Promise<SkillPackageBundle>;
  performSubmissionAction(submissionId: string, action: SubmissionOwnerActionName, reason?: string, token?: string): Promise<UserSubmissionSummary>;
  listReviewSubmissions(token?: string): Promise<ReviewSubmissionSummary[]>;
  getReviewSubmissionBundle(submissionId: string, platform?: string, token?: string): Promise<ReviewSubmissionBundle>;
  performReviewAction(input: { submissionId: string; action: ReviewActionName; reason?: string; artifactSha256?: string }, token?: string): Promise<ReviewActionResult>;
  listSkillReleases(slug: string, token?: string): Promise<SkillReleaseSummary[]>;
  updateSkillMetadata(input: { slug: string; title?: string; summary?: string; tags?: string[]; reason?: string }, token?: string): Promise<SkillManagementSummary>;
  performSkillAction(slug: string, action: SkillLifecycleActionName, reason?: string, token?: string): Promise<SkillManagementSummary>;
  performReleaseAction(slug: string, version: string, action: ReleaseLifecycleActionName, reason?: string, replacement?: string, token?: string): Promise<SkillReleaseSummary>;
  listTeams(token?: string): Promise<TeamDashboard>;
  createTeam(name: string, token?: string): Promise<TeamRecord>;
  inviteTeamMember(teamId: string, email: string, token?: string): Promise<TeamInvitation>;
  acceptTeamInvitation(invitationId: string, token?: string): Promise<TeamInvitation>;
  listTeamSharedSkills(token?: string): Promise<TeamSharedSkillGroup[]>;
  getSkillSharing(slug: string, token?: string): Promise<SkillSharingDetails>;
  updateSkillSharing(input: {
    slug: string;
    visibility: VisibilityScope;
    teamIds: string[];
    userEmails: string[];
    /** Complete replacement set; preserve existing grants when unrelated fields change. */
    organizationIds: string[];
  }, token?: string): Promise<SkillSharingDetails>;
  listOrganizations?(token?: string): Promise<OrganizationListItem[]>;
  createOrganization?(input: {
    name: string;
    slug?: string;
    policy?: OrganizationPolicyV1;
    reason?: string;
  }, token?: string): Promise<OrganizationDetail>;
  getOrganization?(organizationId: string, token?: string): Promise<OrganizationDetail>;
  listOrganizationMembers?(organizationId: string, token?: string): Promise<OrganizationMembershipRecord[]>;
  listOrganizationInvitations?(organizationId: string, token?: string): Promise<OrganizationInvitationRecord[]>;
  listOrganizationPendingInvitations?(token?: string): Promise<OrganizationInvitationRecord[]>;
  inviteOrganizationMember?(input: {
    organizationId: string;
    email: string;
    role?: OrganizationRole;
  }, token?: string): Promise<OrganizationInvitationRecord>;
  acceptOrganizationInvitation?(invitationId: string, token?: string): Promise<OrganizationInvitationRecord>;
  updateOrganizationMemberRole?(input: {
    organizationId: string;
    memberId: string;
    role: OrganizationRole;
  }, token?: string): Promise<OrganizationMembershipRecord>;
  removeOrganizationMember?(organizationId: string, memberId: string, token?: string): Promise<OrganizationMembershipRecord>;
  listOrganizationPolicies?(organizationId: string, token?: string): Promise<OrganizationPolicyRevisionRecord[]>;
  appendOrganizationPolicy?(input: {
    organizationId: string;
    policy: OrganizationPolicyV1;
    reason?: string;
  }, token?: string): Promise<{ revision: OrganizationPolicyRevisionRecord; created: boolean; activated: boolean }>;
  activateOrganizationPolicy?(organizationId: string, revisionId: string, token?: string): Promise<{
    revision: OrganizationPolicyRevisionRecord;
    activated: true;
    changed: boolean;
  }>;
  archiveOrganization?(organizationId: string, token?: string): Promise<OrganizationRecord>;
  listOrganizationTeams?(organizationId: string, token?: string): Promise<TeamRecord[]>;
  createOrganizationTeam?(input: { organizationId: string; name: string; slug?: string }, token?: string): Promise<TeamRecord>;
  adoptTeamToOrganization?(teamId: string, organizationId: string, token?: string): Promise<TeamRecord>;
  listArchitectureTargets?(token?: string): Promise<ArchitectureTargetRecord[]>;
  getArchitectureTarget?(targetId: string, token?: string): Promise<ArchitectureTargetRecord>;
  registerArchitectureTarget?(input: {
    name: string;
    owner: ArchitectureTargetOwnerReference;
    architectureId: string;
    environmentId: string;
    profileId: string;
    adapter: ArchitectureTargetAdapterDescriptor;
    capabilities: ArchitectureTargetCapabilities;
    identityDigest?: string;
    credentialReference?: string | null;
    metadata?: ArchitectureTargetMetadata;
  }, token?: string): Promise<ArchitectureTargetRecord>;
  setArchitectureTargetConsent?(targetId: string, decision: "grant" | "deny", token?: string): Promise<ArchitectureTargetRecord>;
  listArchitectureTargetObservations?(targetId: string, limit?: number, token?: string): Promise<ArchitectureTargetObservationRecord[]>;
  updateArchitectureTargetHealth?(targetId: string, health: ArchitectureTargetHealth, token?: string): Promise<ArchitectureTargetRecord>;
  revokeArchitectureTarget?(targetId: string, token?: string): Promise<ArchitectureTargetRecord>;
  listArchitecturePatterns(token?: string): Promise<ArchitecturePattern[]>;
  listArchitectures(token?: string): Promise<ArchitectureSummary[]>;
  getArchitecture(architectureId: string, token?: string): Promise<ArchitectureDetail>;
  getArchitectureRevision(architectureId: string, revisionId: string, token?: string): Promise<ArchitectureRevisionRecord>;
  createArchitecture(input: {
    name: string;
    description?: string;
    patternId: ArchitecturePatternId;
    owner?: { type: "user" } | { type: "team"; id: string };
  }, token?: string): Promise<ArchitectureSummary>;
  createArchitectureRevision(architectureId: string, input: { spec: unknown; message?: string; expectedCurrentRevisionId: string | null }, token?: string): Promise<ArchitectureRevisionRecord>;
  previewArchitecture(architectureId: string, input: { profileId?: string; environmentId?: string; revisionId?: string; organizationId?: string; fixture?: ArchitectureObservedFixture }, token?: string): Promise<ArchitecturePreview>;
  previewArchitectureDraft(architectureId: string, input: { spec: ArchitectureSpecV1; expectedCurrentRevisionId: string | null; profileId?: string; environmentId?: string; fixture?: ArchitectureObservedFixture }, token?: string): Promise<ArchitectureDraftPreview>;
  listArchitectureOrganizationGrants?(architectureId: string, token?: string): Promise<ArchitectureOrganizationGrantsResult>;
  replaceArchitectureOrganizationGrants?(architectureId: string, input: {
    expectedCurrentRevisionId: string | null;
    organizationIds: string[];
  }, token?: string): Promise<ArchitectureOrganizationGrantsResult>;
  previewArchitecturePatternMigration?(architectureId: string, input: {
    expectedCurrentRevisionId: string;
    targetPatternId: ArchitecturePatternId;
    mapping?: ArchitecturePatternMigrationMapping;
  }, token?: string): Promise<ArchitecturePatternMigrationPreviewResult>;
  createArchitecturePatternMigration?(architectureId: string, input: {
    expectedCurrentRevisionId: string;
    targetPatternId: ArchitecturePatternId;
    mapping?: ArchitecturePatternMigrationMapping;
    idempotencyKey: string;
    name: string;
    description?: string;
    message?: string;
  }, token?: string): Promise<ArchitecturePatternMigrationCreateResult>;
}

export interface SafeApiError extends Error {
  status: number;
  code: string;
}

function isArchitectureRevisionRecord(value: ArchitectureRevisionSummary | ArchitectureRevisionRecord | undefined): value is ArchitectureRevisionRecord {
  return Boolean(
    value
    && value.message !== undefined
    && value.createdByUserId !== undefined
    && value.spec !== undefined,
  );
}

export function createRegistryClient(baseUrl = defaultApiBaseUrl(), fetchImpl: typeof fetch = fetch, token?: string): RegistryClient {
  const root = baseUrl.replace(/\/+$/, "");
  const cookieSessionHeaders = { "x-myskills-session-response": "cookie" };
  return {
    async searchSkills(query: string) {
      const params = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
      const body = await requestJson<{ skills: PublicSkill[] }>(fetchImpl, `${root}/v1/skills${params}`, {
        token,
      });
      return body.skills;
    },
    async getSkill(slug: string) {
      const body = await requestJson<{ skill: PublicSkill }>(fetchImpl, `${root}/v1/skills/${encodeURIComponent(slug)}`, {
        token,
      });
      return body.skill;
    },
    async getRelease(slug: string, version: string) {
      const body = await requestJson<{ release: ReleaseMetadata }>(
        fetchImpl,
        `${root}/v1/skills/${encodeURIComponent(slug)}/releases/${encodeURIComponent(version)}`,
        { token },
      );
      return body.release;
    },
    async login(input) {
      return requestJson<LoginResult>(fetchImpl, `${root}/v1/auth/login`, {
        method: "POST",
        body: input,
        headers: cookieSessionHeaders,
      });
    },
    async registerWithInvitation(input) {
      return requestJson<{ status: "pending" | "active" }>(fetchImpl, `${root}/v1/auth/register`, {
        method: "POST",
        body: input,
      });
    },
    async requestPasswordReset(input) {
      return requestJson<{ status: "pending" }>(fetchImpl, `${root}/v1/auth/password-reset/request`, {
        method: "POST",
        body: input,
      });
    },
    async confirmPasswordReset(input) {
      return requestJson<{ status: "reset" }>(fetchImpl, `${root}/v1/auth/password-reset/confirm`, {
        method: "POST",
        body: input,
      });
    },
    async confirmEmailVerification(input) {
      return requestJson<{ status: "verified" }>(fetchImpl, `${root}/v1/auth/email-verification/confirm`, {
        method: "POST",
        body: input,
      });
    },
    async verifyMfa(input) {
      const body = /^[0-9]{6}$/.test(input.codeOrRecoveryCode.trim())
        ? { challengeToken: input.challengeToken, code: input.codeOrRecoveryCode.trim() }
        : { challengeToken: input.challengeToken, recoveryCode: input.codeOrRecoveryCode.trim() };
      return requestJson<SessionResult>(fetchImpl, `${root}/v1/auth/mfa/verify`, {
        method: "POST",
        body,
        headers: cookieSessionHeaders,
      });
    },
    async getMe(overrideToken) {
      const body = await requestJson<{ user: WebAuthUser }>(fetchImpl, `${root}/v1/me`, {
        token: overrideToken ?? token,
      });
      return body.user;
    },
    async logout(overrideToken) {
      await requestJson<Record<string, never>>(fetchImpl, `${root}/v1/auth/logout`, {
        method: "POST",
        body: {},
        token: overrideToken ?? token,
      });
    },
    async changePassword(input, overrideToken) {
      return requestJson<{ status: "changed" }>(fetchImpl, `${root}/v1/auth/account/password`, {
        method: "POST",
        body: input,
        token: overrideToken ?? token,
      });
    },
    async requestEmailChange(input, overrideToken) {
      return requestJson<{ status: "pending" }>(fetchImpl, `${root}/v1/auth/account/email-change`, {
        method: "POST",
        body: input,
        token: overrideToken ?? token,
      });
    },
    async confirmEmailChange(input) {
      return requestJson<{ status: "changed" }>(fetchImpl, `${root}/v1/auth/email-change/confirm`, {
        method: "POST",
        body: input,
      });
    },
    async getMfaStatus(overrideToken) {
      const body = await requestJson<{ mfa: MfaStatus }>(fetchImpl, `${root}/v1/auth/mfa`, {
        token: overrideToken ?? token,
      });
      return body.mfa;
    },
    async startTotpEnrollment(input, overrideToken) {
      const body = await requestJson<{ enrollment: TotpEnrollment }>(fetchImpl, `${root}/v1/auth/mfa/totp/enroll`, {
        method: "POST",
        body: {
          password: input.password,
          ...(input.label?.trim() ? { label: input.label.trim() } : {}),
        },
        token: overrideToken ?? token,
      });
      return body.enrollment;
    },
    async confirmTotpEnrollment(input, overrideToken) {
      const body = await requestJson<{ mfa: ConfirmMfaResult }>(fetchImpl, `${root}/v1/auth/mfa/totp/confirm`, {
        method: "POST",
        body: input,
        token: overrideToken ?? token,
      });
      return body.mfa;
    },
    async disableTotpMfa(input, overrideToken) {
      const body = await requestJson<{ mfa: { status: "disabled"; disabledFactors: number } }>(
        fetchImpl,
        `${root}/v1/auth/mfa/totp`,
        {
          method: "DELETE",
          body: input,
          token: overrideToken ?? token,
        },
      );
      return body.mfa;
    },
    async listApiTokens(overrideToken) {
      const body = await requestJson<{ tokens: ApiToken[] }>(fetchImpl, `${root}/v1/auth/api-tokens`, {
        token: overrideToken ?? token,
      });
      return body.tokens;
    },
    async createApiToken(input, overrideToken) {
      const body = await requestJson<{ token: CreatedApiToken }>(fetchImpl, `${root}/v1/auth/api-tokens`, {
        method: "POST",
        body: {
          name: input.name,
          scopes: input.scopes,
          ...(input.expiresAt?.trim() ? { expiresAt: input.expiresAt.trim() } : {}),
        },
        token: overrideToken ?? token,
      });
      return body.token;
    },
    async revokeApiToken(tokenId, overrideToken) {
      const body = await requestJson<{ token: ApiToken }>(
        fetchImpl,
        `${root}/v1/auth/api-tokens/${encodeURIComponent(tokenId)}`,
        { method: "DELETE", token: overrideToken ?? token },
      );
      return body.token;
    },
    async getAdminRegistration(overrideToken) {
      const body = await requestJson<{ registration: AdminRegistrationSettings }>(
        fetchImpl,
        `${root}/v1/admin/registration`,
        { token: overrideToken ?? token },
      );
      return body.registration;
    },
    async updateAdminRegistration(mode, overrideToken) {
      const body = await requestJson<{ registration: AdminRegistrationSettings }>(
        fetchImpl,
        `${root}/v1/admin/registration`,
        { method: "PUT", body: { mode }, token: overrideToken ?? token },
      );
      return body.registration;
    },
    async createRegistrationInvitation(input, overrideToken) {
      const body = await requestJson<{ invitation: RegistrationInvitation }>(
        fetchImpl,
        `${root}/v1/admin/registration/invitations`,
        { method: "POST", body: input, token: overrideToken ?? token },
      );
      return body.invitation;
    },
    async getAdminSharing(overrideToken) {
      const body = await requestJson<{ sharing: AdminSharingSettings }>(
        fetchImpl,
        `${root}/v1/admin/sharing`,
        { token: overrideToken ?? token },
      );
      return body.sharing;
    },
    async updateAdminSharing(settings, overrideToken) {
      const body = await requestJson<{ sharing: AdminSharingSettings }>(
        fetchImpl,
        `${root}/v1/admin/sharing`,
        { method: "PUT", body: settings, token: overrideToken ?? token },
      );
      return body.sharing;
    },
    async listAdminUsers(overrideToken) {
      const body = await requestJson<{ users: AdminUser[] }>(fetchImpl, `${root}/v1/admin/users`, {
        token: overrideToken ?? token,
      });
      return body.users;
    },
    async performAdminUserAction(userId, action, reason, overrideToken) {
      const body = await requestJson<{ user: AdminUser }>(
        fetchImpl,
        `${root}/v1/admin/users/${encodeURIComponent(userId)}/actions`,
        {
          method: "POST",
          body: { action, ...(reason?.trim() ? { reason: reason.trim() } : {}) },
          token: overrideToken ?? token,
        },
      );
      return body.user;
    },
    async updateAdminUserRoles(userId, roles, reason, overrideToken) {
      const body = await requestJson<{ user: AdminUser }>(
        fetchImpl,
        `${root}/v1/admin/users/${encodeURIComponent(userId)}/roles`,
        { method: "PUT", body: { roles, reason: reason.trim() }, token: overrideToken ?? token },
      );
      return body.user;
    },
    async listAdminApiTokens(overrideToken) {
      const body = await requestJson<{ tokens: AdminApiToken[] }>(fetchImpl, `${root}/v1/admin/api-tokens`, {
        token: overrideToken ?? token,
      });
      return body.tokens;
    },
    async revokeAdminApiToken(tokenId, overrideToken) {
      const body = await requestJson<{ token: AdminApiToken }>(
        fetchImpl,
        `${root}/v1/admin/api-tokens/${encodeURIComponent(tokenId)}`,
        { method: "DELETE", token: overrideToken ?? token },
      );
      return body.token;
    },
    async listAdminProviders(overrideToken) {
      const body = await requestJson<{ providers: AdminProviderConfig[] }>(
        fetchImpl,
        `${root}/v1/admin/providers`,
        { token: overrideToken ?? token },
      );
      return body.providers;
    },
    async upsertAdminProvider(key, input, overrideToken) {
      const body = await requestJson<{ provider: AdminProviderConfig }>(
        fetchImpl,
        `${root}/v1/admin/providers/${encodeURIComponent(key)}`,
        { method: "PUT", body: input, token: overrideToken ?? token },
      );
      return body.provider;
    },
    async listAdminAudit(limit = 25, overrideToken) {
      const body = await requestJson<{ events: AdminAuditEvent[] }>(
        fetchImpl,
        `${root}/v1/admin/audit?limit=${encodeURIComponent(String(limit))}`,
        { token: overrideToken ?? token },
      );
      return body.events;
    },
    async submitArchive(input, overrideToken) {
      return requestJson<SubmitSkillResult>(fetchImpl, `${root}/v1/submissions`, {
        method: "POST",
        body: {
          archive: {
            filename: input.filename,
            contentBase64: input.contentBase64,
          },
        },
        token: overrideToken ?? token,
      });
    },
    async listUserSubmissions(overrideToken) {
      const body = await requestJson<{ submissions: UserSubmissionSummary[] }>(fetchImpl, `${root}/v1/submissions/mine`, {
        token: overrideToken ?? token,
      });
      return body.submissions;
    },
    async exportUserSubmission(submissionId, overrideToken) {
      return requestJson<SkillPackageBundle>(
        fetchImpl,
        `${root}/v1/submissions/${encodeURIComponent(submissionId)}/bundle`,
        { token: overrideToken ?? token },
      );
    },
    async performSubmissionAction(submissionId, action, reason, overrideToken) {
      const body = await requestJson<{ submission: UserSubmissionSummary }>(
        fetchImpl,
        `${root}/v1/submissions/${encodeURIComponent(submissionId)}/actions`,
        {
          method: "POST",
          body: {
            action,
            ...(reason?.trim() ? { reason: reason.trim() } : {}),
          },
          token: overrideToken ?? token,
        },
      );
      return body.submission;
    },
    async listReviewSubmissions(overrideToken) {
      const body = await requestJson<{ submissions: ReviewSubmissionSummary[] }>(
        fetchImpl,
        `${root}/v1/review/submissions`,
        { token: overrideToken ?? token },
      );
      return body.submissions;
    },
    async getReviewSubmissionBundle(submissionId, platform, overrideToken) {
      const query = platform?.trim() ? `?platform=${encodeURIComponent(platform.trim())}` : "";
      const response = await requestJsonWithHeaders<SkillPackageBundle>(
        fetchImpl,
        `${root}/v1/review/submissions/${encodeURIComponent(submissionId)}/bundle${query}`,
        { token: overrideToken ?? token },
      );
      const artifactSha256 = response.headers.get("x-myskills-artifact-sha256") ?? "";
      if (!/^[a-f0-9]{64}$/.test(artifactSha256)) {
        throw new Error("Review bundle response is missing artifact hash.") as SafeApiError;
      }
      return {
        artifactSha256,
        payload: response.body,
      };
    },
    async performReviewAction(input, overrideToken) {
      const body = await requestJson<{ submission: ReviewActionResult }>(
        fetchImpl,
        `${root}/v1/review/submissions/${encodeURIComponent(input.submissionId)}/actions`,
        {
          method: "POST",
          body: {
            action: input.action,
            ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
            ...(input.artifactSha256 ? { artifactSha256: input.artifactSha256 } : {}),
          },
          token: overrideToken ?? token,
        },
      );
      return body.submission;
    },
    async listSkillReleases(slug, overrideToken) {
      const body = await requestJson<{ releases: SkillReleaseSummary[] }>(
        fetchImpl,
        `${root}/v1/skills/${encodeURIComponent(slug)}/releases`,
        { token: overrideToken ?? token },
      );
      return body.releases;
    },
    async updateSkillMetadata(input, overrideToken) {
      const body = await requestJson<{ skill: SkillManagementSummary }>(
        fetchImpl,
        `${root}/v1/skills/${encodeURIComponent(input.slug)}`,
        {
          method: "PUT",
          body: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
            ...(input.tags !== undefined ? { tags: input.tags } : {}),
            ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
          },
          token: overrideToken ?? token,
        },
      );
      return body.skill;
    },
    async performSkillAction(slug, action, reason, overrideToken) {
      const body = await requestJson<{ skill: SkillManagementSummary }>(
        fetchImpl,
        `${root}/v1/skills/${encodeURIComponent(slug)}/actions`,
        {
          method: "POST",
          body: {
            action,
            ...(reason?.trim() ? { reason: reason.trim() } : {}),
          },
          token: overrideToken ?? token,
        },
      );
      return body.skill;
    },
    async performReleaseAction(slug, version, action, reason, replacement, overrideToken) {
      const body = await requestJson<{ release: SkillReleaseSummary }>(
        fetchImpl,
        `${root}/v1/skills/${encodeURIComponent(slug)}/releases/${encodeURIComponent(version)}/actions`,
        {
          method: "POST",
          body: {
            action,
            ...(reason?.trim() ? { reason: reason.trim() } : {}),
            ...(replacement?.trim() ? { replacement: replacement.trim() } : {}),
          },
          token: overrideToken ?? token,
        },
      );
      return body.release;
    },
    async listTeams(overrideToken) {
      return requestJson<TeamDashboard>(fetchImpl, `${root}/v1/teams`, {
        token: overrideToken ?? token,
      });
    },
    async createTeam(name, overrideToken) {
      const body = await requestJson<{ team: TeamRecord }>(fetchImpl, `${root}/v1/teams`, {
        method: "POST",
        body: { name },
        token: overrideToken ?? token,
      });
      return body.team;
    },
    async inviteTeamMember(teamId, email, overrideToken) {
      const body = await requestJson<{ invitation: TeamInvitation }>(
        fetchImpl,
        `${root}/v1/teams/${encodeURIComponent(teamId)}/invitations`,
        { method: "POST", body: { email }, token: overrideToken ?? token },
      );
      return body.invitation;
    },
    async acceptTeamInvitation(invitationId, overrideToken) {
      const body = await requestJson<{ invitation: TeamInvitation }>(
        fetchImpl,
        `${root}/v1/teams/invitations/${encodeURIComponent(invitationId)}/accept`,
        { method: "POST", body: {}, token: overrideToken ?? token },
      );
      return body.invitation;
    },
    async listTeamSharedSkills(overrideToken) {
      const body = await requestJson<{ teams: TeamSharedSkillGroup[] }>(
        fetchImpl,
        `${root}/v1/teams/shared-skills`,
        { token: overrideToken ?? token },
      );
      return body.teams;
    },
    async getSkillSharing(slug, overrideToken) {
      const body = await requestJson<{ sharing: SkillSharingDetails }>(
        fetchImpl,
        `${root}/v1/skills/${encodeURIComponent(slug)}/sharing`,
        { token: overrideToken ?? token },
      );
      return body.sharing;
    },
    async updateSkillSharing(input, overrideToken) {
      const body = await requestJson<{ sharing: SkillSharingDetails }>(
        fetchImpl,
        `${root}/v1/skills/${encodeURIComponent(input.slug)}/sharing`,
        {
          method: "PUT",
          body: {
            visibility: input.visibility,
            teamIds: input.teamIds,
            userEmails: input.userEmails,
            organizationIds: input.organizationIds,
          },
          token: overrideToken ?? token,
        },
      );
      return body.sharing;
    },
    async listOrganizations(overrideToken) {
      const body = await requestJson<{ organizations: OrganizationListItem[] }>(fetchImpl, `${root}/v1/organizations`, {
        token: overrideToken ?? token,
      });
      return body.organizations;
    },
    async createOrganization(input, overrideToken) {
      const body = await requestJson<{ organization: OrganizationDetail }>(fetchImpl, `${root}/v1/organizations`, {
        method: "POST",
        body: {
          name: input.name,
          ...(input.slug?.trim() ? { slug: input.slug.trim() } : {}),
          ...(input.policy ? { policy: input.policy } : {}),
          ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
        },
        token: overrideToken ?? token,
      });
      return body.organization;
    },
    async getOrganization(organizationId, overrideToken) {
      const body = await requestJson<{ organization: OrganizationDetail }>(
        fetchImpl,
        `${root}/v1/organizations/${encodeURIComponent(organizationId)}`,
        { token: overrideToken ?? token },
      );
      return body.organization;
    },
    async listOrganizationMembers(organizationId, overrideToken) {
      const body = await requestJson<{ members: OrganizationMembershipRecord[] }>(
        fetchImpl,
        `${root}/v1/organizations/${encodeURIComponent(organizationId)}/members`,
        { token: overrideToken ?? token },
      );
      return body.members;
    },
    async listOrganizationInvitations(organizationId, overrideToken) {
      const body = await requestJson<{ invitations: OrganizationInvitationRecord[] }>(
        fetchImpl,
        `${root}/v1/organizations/${encodeURIComponent(organizationId)}/invitations`,
        { token: overrideToken ?? token },
      );
      return body.invitations;
    },
    async listOrganizationPendingInvitations(overrideToken) {
      const body = await requestJson<{ invitations: OrganizationInvitationRecord[] }>(
        fetchImpl,
        `${root}/v1/organizations/invitations`,
        { token: overrideToken ?? token },
      );
      return body.invitations;
    },
    async inviteOrganizationMember(input, overrideToken) {
      const body = await requestJson<{ invitation: OrganizationInvitationRecord }>(
        fetchImpl,
        `${root}/v1/organizations/${encodeURIComponent(input.organizationId)}/invitations`,
        {
          method: "POST",
          body: { email: input.email, ...(input.role ? { role: input.role } : {}) },
          token: overrideToken ?? token,
        },
      );
      return body.invitation;
    },
    async acceptOrganizationInvitation(invitationId, overrideToken) {
      const body = await requestJson<{ invitation: OrganizationInvitationRecord }>(
        fetchImpl,
        `${root}/v1/organizations/invitations/${encodeURIComponent(invitationId)}/accept`,
        { method: "POST", body: {}, token: overrideToken ?? token },
      );
      return body.invitation;
    },
    async updateOrganizationMemberRole(input, overrideToken) {
      const body = await requestJson<{ member: OrganizationMembershipRecord }>(
        fetchImpl,
        `${root}/v1/organizations/${encodeURIComponent(input.organizationId)}/members/${encodeURIComponent(input.memberId)}`,
        { method: "PUT", body: { role: input.role }, token: overrideToken ?? token },
      );
      return body.member;
    },
    async removeOrganizationMember(organizationId, memberId, overrideToken) {
      const body = await requestJson<{ member: OrganizationMembershipRecord }>(
        fetchImpl,
        `${root}/v1/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(memberId)}`,
        { method: "DELETE", token: overrideToken ?? token },
      );
      return body.member;
    },
    async listOrganizationPolicies(organizationId, overrideToken) {
      const body = await requestJson<{ revisions: OrganizationPolicyRevisionRecord[] }>(
        fetchImpl,
        `${root}/v1/organizations/${encodeURIComponent(organizationId)}/policy-revisions`,
        { token: overrideToken ?? token },
      );
      return body.revisions;
    },
    async appendOrganizationPolicy(input, overrideToken) {
      return requestJson<{ revision: OrganizationPolicyRevisionRecord; created: boolean; activated: boolean }>(
        fetchImpl,
        `${root}/v1/organizations/${encodeURIComponent(input.organizationId)}/policy-revisions`,
        {
          method: "POST",
          body: { policy: input.policy, ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}) },
          token: overrideToken ?? token,
        },
      );
    },
    async activateOrganizationPolicy(organizationId, revisionId, overrideToken) {
      const body = await requestJson<{ revision: OrganizationPolicyRevisionRecord; activated: true; changed: boolean }>(
        fetchImpl,
        `${root}/v1/organizations/${encodeURIComponent(organizationId)}/policy-revisions/${encodeURIComponent(revisionId)}/actions`,
        { method: "POST", body: { action: "activate" }, token: overrideToken ?? token },
      );
      return body;
    },
    async archiveOrganization(organizationId, overrideToken) {
      const body = await requestJson<{ organization: OrganizationRecord }>(
        fetchImpl,
        `${root}/v1/organizations/${encodeURIComponent(organizationId)}/actions`,
        { method: "POST", body: { action: "archive" }, token: overrideToken ?? token },
      );
      return body.organization;
    },
    async listOrganizationTeams(organizationId, overrideToken) {
      const body = await requestJson<{ teams: TeamRecord[] }>(
        fetchImpl,
        `${root}/v1/organizations/${encodeURIComponent(organizationId)}/teams`,
        { token: overrideToken ?? token },
      );
      return body.teams;
    },
    async createOrganizationTeam(input, overrideToken) {
      const body = await requestJson<{ team: TeamRecord }>(
        fetchImpl,
        `${root}/v1/organizations/${encodeURIComponent(input.organizationId)}/teams`,
        {
          method: "POST",
          body: { name: input.name, ...(input.slug?.trim() ? { slug: input.slug.trim() } : {}) },
          token: overrideToken ?? token,
        },
      );
      return body.team;
    },
    async adoptTeamToOrganization(teamId, organizationId, overrideToken) {
      const body = await requestJson<{ team: TeamRecord }>(
        fetchImpl,
        `${root}/v1/teams/${encodeURIComponent(teamId)}/organization`,
        { method: "PUT", body: { organizationId }, token: overrideToken ?? token },
      );
      return body.team;
    },
    async listArchitectureTargets(overrideToken) {
      const body = await requestJson<{ targets: ArchitectureTargetRecord[] }>(fetchImpl, `${root}/v1/architecture-targets`, {
        token: overrideToken ?? token,
      });
      return body.targets;
    },
    async getArchitectureTarget(targetId, overrideToken) {
      const body = await requestJson<{ target: ArchitectureTargetRecord }>(
        fetchImpl,
        `${root}/v1/architecture-targets/${encodeURIComponent(targetId)}`,
        { token: overrideToken ?? token },
      );
      return body.target;
    },
    async registerArchitectureTarget(input, overrideToken) {
      const body = await requestJson<{ target: ArchitectureTargetRecord }>(fetchImpl, `${root}/v1/architecture-targets`, {
        method: "POST",
        body: {
          name: input.name,
          owner: input.owner,
          architectureId: input.architectureId,
          environmentId: input.environmentId,
          profileId: input.profileId,
          adapter: input.adapter,
          capabilities: input.capabilities,
          ...(input.identityDigest?.trim() ? { identityDigest: input.identityDigest.trim() } : {}),
          ...(input.credentialReference?.trim() ? { credentialReference: input.credentialReference.trim() } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
        token: overrideToken ?? token,
      });
      return body.target;
    },
    async setArchitectureTargetConsent(targetId, decision, overrideToken) {
      const body = await requestJson<{ target: ArchitectureTargetRecord }>(
        fetchImpl,
        `${root}/v1/architecture-targets/${encodeURIComponent(targetId)}/consent`,
        { method: "POST", body: { decision }, token: overrideToken ?? token },
      );
      return body.target;
    },
    async listArchitectureTargetObservations(targetId, limit, overrideToken) {
      const query = limit === undefined ? "" : `?limit=${encodeURIComponent(String(limit))}`;
      const body = await requestJson<{ observations: ArchitectureTargetObservationRecord[] }>(
        fetchImpl,
        `${root}/v1/architecture-targets/${encodeURIComponent(targetId)}/observations${query}`,
        { token: overrideToken ?? token },
      );
      return body.observations;
    },
    async updateArchitectureTargetHealth(targetId, health, overrideToken) {
      const body = await requestJson<{ target: ArchitectureTargetRecord }>(
        fetchImpl,
        `${root}/v1/architecture-targets/${encodeURIComponent(targetId)}/health`,
        { method: "POST", body: health, token: overrideToken ?? token },
      );
      return body.target;
    },
    async revokeArchitectureTarget(targetId, overrideToken) {
      const body = await requestJson<{ target: ArchitectureTargetRecord }>(
        fetchImpl,
        `${root}/v1/architecture-targets/${encodeURIComponent(targetId)}`,
        { method: "DELETE", token: overrideToken ?? token },
      );
      return body.target;
    },
    async listArchitecturePatterns(overrideToken) {
      const body = await requestJson<{ patterns: ArchitecturePattern[] }>(
        fetchImpl,
        `${root}/v1/architecture-patterns`,
        { token: overrideToken ?? token },
      );
      return body.patterns;
    },
    async listArchitectures(overrideToken) {
      const body = await requestJson<{ architectures: ArchitectureSummary[] }>(
        fetchImpl,
        `${root}/v1/architectures`,
        { token: overrideToken ?? token },
      );
      return body.architectures;
    },
    async getArchitecture(architectureId, overrideToken) {
      const body = await requestJson<{ architecture: ArchitectureSummary; revisions?: ArchitectureRevisionSummary[]; latestRevision?: ArchitectureRevisionRecord | null }>(
        fetchImpl,
        `${root}/v1/architectures/${encodeURIComponent(architectureId)}`,
        { token: overrideToken ?? token },
      );
      const revisions = body.revisions ?? [];
      const latestRevision = body.latestRevision
        ?? (isArchitectureRevisionRecord(revisions[0]) ? revisions[0] : null);
      return {
        ...body.architecture,
        revisions,
        latestRevision,
        revisionCount: body.architecture.revisionCount ?? revisions.length,
      };
    },
    async getArchitectureRevision(architectureId, revisionId, overrideToken) {
      const body = await requestJson<{ revision: ArchitectureRevisionRecord }>(
        fetchImpl,
        `${root}/v1/architectures/${encodeURIComponent(architectureId)}/revisions/${encodeURIComponent(revisionId)}`,
        { token: overrideToken ?? token },
      );
      return body.revision;
    },
    async createArchitecture(input, overrideToken) {
      const body = await requestJson<{ architecture: ArchitectureSummary }>(
        fetchImpl,
        `${root}/v1/architectures`,
        {
          method: "POST",
          body: {
            name: input.name,
            ...(input.description?.trim() ? { description: input.description.trim() } : {}),
            patternId: input.patternId,
            ...(input.owner === undefined ? {} : { owner: input.owner }),
          },
          token: overrideToken ?? token,
        },
      );
      return body.architecture;
    },
    async createArchitectureRevision(architectureId, input, overrideToken) {
      const body = await requestJson<{ revision: ArchitectureRevisionRecord }>(
        fetchImpl,
        `${root}/v1/architectures/${encodeURIComponent(architectureId)}/revisions`,
        {
          method: "POST",
          body: {
            spec: input.spec,
            ...(input.message?.trim() ? { message: input.message.trim() } : {}),
            expectedCurrentRevisionId: input.expectedCurrentRevisionId,
          },
          token: overrideToken ?? token,
        },
      );
      return body.revision;
    },
    async previewArchitecture(architectureId, input, overrideToken) {
      const body = await requestJson<ArchitecturePreview>(
        fetchImpl,
        `${root}/v1/architectures/${encodeURIComponent(architectureId)}/preview`,
        {
          method: "POST",
          body: {
            ...(input.profileId ? { profileId: input.profileId } : {}),
            ...(input.environmentId ? { environmentId: input.environmentId } : {}),
            ...(input.revisionId ? { revisionId: input.revisionId } : {}),
            ...(input.organizationId ? { organizationId: input.organizationId } : {}),
            ...(input.fixture !== undefined ? { fixture: input.fixture } : {}),
          },
          token: overrideToken ?? token,
        },
      );
      return body;
    },
    async previewArchitectureDraft(architectureId, input, overrideToken) {
      const body = await requestJson<ArchitectureDraftPreview>(
        fetchImpl,
        `${root}/v1/architectures/${encodeURIComponent(architectureId)}/draft-preview`,
        {
          method: "POST",
          body: {
            spec: input.spec,
            expectedCurrentRevisionId: input.expectedCurrentRevisionId,
            ...(input.profileId ? { profileId: input.profileId } : {}),
            ...(input.environmentId ? { environmentId: input.environmentId } : {}),
            ...(input.fixture !== undefined ? { fixture: input.fixture } : {}),
          },
          token: overrideToken ?? token,
        },
      );
      return body;
    },
    async listArchitectureOrganizationGrants(architectureId, overrideToken) {
      return requestJson<ArchitectureOrganizationGrantsResult>(
        fetchImpl,
        `${root}/v1/architectures/${encodeURIComponent(architectureId)}/organization-grants`,
        { token: overrideToken ?? token },
      );
    },
    async replaceArchitectureOrganizationGrants(architectureId, input, overrideToken) {
      return requestJson<ArchitectureOrganizationGrantsResult>(
        fetchImpl,
        `${root}/v1/architectures/${encodeURIComponent(architectureId)}/organization-grants`,
        {
          method: "PUT",
          body: {
            expectedCurrentRevisionId: input.expectedCurrentRevisionId,
            organizationIds: input.organizationIds,
          },
          token: overrideToken ?? token,
        },
      );
    },
    async previewArchitecturePatternMigration(architectureId, input, overrideToken) {
      return requestJson<ArchitecturePatternMigrationPreviewResult>(
        fetchImpl,
        `${root}/v1/architectures/${encodeURIComponent(architectureId)}/pattern-migrations/preview`,
        {
          method: "POST",
          body: {
            expectedCurrentRevisionId: input.expectedCurrentRevisionId,
            targetPatternId: input.targetPatternId,
            ...(input.mapping !== undefined ? { mapping: input.mapping } : {}),
          },
          token: overrideToken ?? token,
        },
      );
    },
    async createArchitecturePatternMigration(architectureId, input, overrideToken) {
      return requestJson<ArchitecturePatternMigrationCreateResult>(
        fetchImpl,
        `${root}/v1/architectures/${encodeURIComponent(architectureId)}/pattern-migrations`,
        {
          method: "POST",
          body: {
            expectedCurrentRevisionId: input.expectedCurrentRevisionId,
            targetPatternId: input.targetPatternId,
            idempotencyKey: input.idempotencyKey,
            name: input.name,
            ...(input.description?.trim() ? { description: input.description.trim() } : {}),
            ...(input.message?.trim() ? { message: input.message.trim() } : {}),
            ...(input.mapping !== undefined ? { mapping: input.mapping } : {}),
          },
          token: overrideToken ?? token,
        },
      );
    },
  };
}

export function exportCommand(slug: string, version: string, platform: string): string {
  return `myskills export ${shellArg(slug)} --version ${shellArg(version)} --platform ${shellArg(platform)} --output ${shellArg(`./skills/${slug}`)}`;
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function safeErrorMessage(error: unknown): string {
  if (isSafeApiError(error) && error.status === 404) {
    return "Skill or release not found.";
  }
  if (isSafeApiError(error) && (error.status === 401 || error.status === 403)) {
    return "You do not have access to that registry item.";
  }
  if (isSafeApiError(error) && error.status >= 400 && error.status < 500) {
    return "The registry request could not be completed.";
  }
  return "The registry is not available.";
}

export function safeAuthErrorMessage(error: unknown): string {
  if (isSafeApiError(error) && error.status === 429) {
    return "Too many sign-in attempts. Try again later.";
  }
  if (isSafeApiError(error) && error.status === 401) {
    return "Invalid email or password.";
  }
  if (isSafeApiError(error) && error.status >= 400 && error.status < 500) {
    return "Sign in could not be completed.";
  }
  return "Authentication is not available.";
}

export function safeAccountErrorMessage(error: unknown): string {
  if (isSafeApiError(error) && error.status === 429) {
    return "Too many attempts. Try again later.";
  }
  if (
    isSafeApiError(error)
    && (
      error.code === "INVALID_RESET_TOKEN"
      || error.code === "INVALID_VERIFICATION_TOKEN"
      || error.code === "INVALID_INVITATION_TOKEN"
    )
  ) {
    return "This link is invalid or expired.";
  }
  if (isSafeApiError(error) && error.status === 401) {
    return "Current password is incorrect.";
  }
  if (isSafeApiError(error) && error.status === 403 && error.code === "MFA_VERIFICATION_REQUIRED") {
    return "Sign in with MFA before changing this setting.";
  }
  if (isSafeApiError(error) && error.code === "EMAIL_ALREADY_IN_USE") {
    return "That email address is already in use.";
  }
  if (isSafeApiError(error) && error.code === "INVALID_PASSWORD") {
    return "Choose a stronger password.";
  }
  if (isSafeApiError(error) && error.status >= 400 && error.status < 500) {
    return "Account change could not be completed.";
  }
  return "Account settings are not available.";
}

export function safeAdminErrorMessage(error: unknown): string {
  if (isSafeApiError(error) && error.code === "USER_NOT_INVITABLE") {
    return "That email address cannot be invited.";
  }
  if (isSafeApiError(error) && error.code === "INVITATION_DELIVERY_FAILED") {
    return "Invitation email could not be sent. Check notification delivery and try again.";
  }
  if (isSafeApiError(error) && (error.status === 401 || error.status === 403)) {
    return "Admin access requires an MFA-verified owner or admin session.";
  }
  if (isSafeApiError(error) && error.status >= 400 && error.status < 500) {
    return "Admin change could not be saved.";
  }
  return "Admin data is not available.";
}

export function safeSubmitErrorMessage(error: unknown): string {
  if (isSafeApiError(error) && (error.status === 401 || error.status === 403)) {
    return "Submission requires an authorized author session. Privileged roles must complete MFA.";
  }
  if (isSafeApiError(error) && error.status >= 400 && error.status < 500) {
    return "Submission could not be accepted.";
  }
  return "Submission service is not available.";
}

export function safeReviewErrorMessage(error: unknown): string {
  if (isSafeApiError(error) && (error.status === 401 || error.status === 403)) {
    return "Review access requires an MFA-verified maintainer session.";
  }
  if (isSafeApiError(error) && error.status >= 400 && error.status < 500) {
    return "Review action could not be completed.";
  }
  return "Review queue is not available.";
}

export function safeTeamErrorMessage(error: unknown): string {
  if (isSafeApiError(error) && (error.status === 401 || error.status === 403)) {
    return "Team access requires a signed-in session with team sharing enabled.";
  }
  if (isSafeApiError(error) && error.status >= 400 && error.status < 500) {
    return "Team change could not be saved.";
  }
  return "Team data is not available.";
}

export function safeArchitectureErrorMessage(error: unknown): string {
  if (isSafeApiError(error) && (error.status === 401 || error.status === 403)) {
    return "Architecture access requires a signed-in session with the right workspace access.";
  }
  if (isSafeApiError(error) && (error.status === 409 || error.code === "ARCHITECTURE_CONFLICT")) {
    return "This architecture changed elsewhere. Refresh before saving another revision.";
  }
  if (isSafeApiError(error) && (error.status === 422 || error.code === "ARCHITECTURE_VALIDATION_FAILED")) {
    return "The architecture is not valid yet. Fix the highlighted structure and try again.";
  }
  if (isSafeApiError(error) && (error.status === 501 || error.code === "ARCHITECTURE_NOT_SUPPORTED")) {
    return "Architecture management is not enabled for this workspace yet.";
  }
  if (isSafeApiError(error) && error.status >= 400 && error.status < 500) {
    return "The architecture request could not be completed.";
  }
  return "Architecture data is not available.";
}

export function safeOrganizationErrorMessage(error: unknown): string {
  if (isSafeApiError(error) && (error.status === 401 || error.status === 403)) {
    return "Organization access requires a signed-in session with the right membership or MFA verification.";
  }
  if (isSafeApiError(error) && error.status === 409) {
    return "The organization changed elsewhere. Refresh before trying again.";
  }
  if (isSafeApiError(error) && error.status >= 400 && error.status < 500) {
    return "The organization request could not be completed.";
  }
  return "Organization data is not available.";
}

export function safeArchitectureTargetErrorMessage(error: unknown): string {
  if (isSafeApiError(error) && (error.status === 401 || error.status === 403)) {
    return "Target access requires an authorized session for the exact architecture context.";
  }
  if (isSafeApiError(error) && error.status === 410) {
    return "This target has been revoked and cannot accept further updates.";
  }
  if (isSafeApiError(error) && error.status === 409) {
    return "The target changed elsewhere or its binding is stale. Refresh before trying again.";
  }
  if (isSafeApiError(error) && error.status >= 400 && error.status < 500) {
    return "The connected-environment request could not be completed.";
  }
  return "Connected-environment data is not available.";
}

async function requestJson<T>(fetchImpl: typeof fetch, url: string, options: {
  body?: unknown;
  headers?: Record<string, string>;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  token?: string;
} = {}): Promise<T> {
  return (await requestJsonWithHeaders<T>(fetchImpl, url, options)).body;
}

async function requestJsonWithHeaders<T>(fetchImpl: typeof fetch, url: string, options: {
  body?: unknown;
  headers?: Record<string, string>;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  token?: string;
} = {}): Promise<{ body: T; headers: Headers }> {
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  const response = await fetchImpl(url, {
    method: options.method,
    credentials: "include",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) {
    const error = new Error(safeResponseMessage(body, response.status)) as SafeApiError;
    error.status = response.status;
    error.code = safeResponseCode(body);
    throw error;
  }
  return { body: body as T, headers: response.headers };
}

function safeResponseCode(body: Record<string, unknown>): string {
  const error = body.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return "API_ERROR";
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "API_ERROR";
}

function safeResponseMessage(body: Record<string, unknown>, status: number): string {
  const error = body.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return `Registry request failed with ${status}.`;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : `Registry request failed with ${status}.`;
}

function isSafeApiError(error: unknown): error is SafeApiError {
  return Boolean(error && typeof error === "object" && "status" in error);
}

function defaultApiBaseUrl(): string {
  return import.meta.env?.VITE_API_BASE_URL ?? "http://localhost:3001";
}
