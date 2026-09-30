import { z } from "zod";
import { DYNAMIC_CLIENT_PREFIX } from "./tokens.js";

export interface OAuthConfiguredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  /** SHA-256 hex digest of the client secret; null for a public PKCE client. */
  clientSecretSha256: string | null;
}

export interface OAuthConfig {
  /** Public origin serving /.well-known/oauth-authorization-server and /oauth/*. */
  issuer: string;
  /** Public web origin serving /connect/authorize with the MySkills session. */
  consentOrigin: string;
  /** The one protected MCP resource that connector tokens are bound to. */
  resource: string;
  dynamicRegistration: boolean;
  redirectHosts: string[];
  clients: OAuthConfiguredClient[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  connectionTtlSeconds: number;
  authorizationRequestTtlSeconds: number;
  codeTtlSeconds: number;
  maxConnectionsPerUser: number;
  maxDynamicClients: number;
}

export const MAX_REDIRECT_URI_CHARS = 512;
const MAX_CONFIGURED_CLIENTS = 20;
const HOSTNAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

const configuredClientSchema = z.object({
  client_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/).refine((value) => !value.startsWith(DYNAMIC_CLIENT_PREFIX), "reserved client_id prefix"),
  client_name: z.string().trim().min(1).max(100).refine((value) => !CONTROL_CHARACTERS.test(value)),
  redirect_uris: z.array(z.string()).min(1).max(5),
  client_secret_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

/**
 * Remote MCP connections stay off unless explicitly enabled. When enabled,
 * every public URL must come from trusted configuration and an incomplete or
 * unsafe configuration throws so the API refuses to start.
 */
export function parseOAuthConfig(env: Record<string, string | undefined>): OAuthConfig | null {
  const enabled = parseBoolean(env.MYSKILLS_OAUTH_ENABLED, "MYSKILLS_OAUTH_ENABLED", false);
  if (!enabled) return null;
  const issuer = parsePublicOrigin(env.MYSKILLS_OAUTH_ISSUER, "MYSKILLS_OAUTH_ISSUER");
  const consentOrigin = parsePublicOrigin(env.MYSKILLS_OAUTH_CONSENT_ORIGIN ?? env.APP_BASE_URL, "MYSKILLS_OAUTH_CONSENT_ORIGIN or APP_BASE_URL");
  const resource = parseResourceUrl(env.MYSKILLS_MCP_PUBLIC_URL);
  const dynamicRegistration = parseBoolean(env.MYSKILLS_OAUTH_DYNAMIC_REGISTRATION, "MYSKILLS_OAUTH_DYNAMIC_REGISTRATION", false);
  const redirectHosts = parseRedirectHosts(env.MYSKILLS_OAUTH_REDIRECT_HOSTS);
  if (dynamicRegistration && redirectHosts.length === 0) {
    throw new Error("MYSKILLS_OAUTH_REDIRECT_HOSTS is required when dynamic client registration is enabled.");
  }
  const clients = parseConfiguredClients(env.MYSKILLS_OAUTH_CLIENTS);
  if (!dynamicRegistration && clients.length === 0) {
    throw new Error("Enable MYSKILLS_OAUTH_DYNAMIC_REGISTRATION or configure MYSKILLS_OAUTH_CLIENTS.");
  }
  return {
    issuer,
    consentOrigin,
    resource,
    dynamicRegistration,
    redirectHosts,
    clients,
    accessTokenTtlSeconds: 15 * 60,
    refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
    connectionTtlSeconds: 90 * 24 * 60 * 60,
    authorizationRequestTtlSeconds: 10 * 60,
    codeTtlSeconds: 60,
    maxConnectionsPerUser: 25,
    maxDynamicClients: 5_000,
  };
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Validates one exact redirect URI. Only HTTPS, or HTTP on a loopback host, is
 * accepted; wildcards, fragments and credentials never are. The value must be
 * in canonical URL form so exact string comparison cannot be ambiguous.
 */
export function validateRedirectUri(value: unknown, allowedHosts?: readonly string[]): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REDIRECT_URI_CHARS || value.includes("*") || value.includes("#")) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.href !== value || url.username || url.password) return null;
  const secure = url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname));
  if (!secure) return null;
  if (allowedHosts && !allowedHosts.includes(url.hostname.toLowerCase())) return null;
  return value;
}

/** Canonical form for RFC 8707 resource comparison. */
export function canonicalResource(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.search) return null;
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

function parseBoolean(value: string | undefined, name: string, fallback: boolean): boolean {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") return fallback;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function publicUrl(value: string | undefined, name: string): URL {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required when remote MCP connections are enabled.`);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (url.username || url.password || url.search || url.hash || trimmed.includes("?") || trimmed.includes("#")) {
    throw new Error(`${name} must not contain credentials, a query or a fragment.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    throw new Error(`${name} must use https (plain http is accepted only for loopback test stacks).`);
  }
  return url;
}

function parsePublicOrigin(value: string | undefined, name: string): string {
  const url = publicUrl(value, name);
  if (url.pathname !== "/") throw new Error(`${name} must be an origin without a path.`);
  return url.origin;
}

function parseResourceUrl(value: string | undefined): string {
  const url = publicUrl(value, "MYSKILLS_MCP_PUBLIC_URL");
  const path = url.pathname.replace(/\/+$/, "");
  if (!path) throw new Error("MYSKILLS_MCP_PUBLIC_URL must include the MCP endpoint path, such as /mcp.");
  return `${url.origin}${path}`;
}

function parseRedirectHosts(value: string | undefined): string[] {
  const hosts = (value ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  for (const host of hosts) {
    if (!HOSTNAME_PATTERN.test(host) && host !== "[::1]") {
      throw new Error("MYSKILLS_OAUTH_REDIRECT_HOSTS must list exact hostnames without wildcards, schemes or ports.");
    }
  }
  return [...new Set(hosts)];
}

function parseConfiguredClients(value: string | undefined): OAuthConfiguredClient[] {
  const trimmed = value?.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("MYSKILLS_OAUTH_CLIENTS must be a JSON array.");
  }
  const result = z.array(configuredClientSchema).max(MAX_CONFIGURED_CLIENTS).safeParse(parsed);
  if (!result.success) throw new Error("MYSKILLS_OAUTH_CLIENTS contains an invalid client.");
  const ids = new Set<string>();
  return result.data.map((client) => {
    if (ids.has(client.client_id)) throw new Error("MYSKILLS_OAUTH_CLIENTS contains a duplicate client_id.");
    ids.add(client.client_id);
    const redirectUris = client.redirect_uris.map((uri) => {
      const valid = validateRedirectUri(uri);
      if (!valid) throw new Error("MYSKILLS_OAUTH_CLIENTS contains an invalid redirect URI. Use exact https URLs without wildcards.");
      return valid;
    });
    return {
      clientId: client.client_id,
      clientName: client.client_name,
      redirectUris: [...new Set(redirectUris)],
      clientSecretSha256: client.client_secret_sha256 ?? null,
    };
  });
}
