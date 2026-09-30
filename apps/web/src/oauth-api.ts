import { requestJson } from "./api.js";

export interface OAuthScopeDescription {
  scope: string;
  description: string;
  /** Server-owned classification; omitted only by older read-only servers. */
  readOnly?: boolean;
}

/** Public connector configuration. mcpUrl is null unless an operator configured it. */
export interface OAuthConnectorInfo {
  enabled: boolean;
  mcpUrl: string | null;
  issuer?: string;
  dynamicRegistration?: boolean;
  scopes?: OAuthScopeDescription[];
}

export interface OAuthAuthorizationDetails {
  client: {
    id: string;
    name: string;
    registration: "dynamic" | "configured";
    redirectUri: string;
    redirectOrigin: string;
  };
  scopes: OAuthScopeDescription[];
  resource: string;
  expiresAt: string;
  account: { email: string; mfaVerified: boolean };
  mfaRequired: boolean;
  /** Expiry derived from the actual approving session MFA event. */
  assuranceExpiresAt?: string | null;
}

export interface OAuthConnection {
  id: string;
  client: { id: string; name: string; registration: "dynamic" | "configured" };
  scopes: string[];
  resource: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
}

export interface OAuthConnectionClient {
  getConnector(): Promise<OAuthConnectorInfo>;
  inspectAuthorization(handle: string): Promise<OAuthAuthorizationDetails>;
  decideAuthorization(handle: string, decision: "approve" | "deny"): Promise<{ redirectTo: string }>;
  listConnections(): Promise<OAuthConnection[]>;
  revokeConnection(id: string): Promise<OAuthConnection>;
}

/** Same-origin session calls; the request handle travels in bodies, never in URLs. */
export function createOAuthConnectionClient(root: string, fetchImpl: typeof fetch, token?: string): OAuthConnectionClient {
  return {
    async getConnector() {
      return (await requestJson<{ connector: OAuthConnectorInfo }>(fetchImpl, `${root}/v1/oauth/connector`, { token })).connector;
    },
    async inspectAuthorization(handle) {
      return (await requestJson<{ authorization: OAuthAuthorizationDetails }>(fetchImpl, `${root}/v1/oauth/consent/inspect`, {
        method: "POST",
        body: { request: handle },
        token,
      })).authorization;
    },
    async decideAuthorization(handle, decision) {
      return requestJson<{ redirectTo: string }>(fetchImpl, `${root}/v1/oauth/consent/decision`, {
        method: "POST",
        body: { request: handle, decision },
        token,
      });
    },
    async listConnections() {
      return (await requestJson<{ connections: OAuthConnection[] }>(fetchImpl, `${root}/v1/oauth/connections`, { token })).connections;
    },
    async revokeConnection(id) {
      return (await requestJson<{ connection: OAuthConnection }>(fetchImpl, `${root}/v1/oauth/connections/${encodeURIComponent(id)}`, {
        method: "DELETE",
        token,
      })).connection;
    },
  };
}
