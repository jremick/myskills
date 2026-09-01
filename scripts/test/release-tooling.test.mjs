import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { validateProductionComposePolicy } from "../production-compose-policy.mjs";

const validEnv = {
  NODE_ENV: "production",
  APP_BASE_URL: "https://skills.notexample.com",
  VITE_API_BASE_URL: "/api",
  ALLOWED_WEB_ORIGINS: "https://skills.notexample.com",
  TRUST_PROXY: "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7",
  DATABASE_URL: "postgres://myskills:strong-password@db.internal:5432/myskills",
  AUTH_SECRET: "production-auth-secret-at-least-32-bytes-long",
  AUTH_NOTIFICATION_MODE: "resend",
  RESEND_API_KEY: "re_public-safe-test-value",
  RESEND_FROM: "MySkills <noreply@notexample.com>",
  ARTIFACT_STORAGE_MODE: "s3",
  S3_BUCKET: "myskills-artifacts",
  S3_ENDPOINT: "https://storage.notexample.com",
};

test("production preflight accepts non-example domains and bounded trust proxy", () => {
  const result = runPreflight(validEnv);
  assert.equal(result.status, 0, result.stderr);
});

test("production preflight requires an explicit trust proxy decision", () => {
  const env = { ...validEnv };
  delete env.TRUST_PROXY;
  const result = runPreflight(env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TRUST_PROXY must be set explicitly/);
});

test("production preflight does not echo untrusted URL or proxy values", () => {
  const marker = "private-marker-that-must-not-be-logged";
  const result = runPreflight({
    ...validEnv,
    APP_BASE_URL: `http://localhost/${marker}`,
    ALLOWED_WEB_ORIGINS: `http://localhost/${marker}`,
    TRUST_PROXY: marker,
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(marker));
});

test("production Compose keeps address-aware proxy trust behind the private web ingress", () => {
  const compose = readFileSync(resolve("docker-compose.production.example.yml"), "utf8");
  const envTemplate = readFileSync(resolve(".env.production.example"), "utf8");
  assert.deepEqual(validateProductionComposePolicy(compose, envTemplate), []);

  const directlyPublished = compose.replace(
    '    expose:\n      - "3001"',
    '    ports:\n      - "${API_PORT:-3001}:3001"',
  );
  assert.match(
    validateProductionComposePolicy(directlyPublished, envTemplate).join("\n"),
    /keeps the API private/,
  );
});

test("full-stack E2E accepts MinIO credentials that begin with a hyphen", () => {
  const compose = readFileSync(resolve("docker-compose.e2e.yml"), "utf8");
  assert.match(
    compose,
    /mc alias set -- e2e http:\/\/minio:9000 "\$\$MINIO_ROOT_USER" "\$\$MINIO_ROOT_PASSWORD"/,
  );
});

test("full-stack E2E uses address-aware proxy trust", () => {
  const compose = readFileSync(resolve("docker-compose.e2e.yml"), "utf8");
  assert.match(compose, /TRUST_PROXY: "10\.0\.0\.0\/8,172\.16\.0\.0\/12,192\.168\.0\.0\/16,fc00::\/7"/);
  assert.doesNotMatch(compose, /TRUST_PROXY:\s*["']?[1-9]\d*["']?\s*$/m);
});

test("release artifact generation supports repeat verification with unique outputs", () => {
  const outputRoot = resolve("dist", `release-tooling-test-${randomUUID()}`);
  try {
    for (const suffix of ["first", "second"]) {
      const output = resolve(outputRoot, suffix);
      const result = spawnSync(process.execPath, [
        "scripts/create-release-artifacts.mjs",
        "--allow-dirty",
        "--out",
        output,
      ], { cwd: process.cwd(), encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(resolve(output, "release-metadata.json")), true);
      assert.equal(existsSync(resolve(output, "SHA256SUMS")), true);
    }
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

function runPreflight(env) {
  return spawnSync(process.execPath, ["scripts/check-production-env.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });
}
