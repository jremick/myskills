import { APPLICATION_SCOPES } from "@myskills-app/core";

export const OAUTH_SCOPES = APPLICATION_SCOPES;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];
export const OAUTH_ASSURANCE_WINDOW_MS = 15 * 60 * 1000;

export const OAUTH_SCOPE_DESCRIPTIONS: Record<OAuthScope, string> = {
  "skills:read": "Find skills you can access and read their release metadata, instructions and supporting text files.",
  "architectures:read": "View skill architectures you can access, including their structure and referenced releases.",
  "profile:read": "View your account profile.",
  "skills:submit": "Submit skill packages for review under your account.",
  "review:read": "View submissions, scans and review details you are permitted to review.",
  "review:write": "Run scans and make review or publication decisions you are permitted to make.",
  "improvements:read": "View improvement settings, proposals, runs and evidence you can access.",
  "improvements:configure": "Change authorized improvement settings and subscriptions.",
  "improvements:run": "Create and control authorized improvement runs and plans.",
  "improvements:report": "Record authorized improvement evidence, events and outcomes.",
  "libraries:read": "View your accessible libraries, entries, candidates and bundle sources.",
  "libraries:write": "Create and change libraries, entries, candidates and bundles you can manage.",
  "account:connections:revoke": "Disconnect applications connected to your account.",
  "account:read": "View safe account security metadata, API token metadata and connected applications.",
  "account:tokens:revoke": "Revoke API tokens belonging to your account.",
  "admin:read": "View administration settings, users, token metadata and audit history allowed by your role.",
  "admin:settings": "Change instance branding, site, registration, authentication-provider and sharing settings allowed by your role.",
  "admin:tokens:revoke": "Revoke API tokens you are authorized to administer.",
  "admin:users": "Manage registration invitations, user status and roles allowed by your role.",
  "architectures:write": "Create and change authorized architectures, revisions, grants and migrations.",
  "libraries:bind": "Bind authorized libraries to architectures and targets.",
  "organizations:read": "View organizations, members, invitations, policies and teams you can access.",
  "organizations:write": "Manage organizations, membership, invitations, policies and teams you are permitted to change.",
  "sharing:read": "View skill sharing settings and team skill groups you can access.",
  "sharing:write": "Change skill visibility and sharing grants you are authorized to manage.",
  "skills:manage": "List the inventory of skills you are permitted to manage.",
  "submissions:read": "View and export submissions available to your account.",
  "targets:control": "Register and manage authorized targets, consent, policies and scheduled operations without acting as their local executor.",
  "targets:read": "View authorized targets, observations, health, updates and scheduled operations.",
  "teams:read": "View teams, members and invitations available to your account.",
  "teams:write": "Create teams and manage membership and invitations you are permitted to change.",
};

/** Consent effects are explicit: scope names and HTTP methods are not a policy. */
export const OAUTH_SCOPE_READ_ONLY: Record<OAuthScope, boolean> = {
  "profile:read": true,
  "skills:read": true,
  "architectures:read": true,
  "skills:submit": false,
  "review:read": true,
  "review:write": false,
  "improvements:read": true,
  "improvements:configure": false,
  "improvements:run": false,
  "improvements:report": false,
  "libraries:read": true,
  "libraries:write": false,
  "account:connections:revoke": false,
  "account:read": true,
  "account:tokens:revoke": false,
  "admin:read": true,
  "admin:settings": false,
  "admin:tokens:revoke": false,
  "admin:users": false,
  "architectures:write": false,
  "libraries:bind": false,
  "organizations:read": true,
  "organizations:write": false,
  "sharing:read": true,
  "sharing:write": false,
  "skills:manage": true,
  "submissions:read": true,
  "targets:control": false,
  "targets:read": true,
  "teams:read": true,
  "teams:write": false,
};

export type OAuthClientAuthMethod = "none" | "client_secret_post" | "client_secret_basic";
export type OAuthClientRegistration = "dynamic" | "configured";
export type OAuthGrantRevocationReason = "user" | "client" | "refresh_reuse" | "code_replay" | "account";

export interface OAuthClientRecord {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: OAuthClientAuthMethod;
  clientSecretHash: string | null;
  registration: OAuthClientRegistration;
  createdAt: Date;
}

