import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("production preflight validates TRUST_PROXY shapes", () => {
  for (const value of ["127.0.0.1", "10.0.0.0/8", "2001:db8::/32", "10.0.0.0/8,100.0.0.0/8"]) {
    const result = runPreflight(value);
    assert.equal(result.status, 0, `${value}: ${result.stderr}`);
  }

  const numeric = runPreflight("1");
  assert.notEqual(numeric.status, 0);
  assert.match(numeric.stderr, /numeric hop counts are unsafe/);

  const broad = runPreflight("true");
  assert.notEqual(broad.status, 0);
  assert.match(broad.stderr, /TRUST_PROXY=true is too broad/);

  const invalid = runPreflight("foo");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /invalid proxy address/);
});

test("production preflight fails closed for incomplete or unsafe remote MCP connection settings", () => {
  const enabled = {
    MYSKILLS_OAUTH_ENABLED: "true",
    MYSKILLS_OAUTH_ISSUER: "https://skills.example.test",
    MYSKILLS_MCP_PUBLIC_URL: "https://skills.example.test/mcp",
    MYSKILLS_OAUTH_DYNAMIC_REGISTRATION: "true",
    MYSKILLS_OAUTH_REDIRECT_HOSTS: "chatgpt.com,claude.ai",
  };
  assert.equal(runPreflight("10.0.0.0/8").status, 0, "remote connections stay optional");
  const ok = runPreflight("10.0.0.0/8", enabled);
  assert.equal(ok.status, 0, ok.stderr);
  for (const [label, patch, message] of [
    ["ambiguous flag", { MYSKILLS_OAUTH_ENABLED: "yes" }, /MYSKILLS_OAUTH_ENABLED must be true or false/],
    ["missing issuer", { MYSKILLS_OAUTH_ISSUER: undefined }, /MYSKILLS_OAUTH_ISSUER is required/],
    ["issuer path", { MYSKILLS_OAUTH_ISSUER: "https://skills.example.test/auth" }, /MYSKILLS_OAUTH_ISSUER must be an origin/],
    ["loopback issuer", { MYSKILLS_OAUTH_ISSUER: "http://127.0.0.1:43100" }, /MYSKILLS_OAUTH_ISSUER must use https/],
    ["plain http resource", { MYSKILLS_MCP_PUBLIC_URL: "http://skills.example.test/mcp" }, /MYSKILLS_MCP_PUBLIC_URL must use https/],
    ["resource without path", { MYSKILLS_MCP_PUBLIC_URL: "https://skills.example.test" }, /MYSKILLS_MCP_PUBLIC_URL must include the MCP endpoint path/],
    ["DCR without hosts", { MYSKILLS_OAUTH_REDIRECT_HOSTS: undefined }, /MYSKILLS_OAUTH_REDIRECT_HOSTS is required/],
    ["wildcard host", { MYSKILLS_OAUTH_REDIRECT_HOSTS: "*.example.test" }, /exact hostnames/],
    ["no registration path", { MYSKILLS_OAUTH_DYNAMIC_REGISTRATION: "false", MYSKILLS_OAUTH_REDIRECT_HOSTS: undefined }, /registration/],
  ] as const) {
    const result = runPreflight("10.0.0.0/8", { ...enabled, ...patch });
    assert.notEqual(result.status, 0, label);
    assert.match(result.stderr, message, label);
  }
  const partialMcp = runPreflight("10.0.0.0/8", { MYSKILLS_OAUTH_ISSUER: "https://skills.example.test" });
  assert.notEqual(partialMcp.status, 0);
  assert.match(partialMcp.stderr, /Set both MYSKILLS_OAUTH_ISSUER and MYSKILLS_MCP_PUBLIC_URL/);
});

function runPreflight(trustProxy: string, extra: Record<string, string | undefined> = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MYSKILLS_OAUTH_") && key !== "MYSKILLS_MCP_PUBLIC_URL"));
  const extraEnv = Object.fromEntries(Object.entries(extra).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return spawnSync(process.execPath, ["scripts/check-production-env.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...inherited,
      ...extraEnv,
      NODE_ENV: "production",
      APP_BASE_URL: "https://skills.example.test",
      ALLOWED_WEB_ORIGINS: "https://skills.example.test",
      TRUST_PROXY: trustProxy,
      VITE_API_BASE_URL: "/api",
      DATABASE_URL: "postgres://myskills:myskills-password@db.example.test:5432/myskills",
      AUTH_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef",
      AUTH_NOTIFICATION_MODE: "resend",
      RESEND_API_KEY: "re_test_0123456789",
      RESEND_FROM: "MySkills <noreply@example.test>",
      ARTIFACT_STORAGE_MODE: "s3",
      S3_REGION: "us-east-1",
      S3_BUCKET: "myskills-prod-test",
      S3_ACCESS_KEY_ID: "dummy-access-key",
      S3_SECRET_ACCESS_KEY: "dummy-secret-key",
    },
  });
}
