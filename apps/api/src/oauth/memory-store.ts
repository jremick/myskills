import { randomUUID } from "node:crypto";
import { OAUTH_ASSURANCE_WINDOW_MS } from "./types.js";
import type { LinkedCredentialStore, MemoryAuthStore } from "../auth/memory-auth-store.js";
import type {
  DecideAuthorizationOutcome,
  OAuthAccessTokenRecord,
  OAuthAuthorizationCodeRecord,
  OAuthAuthorizationRequestRecord,
  OAuthClientRecord,
  OAuthGrantRecord,
  OAuthGrantRevocationReason,
  OAuthRefreshTokenRecord,
  OAuthStore,
  RedeemCodeOutcome,
  RotateRefreshOutcome,
} from "./types.js";

const UNUSED_DYNAMIC_CLIENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DECIDED_RECORD_RETENTION_MS = 24 * 60 * 60 * 1000;
const REVOKED_GRANT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface MemoryCode extends OAuthAuthorizationCodeRecord {
  codeHash: string;
  consumedAt: Date | null;
  replayedAt: Date | null;
  revokedAt: Date | null;
  grantId: string | null;
  createdAt: Date;
}

/**
 * In-memory connector authorization for tests and memory-backed development.
 * Each single-use transition completes synchronously, so concurrent requests
 * observe the same outcomes as the Postgres row-level updates.
 */
export class MemoryOAuthStore implements OAuthStore, LinkedCredentialStore {
  private clients = new Map<string, OAuthClientRecord>();
  private requests = new Map<string, OAuthAuthorizationRequestRecord & { decidedAt: Date | null }>();
  private codes = new Map<string, MemoryCode>();
  private grants = new Map<string, OAuthGrantRecord>();
  private accessTokens = new Map<string, OAuthAccessTokenRecord>();
  private refreshTokens = new Map<string, OAuthRefreshTokenRecord>();

  constructor(private readonly authStore?: MemoryAuthStore) {
    authStore?.linkCredentialStore(this);
  }

  async createDynamicClient(input: Parameters<OAuthStore["createDynamicClient"]>[0]): Promise<OAuthClientRecord | null> {
    if (this.clients.size >= input.maxClients) return null;
    const record: OAuthClientRecord = { ...input.client, redirectUris: [...input.client.redirectUris], registration: "dynamic", createdAt: input.now };
    this.clients.set(record.clientId, record);
    return clone(record);
  }

  async findDynamicClient(clientId: string): Promise<OAuthClientRecord | null> {
    const client = this.clients.get(clientId);
    return client ? clone(client) : null;
  }

  async createAuthorizationRequest(input: Parameters<OAuthStore["createAuthorizationRequest"]>[0]): Promise<void> {
    this.requests.set(input.handleHash, {
      id: randomUUID(),
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      scopes: [...input.scopes],
      resource: input.resource,
      state: input.state,
      codeChallenge: input.codeChallenge,
      status: "pending",
      userId: null,
      createdAt: input.now,
      expiresAt: input.expiresAt,
      decidedAt: null,
    });
  }

  async findAuthorizationRequest(handleHash: string): Promise<OAuthAuthorizationRequestRecord | null> {
    const request = this.requests.get(handleHash);
    return request ? publicRequest(request) : null;
  }

  async decideAuthorizationRequest(input: Parameters<OAuthStore["decideAuthorizationRequest"]>[0]): Promise<DecideAuthorizationOutcome> {
    if (this.authStore && (!this.authStore.isUsableAccountSync(input.userId) || !this.authStore.hasActiveSessionSync(input.sessionTokenHash, input.userId, input.now))) {
      return { outcome: "session_revoked" };
    }
    const request = this.requests.get(input.handleHash);
    if (!request) return { outcome: "not_found" };
    if (request.status !== "pending") return { outcome: "already_decided" };
    if (request.expiresAt <= input.now) return { outcome: "expired" };
    const stamp = this.authStore?.activeSessionMfaVerifiedAtSync(input.sessionTokenHash, input.userId, input.now) ?? null;
    const mfaVerifiedAt = stamp && Number.isFinite(stamp.getTime()) && stamp <= input.now ? stamp : null;
    const assuranceExpiresAt = mfaVerifiedAt ? new Date(mfaVerifiedAt.getTime() + OAUTH_ASSURANCE_WINDOW_MS) : null;
    if (input.decision === "approve" && ((input.requireMfa && !mfaVerifiedAt)
      || (input.requireFreshMfa && (!assuranceExpiresAt || assuranceExpiresAt <= input.now)))) {
      return { outcome: "mfa_required" };
    }
    if (input.decision === "approve") {
      const active = [...this.grants.values()].filter((grant) => grant.userId === input.userId && isActiveGrant(grant, input.now)).length;
      if (active >= input.maxActiveGrantsPerUser) return { outcome: "connection_limit" };
    }
    request.status = input.decision === "approve" ? "approved" : "denied";
    request.userId = input.userId;
    request.decidedAt = input.now;
    if (input.decision === "approve" && input.code) {
      this.codes.set(input.code.codeHash, {
        id: randomUUID(),
        codeHash: input.code.codeHash,
        userId: input.userId,
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        resource: request.resource,
        scopes: [...request.scopes],
        expiresAt: input.code.expiresAt,
        consumedAt: null,
        replayedAt: null,
        revokedAt: null,
        grantId: null,
        createdAt: input.now,
        mfaVerifiedAt,
        assuranceExpiresAt,
      });
    }
    return { outcome: "decided", request: publicRequest(request) };
  }

