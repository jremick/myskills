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

function runPreflight(trustProxy: string) {
  return spawnSync(process.execPath, ["scripts/check-production-env.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
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