export interface OAuthAuthorizationRequestRecord {
  id: string;
  clientId: string;
  redirectUri: string;
  scopes: OAuthScope[];
  resource: string;
  state: string | null;
  codeChallenge: string;
  status: "pending" | "approved" | "denied";
  userId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface OAuthAuthorizationCodeRecord {
  id: string;
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: OAuthScope[];
  expiresAt: Date;
  mfaVerifiedAt: Date | null;
  assuranceExpiresAt: Date | null;
}

export interface OAuthGrantRecord {
  id: string;
  userId: string;
  clientId: string;
  clientName: string;
  registration: OAuthClientRegistration;
  scopes: OAuthScope[];
  resource: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: OAuthGrantRevocationReason | null;
  mfaVerifiedAt: Date | null;
  assuranceExpiresAt: Date | null;
}

export interface OAuthAccessTokenRecord {
  id: string;
  grantId: string;
  scopes: OAuthScope[];
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface OAuthRefreshTokenRecord {
  id: string;
  grantId: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

export interface NewOAuthToken {
  tokenHash: string;
  expiresAt: Date;
}

export type DecideAuthorizationOutcome =
  | { outcome: "decided"; request: OAuthAuthorizationRequestRecord }
  /** session_revoked: the approving session or account was revoked before the decision committed. */
  | { outcome: "not_found" | "expired" | "already_decided" | "connection_limit" | "session_revoked" | "mfa_required" };

export type RedeemCodeOutcome =
  /** The code was consumed and its grant and first token pair were created atomically. */
  | { outcome: "issued"; grant: OAuthGrantRecord; code: OAuthAuthorizationCodeRecord }
  /** The code was already consumed; the grant it produced, if any, is now revoked. */
  | { outcome: "replayed"; revokedGrant: OAuthGrantRecord | null }
  /** The code was consumed but failed client, redirect, PKCE, resource or expiry checks. */
  | { outcome: "rejected" }
  /** The code was consumed but the account already has the maximum active connections. */
  | { outcome: "connection_limit" }
  /** Unknown code, or a code invalidated by account-level revocation. */
  | { outcome: "invalid" };

export interface IssuedTokenPair {
  grant: Omit<OAuthGrantRecord, "id" | "lastUsedAt" | "revokedAt" | "revokedReason">;
  accessToken: NewOAuthToken & { scopes: OAuthScope[] };
  refreshToken: NewOAuthToken;
}

export type RotateRefreshOutcome =
  | { outcome: "rotated"; grant: OAuthGrantRecord }
  | { outcome: "reused"; grantId: string }
  | { outcome: "invalid" };

/**
 * Persistence for connector authorization. Every single-use transition
 * (request decision, code redemption, refresh rotation) is one atomic
 * operation; memory and Postgres implementations share these semantics.
 * Account-level credential revocation revokes grants and unredeemed codes.
 */
export interface OAuthStore {
  createDynamicClient(input: { client: Omit<OAuthClientRecord, "registration" | "createdAt">; now: Date; maxClients: number }): Promise<OAuthClientRecord | null>;
  findDynamicClient(clientId: string): Promise<OAuthClientRecord | null>;
  createAuthorizationRequest(input: {
    handleHash: string;
    clientId: string;
    redirectUri: string;
    scopes: OAuthScope[];
    resource: string;
    state: string | null;
    codeChallenge: string;
    now: Date;
    expiresAt: Date;
  }): Promise<void>;
  findAuthorizationRequest(handleHash: string): Promise<OAuthAuthorizationRequestRecord | null>;
  /**
   * Locks the account before the request row (the auth store's order), then
   * rechecks the account and the approving session so an overlapping account
   * revocation cannot be followed by new code authority from the old session.
   */
  decideAuthorizationRequest(input: {
    handleHash: string;
    userId: string;
    sessionTokenHash: string;
    decision: "approve" | "deny";
    now: Date;
    code?: { codeHash: string; expiresAt: Date };
    maxActiveGrantsPerUser: number;
    /** Policy flags only; assurance always comes from the locked session. */
    requireMfa?: boolean;
    requireFreshMfa?: boolean;
  }): Promise<DecideAuthorizationOutcome>;
  /**
   * One atomic transition: lock the code's account, then the code; consume
   * it, run the synchronous checks and, when they pass and the account is
   * active and under its connection cap, create the grant and first token
   * pair. A concurrent replay waits for the winner and then revokes the grant
   * it produced (RFC 6749 section 4.1.2).
   */
  redeemAuthorizationCode(input: {
    codeHash: string;
    now: Date;
    verify(code: OAuthAuthorizationCodeRecord): boolean;
    issue(code: OAuthAuthorizationCodeRecord): IssuedTokenPair;
    maxActiveGrantsPerUser: number;
  }): Promise<RedeemCodeOutcome>;
  findAccessToken(tokenHash: string): Promise<{ token: OAuthAccessTokenRecord; grant: OAuthGrantRecord } | null>;
  findRefreshToken(tokenHash: string): Promise<{ token: OAuthRefreshTokenRecord; grant: OAuthGrantRecord } | null>;
  rotateRefreshToken(input: {
    tokenHash: string;
    now: Date;
    accessToken: NewOAuthToken & { scopes: OAuthScope[] };
    refreshToken: NewOAuthToken;
  }): Promise<RotateRefreshOutcome>;
  touchGrant(input: { grantId: string; now: Date }): Promise<void>;
  revokeGrant(input: { grantId: string; reason: OAuthGrantRevocationReason; now: Date; userId?: string; clientId?: string }): Promise<OAuthGrantRecord | null>;
  revokeAccessToken(input: { tokenHash: string; clientId: string; now: Date }): Promise<boolean>;
  listActiveGrants(input: { userId: string; now: Date }): Promise<OAuthGrantRecord[]>;
  cleanup(now: Date): Promise<void>;
}