  async redeemAuthorizationCode(input: Parameters<OAuthStore["redeemAuthorizationCode"]>[0]): Promise<RedeemCodeOutcome> {
    // Synchronous from lookup to issuance: no interleaving request can observe
    // a consumed code whose grant does not exist yet.
    const code = this.codes.get(input.codeHash);
    if (!code || code.revokedAt) return { outcome: "invalid" };
    if (code.consumedAt) {
      code.replayedAt ??= input.now;
      const grant = code.grantId ? this.grants.get(code.grantId) : undefined;
      if (grant && !grant.revokedAt) {
        grant.revokedAt = input.now;
        grant.revokedReason = "code_replay";
        return { outcome: "replayed", revokedGrant: clone(grant) };
      }
      return { outcome: "replayed", revokedGrant: null };
    }
    code.consumedAt = input.now;
    const record = publicCode(code);
    if (!input.verify(record)) return { outcome: "rejected" };
    if (this.authStore && !this.authStore.isUsableAccountSync(record.userId)) return { outcome: "invalid" };
    const active = [...this.grants.values()].filter((grant) => grant.userId === record.userId && isActiveGrant(grant, input.now)).length;
    if (active >= input.maxActiveGrantsPerUser) return { outcome: "connection_limit" };
    const issued = input.issue(record);
    const grant: OAuthGrantRecord = {
      ...issued.grant, scopes: [...issued.grant.scopes], id: randomUUID(), lastUsedAt: null, revokedAt: null, revokedReason: null,
      mfaVerifiedAt: record.mfaVerifiedAt, assuranceExpiresAt: record.assuranceExpiresAt,
    };
    this.grants.set(grant.id, grant);
    code.grantId = grant.id;
    this.accessTokens.set(issued.accessToken.tokenHash, { id: randomUUID(), grantId: grant.id, scopes: [...issued.accessToken.scopes], expiresAt: issued.accessToken.expiresAt, revokedAt: null });
    this.refreshTokens.set(issued.refreshToken.tokenHash, { id: randomUUID(), grantId: grant.id, expiresAt: issued.refreshToken.expiresAt, usedAt: null, revokedAt: null });
    return { outcome: "issued", grant: clone(grant), code: record };
  }

  async findAccessToken(tokenHash: string) {
    const token = this.accessTokens.get(tokenHash);
    const grant = token ? this.grants.get(token.grantId) : undefined;
    return token && grant ? { token: clone(token), grant: clone(grant) } : null;
  }

  async findRefreshToken(tokenHash: string) {
    const token = this.refreshTokens.get(tokenHash);
    const grant = token ? this.grants.get(token.grantId) : undefined;
    return token && grant ? { token: clone(token), grant: clone(grant) } : null;
  }

  async rotateRefreshToken(input: Parameters<OAuthStore["rotateRefreshToken"]>[0]): Promise<RotateRefreshOutcome> {
    const token = this.refreshTokens.get(input.tokenHash);
    if (!token) return { outcome: "invalid" };
    if (token.usedAt) return { outcome: "reused", grantId: token.grantId };
    const grant = this.grants.get(token.grantId);
    if (!grant || token.revokedAt || token.expiresAt <= input.now || !isActiveGrant(grant, input.now)) return { outcome: "invalid" };
    token.usedAt = input.now;
    this.accessTokens.set(input.accessToken.tokenHash, { id: randomUUID(), grantId: grant.id, scopes: [...input.accessToken.scopes], expiresAt: input.accessToken.expiresAt, revokedAt: null });
    this.refreshTokens.set(input.refreshToken.tokenHash, { id: randomUUID(), grantId: grant.id, expiresAt: input.refreshToken.expiresAt, usedAt: null, revokedAt: null });
    return { outcome: "rotated", grant: clone(grant) };
  }

  async touchGrant(input: { grantId: string; now: Date }): Promise<void> {
    const grant = this.grants.get(input.grantId);
    if (grant && !grant.revokedAt) grant.lastUsedAt = input.now;
  }

  async revokeGrant(input: { grantId: string; reason: OAuthGrantRevocationReason; now: Date; userId?: string; clientId?: string }): Promise<OAuthGrantRecord | null> {
    const grant = this.grants.get(input.grantId);
    if (!grant || grant.revokedAt || (input.userId && grant.userId !== input.userId) || (input.clientId && grant.clientId !== input.clientId)) return null;
    grant.revokedAt = input.now;
    grant.revokedReason = input.reason;
    return clone(grant);
  }

