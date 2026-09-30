import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { checkMcpOAuthRouting } from "../check-mcp-oauth-routing.mjs";

// Local emulations of a reverse proxy only. These prove the checker's
// decisions, not any deployment.

test("routing check passes when OAuth and MCP paths reach their services on one origin", async (t) => {
  const origin = await serve(t, (base) => correctRoutes(base));
  const report = await checkMcpOAuthRouting({ origin });
  assert.equal(report.ok, true, JSON.stringify(report.results, null, 2));
  assert.equal(report.results.length, 6);
});

test("routing check fails when the SPA fallback answers OAuth and MCP paths", async (t) => {
  const origin = await serve(t, () => (_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><div id=root></div>");
  });
  const report = await checkMcpOAuthRouting({ origin });
  assert.equal(report.ok, false);
  const failed = report.results.filter((result) => !result.ok).map((result) => result.name);
  assert.equal(failed.length, 5, JSON.stringify(report.results, null, 2));
  assert.ok(report.results.find((result) => result.name.startsWith("consent page"))?.ok);
});

test("routing check fails when advertised URLs disagree with the public origin", async (t) => {
  const origin = await serve(t, (base) => correctRoutes(base, { issuer: "https://internal.example.test", resource: "http://mcp.internal:3002/mcp", unregisteredRedirect: true }));
  const report = await checkMcpOAuthRouting({ origin });
  assert.equal(report.ok, false);
  const failed = report.results.filter((result) => !result.ok).map((result) => result.name);
  assert.deepEqual(failed.sort(), [
    "authorization endpoint reaches the API and never redirects to an unregistered client",
    "authorization server metadata reaches the API",
    "protected resource metadata reaches the MCP service",
    "unauthenticated MCP requests receive a same-origin challenge",
  ].sort());
});

function correctRoutes(base, faults = {}) {
  return (request, response) => {
    const url = new URL(request.url, base);
    const json = (status, body, headers = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      const issuer = faults.issuer ?? base;
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        revocation_endpoint: `${issuer}/oauth/revoke`,
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      });
    }
    const resource = faults.resource ?? `${base}/mcp`;
    const metadata = `${new URL(resource).origin}/.well-known/oauth-protected-resource/mcp`;
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json(200, { resource, authorization_servers: [base] });
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      request.resume();
      return json(401, { jsonrpc: "2.0", error: { code: -32001, message: "auth" }, id: null }, { "www-authenticate": `Bearer resource_metadata="${metadata}", scope="skills:read"` });
    }
    if (url.pathname === "/oauth/authorize") {
      response.writeHead(302, { location: faults.unregisteredRedirect ? `${url.searchParams.get("redirect_uri")}?error=invalid_request` : `${base}/connect/authorize?error=invalid_client` });
      return response.end();
    }
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      request.resume();
      return json(401, { error: "invalid_client", error_description: "Client authentication failed." }, { "cache-control": "no-store" });
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><div id=root></div>");
  };
}

async function serve(t, handlerFor) {
  let base = "";
  const server = createServer((request, response) => handlerFor(base)(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}
