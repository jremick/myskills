#!/usr/bin/env node

// Verifies that a deployed origin routes remote MCP OAuth traffic to the API
// and MCP services (not the SPA fallback) and that every public URL they
// advertise is consistent with the configured origin. Probes are anonymous
// and create no data: the authorization probe uses an unregistered client and
// the token probe carries no code or credential.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE_REDIRECT = "https://routing-probe.invalid/callback";

export async function checkMcpOAuthRouting({ origin, consentOrigin = origin, mcpPath = "/mcp", fetchImpl = fetch, timeoutMs = 10_000 }) {
  const base = normalizeOrigin(origin, "origin");
  const consent = normalizeOrigin(consentOrigin, "consent origin");
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(mcpPath) || mcpPath.endsWith("/")) throw new Error("mcp path must be an absolute path without a trailing slash.");
  const resource = `${base}${mcpPath}`;
  const metadataUrl = `${base}/.well-known/oauth-protected-resource${mcpPath}`;
  const results = [];
  const request = async (url, init = {}) => {
    const response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), ...init });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, json: parseJson(text) };
  };
  const check = async (name, run) => {
    try {
      const detail = await run();
      results.push({ name, ok: true, detail });
    } catch (error) {
      results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  await check("authorization server metadata reaches the API", async () => {
    const response = await request(`${base}/.well-known/oauth-authorization-server`);
    expectJson(response, 200);
    const metadata = response.json;
    expect(metadata.issuer === base, `issuer ${JSON.stringify(metadata.issuer)} does not equal ${base}`);
    for (const key of ["authorization_endpoint", "token_endpoint", "revocation_endpoint"]) {
      expect(typeof metadata[key] === "string" && metadata[key].startsWith(`${base}/oauth/`), `${key} is not under ${base}/oauth/`);
    }
    expect(JSON.stringify(metadata.code_challenge_methods_supported) === JSON.stringify(["S256"]), "only S256 PKCE must be advertised");
    expect(metadata.authorization_response_iss_parameter_supported === true, "iss response parameter must be advertised");
    return `issuer ${metadata.issuer}`;
  });

  await check("protected resource metadata reaches the MCP service", async () => {
    const response = await request(metadataUrl);
    expectJson(response, 200);
    expect(response.json.resource === resource, `resource ${JSON.stringify(response.json.resource)} does not equal ${resource}`);
    expect(Array.isArray(response.json.authorization_servers) && response.json.authorization_servers.includes(base), "authorization_servers must include the origin");
    return `resource ${response.json.resource}`;
  });

  await check("unauthenticated MCP requests receive a same-origin challenge", async () => {
    const response = await request(resource, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "routing-probe", version: "1" } } }),
    });
    expect(response.status === 401, `expected 401, received ${response.status}`);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge.includes(`resource_metadata="${metadataUrl}"`), `WWW-Authenticate does not name ${metadataUrl}`);
    return "401 with resource_metadata";
  });

  await check("authorization endpoint reaches the API and never redirects to an unregistered client", async () => {
    const query = new URLSearchParams({ response_type: "code", client_id: "routing-probe-unregistered", redirect_uri: PROBE_REDIRECT, code_challenge: "A".repeat(43), code_challenge_method: "S256" });
    const response = await request(`${base}/oauth/authorize?${query}`);
    expect(response.status === 302, `expected 302, received ${response.status}${isHtml(response) ? " HTML (SPA fallback?)" : ""}`);
    const location = new URL(response.headers.get("location") ?? "", base);
    expect(location.origin === consent && location.pathname === "/connect/authorize", `redirected to ${location.origin}${location.pathname}, not ${consent}/connect/authorize`);
    expect(location.searchParams.get("error") === "invalid_client", "unregistered client was not rejected");
    expect(!location.href.includes("routing-probe.invalid"), "redirected toward the unregistered redirect URI");
    return `302 to ${location.origin}${location.pathname}`;
  });

  await check("token endpoint reaches the API", async () => {
    const response = await request(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code",
    });
    expectJson(response, response.status);
    expect(response.status === 400 || response.status === 401, `expected 400 or 401, received ${response.status}`);
    expect(typeof response.json.error === "string", "token errors must use the OAuth error format");
    expect((response.headers.get("cache-control") ?? "").includes("no-store"), "token responses must be no-store");
    return `${response.status} ${response.json.error}`;
  });

  await check("consent page is served by the web app on the consent origin", async () => {
    const response = await request(`${consent}/connect/authorize`);
    expect(response.status === 200 && isHtml(response), `expected the SPA HTML, received ${response.status}`);
    return "200 HTML";
  });

  return { ok: results.every((result) => result.ok), origin: base, consentOrigin: consent, resource, results };
}

function normalizeOrigin(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error(`${label} must be an origin.`);
  return url.origin;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isHtml(response) {
  return (response.headers.get("content-type") ?? "").includes("text/html");
}

function expectJson(response, status) {
  expect(response.status === status, `expected ${status}, received ${response.status}`);
  expect(!isHtml(response) && response.json && typeof response.json === "object", "response is not JSON (SPA fallback or wrong upstream?)");
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--help" || key === "-h") return { help: true };
    if (!["--origin", "--consent-origin", "--mcp-path"].includes(key) || value === undefined) throw new Error(`Unknown or incomplete argument: ${key}`);
    options[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  return options;
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entrypoint === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.origin) {
    console.log("Usage: node scripts/check-mcp-oauth-routing.mjs --origin https://skills.example.com [--consent-origin https://...] [--mcp-path /mcp]");
    process.exit(options.help ? 0 : 1);
  }
  const report = await checkMcpOAuthRouting(options);
  for (const result of report.results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
  console.log(report.ok ? "Remote MCP OAuth routing check passed." : "Remote MCP OAuth routing check failed.");
  process.exit(report.ok ? 0 : 1);
}