  async revokeAccessToken(input: { tokenHash: string; clientId: string; now: Date }): Promise<boolean> {
    const token = this.accessTokens.get(input.tokenHash);
    const grant = token ? this.grants.get(token.grantId) : undefined;
    if (!token || !grant || grant.clientId !== input.clientId || token.revokedAt) return false;
    token.revokedAt = input.now;
    return true;
  }

  async listActiveGrants(input: { userId: string; now: Date }): Promise<OAuthGrantRecord[]> {
    return [...this.grants.values()]
      .filter((grant) => grant.userId === input.userId && isActiveGrant(grant, input.now))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(clone);
  }

  async cleanup(now: Date): Promise<void> {
    const cutoff = now.getTime() - DECIDED_RECORD_RETENTION_MS;
    for (const [hash, request] of this.requests) {
      if (request.expiresAt.getTime() <= cutoff || (request.expiresAt <= now && request.status === "pending")) this.requests.delete(hash);
    }
    for (const [hash, code] of this.codes) {
      if (code.expiresAt <= now && (code.consumedAt === null || code.expiresAt.getTime() <= cutoff)) this.codes.delete(hash);
    }
    for (const [hash, token] of this.accessTokens) {
      if (token.expiresAt <= now) this.accessTokens.delete(hash);
    }
    for (const [hash, token] of this.refreshTokens) {
      if (token.expiresAt <= now) this.refreshTokens.delete(hash);
    }
    const grantCutoff = now.getTime() - REVOKED_GRANT_RETENTION_MS;
    for (const [id, grant] of this.grants) {
      if ((grant.revokedAt && grant.revokedAt.getTime() <= grantCutoff) || grant.expiresAt.getTime() <= grantCutoff) {
        this.grants.delete(id);
        for (const [hash, token] of this.accessTokens) if (token.grantId === id) this.accessTokens.delete(hash);
        for (const [hash, token] of this.refreshTokens) if (token.grantId === id) this.refreshTokens.delete(hash);
      }
    }
    const unusedCutoff = now.getTime() - UNUSED_DYNAMIC_CLIENT_RETENTION_MS;
    const referenced = new Set([
      ...[...this.grants.values()].map((grant) => grant.clientId),
      ...[...this.codes.values()].filter((code) => !code.consumedAt && code.expiresAt > now).map((code) => code.clientId),
    ]);
    for (const [clientId, client] of this.clients) {
      if (client.createdAt.getTime() <= unusedCutoff && !referenced.has(clientId)) this.clients.delete(clientId);
    }
  }

  revokeUserCredentials(userId: string, revokedAt: Date): void {
    for (const grant of this.grants.values()) {
      if (grant.userId === userId && !grant.revokedAt) {
        grant.revokedAt = revokedAt;
        grant.revokedReason = "account";
      }
    }
    // Approved but unredeemed codes carry the same account authority.
    for (const code of this.codes.values()) {
      if (code.userId === userId && !code.consumedAt && !code.revokedAt) code.revokedAt = revokedAt;
    }
  }

  snapshotUserCredentials(userId: string): unknown {
    return {
      grants: [...this.grants.values()]
        .filter((grant) => grant.userId === userId)
        .map((grant) => ({ id: grant.id, revokedAt: grant.revokedAt, revokedReason: grant.revokedReason })),
      codes: [...this.codes.entries()]
        .filter(([, code]) => code.userId === userId)
        .map(([hash, code]) => ({ hash, revokedAt: code.revokedAt })),
    };
  }

  restoreUserCredentials(snapshot: unknown): void {
    const state = snapshot as {
      grants: Array<{ id: string; revokedAt: Date | null; revokedReason: OAuthGrantRevocationReason | null }>;
      codes: Array<{ hash: string; revokedAt: Date | null }>;
    };
    for (const entry of state.grants) {
      const grant = this.grants.get(entry.id);
      if (grant) {
        grant.revokedAt = entry.revokedAt;
        grant.revokedReason = entry.revokedReason;
      }
    }
    for (const entry of state.codes) {
      const code = this.codes.get(entry.hash);
      if (code) code.revokedAt = entry.revokedAt;
    }
  }
}

function publicCode(code: MemoryCode): OAuthAuthorizationCodeRecord {
  return {
    id: code.id,
    userId: code.userId,
    clientId: code.clientId,
    redirectUri: code.redirectUri,
    codeChallenge: code.codeChallenge,
    resource: code.resource,
    scopes: [...code.scopes],
    expiresAt: code.expiresAt,
    mfaVerifiedAt: code.mfaVerifiedAt ?? null,
    assuranceExpiresAt: code.assuranceExpiresAt ?? null,
  };
}

function isActiveGrant(grant: OAuthGrantRecord, now: Date): boolean {
  return !grant.revokedAt && grant.expiresAt > now;
}

function publicRequest(request: OAuthAuthorizationRequestRecord & { decidedAt: Date | null }): OAuthAuthorizationRequestRecord {
  const { decidedAt: _decidedAt, ...record } = request;
  return clone(record);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
