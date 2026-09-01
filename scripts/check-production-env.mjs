#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";

const DEV_AUTH_SECRET = "dev-only-myskills-app-auth-secret-change-before-production";
const DEV_DATABASE_URL = "postgres://ai_skills_share:ai_skills_share_dev@localhost:5432/ai_skills_share";
const DEV_SEED_PASSWORD = "change-me-now-please";
const DEV_MINIO_SECRET = "myskills-app-dev";

const args = parseArgs(process.argv.slice(2));
const env = args.envFile ? { ...parseEnvFile(args.envFile) } : { ...process.env };
const errors = [];
const warnings = [];

requiredExact("NODE_ENV", "production");
requiredUrl("APP_BASE_URL", { https: true });
requiredUrlOrAbsolutePath("VITE_API_BASE_URL", { https: true });
rejectExampleValue("APP_BASE_URL");
rejectExampleValue("VITE_API_BASE_URL");
validateAllowedOrigins();
validateTrustProxy();
validateDatabase();
validateAuthSecret();
validateAuthNotifications();
validateArtifactStorage();
validateBootstrapSecrets();
validateMcp();

if (errors.length > 0) {
  console.error("Production environment check failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  if (warnings.length > 0) {
    console.error("");
    console.error("Warnings:");
    for (const warning of warnings) {
      console.error(`- ${warning}`);
    }
  }
  process.exit(1);
}

console.log("Production environment check passed.");
if (warnings.length > 0) {
  console.log("Warnings:");
  for (const warning of warnings) {
    console.log(`- ${warning}`);
  }
}

function parseArgs(input) {
  const parsed = { envFile: undefined, requireSeed: false };
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    if (arg === "--env-file") {
      const value = input[index + 1];
      if (!value) {
        throw new Error("--env-file requires a path.");
      }
      parsed.envFile = resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--require-seed") {
      parsed.requireSeed = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/check-production-env.mjs [--env-file .env.production] [--require-seed]");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function parseEnvFile(path) {
  const values = {};
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = stripInlineComment(line.slice(separator + 1).trim());
    values[key] = unquote(value);
  }
  return values;
}

function stripInlineComment(value) {
  if (value.startsWith("\"") || value.startsWith("'")) {
    return value;
  }
  const marker = value.indexOf(" #");
  return marker === -1 ? value : value.slice(0, marker).trimEnd();
}

function unquote(value) {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function requiredExact(name, expected) {
  const value = stringValue(name);
  if (value !== expected) {
    errors.push(`${name} must be ${expected}.`);
  }
}

function validateDatabase() {
  const value = requiredString("DATABASE_URL");
  if (!value) {
    return;
  }
  if (value.startsWith("replace-with-")) {
    errors.push("DATABASE_URL still contains an example placeholder.");
  }
  try {
    const url = new URL(value);
    const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (value === DEV_DATABASE_URL || databaseName === "ai_skills_share_dev") {
      errors.push("DATABASE_URL still uses the local development database credentials.");
    }
    if (!url.protocol.startsWith("postgres")) {
      errors.push("DATABASE_URL must use a postgres:// or postgresql:// URL.");
    }
    if (!url.username || !url.password) {
      warnings.push("DATABASE_URL has no username or password; confirm your deployment injects database credentials another way.");
    }
  } catch {
    errors.push("DATABASE_URL must be a valid URL.");
  }
}

function validateAuthSecret() {
  const value = requiredString("AUTH_SECRET");
  if (!value) {
    return;
  }
  if (value === DEV_AUTH_SECRET || value.startsWith("replace-with-")) {
    errors.push("AUTH_SECRET still uses a development/example value.");
  }
  if (Buffer.byteLength(value, "utf8") < 32) {
    errors.push("AUTH_SECRET must be at least 32 bytes.");
  }
}

function validateAllowedOrigins() {
  const appBaseUrl = stringValue("APP_BASE_URL");
  const origins = csv("ALLOWED_WEB_ORIGINS");
  if (origins.includes("*")) {
    errors.push("ALLOWED_WEB_ORIGINS must not contain '*'.");
  }
  for (const origin of origins) {
    validateUrlValue("ALLOWED_WEB_ORIGINS", origin, { https: true });
    rejectLocalUrl("ALLOWED_WEB_ORIGINS", origin);
    if (hasExampleDomain(origin)) {
      errors.push("ALLOWED_WEB_ORIGINS still uses an example placeholder.");
    }
  }
  if (appBaseUrl && origins.length > 0 && !origins.includes(appBaseUrl)) {
    warnings.push("ALLOWED_WEB_ORIGINS does not include APP_BASE_URL; browser auth flows may fail CORS.");
  }
}

function validateTrustProxy() {
  const value = stringValue("TRUST_PROXY");
  if (!value) {
    errors.push("TRUST_PROXY must be set explicitly to false or a trusted proxy address list.");
    return;
  }
  if (value === "true") {
    errors.push("TRUST_PROXY=true is too broad for production. Use a trusted proxy address list.");
    return;
  }
  if (value === "false") {
    warnings.push("TRUST_PROXY=false disables forwarded client IP handling behind proxies.");
    return;
  }
  if (/^[1-9]\d*$/.test(value)) {
    errors.push("TRUST_PROXY numeric hop counts are unsafe. Use a trusted proxy address list.");
    return;
  }
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    errors.push("TRUST_PROXY must be false or a comma-separated trusted proxy address list.");
    return;
  }
  for (const entry of entries) {
    if (!isValidProxyAddress(entry)) {
      errors.push("TRUST_PROXY contains an invalid proxy address entry.");
    }
  }
}

function isValidProxyAddress(entry) {
  const [address, prefix, extra] = entry.split("/");
  if (!address || extra !== undefined) {
    return false;
  }
  const version = isIP(address);
  if (version === 0) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  if (!/^\d+$/.test(prefix)) {
    return false;
  }
  const prefixLength = Number.parseInt(prefix, 10);
  return prefixLength >= 0 && prefixLength <= (version === 4 ? 32 : 128);
}

function validateAuthNotifications() {
  const mode = stringValue("AUTH_NOTIFICATION_MODE") || "smtp";
  if (mode !== "smtp" && mode !== "resend") {
    errors.push("AUTH_NOTIFICATION_MODE must be smtp or resend in production.");
    return;
  }
  if (mode === "resend") {
    requiredString("RESEND_API_KEY");
    requiredString("RESEND_FROM");
    rejectExampleValue("RESEND_API_KEY");
    rejectExampleValue("RESEND_FROM");
    return;
  }
  if (mode === "smtp") {
    requiredString("SMTP_HOST");
    requiredString("SMTP_FROM");
    rejectExampleValue("SMTP_HOST");
    rejectExampleValue("SMTP_FROM");
    if (stringValue("SMTP_TLS_REJECT_UNAUTHORIZED") === "false") {
      errors.push("SMTP_TLS_REJECT_UNAUTHORIZED=false is not allowed in production.");
    }
  }
}

function validateArtifactStorage() {
  const mode = stringValue("ARTIFACT_STORAGE_MODE") || "s3";
  if (mode !== "s3") {
    errors.push("ARTIFACT_STORAGE_MODE must be s3 in production.");
  }
  requiredString("S3_BUCKET");
  const accessKey = stringValue("S3_ACCESS_KEY_ID") || stringValue("MINIO_ROOT_USER");
  const secretKey = stringValue("S3_SECRET_ACCESS_KEY") || stringValue("MINIO_ROOT_PASSWORD");
  if (Boolean(accessKey) !== Boolean(secretKey)) {
    errors.push("S3 access key and secret key must be provided together.");
  }
  for (const [name, value] of [
    ["S3_ACCESS_KEY_ID", stringValue("S3_ACCESS_KEY_ID")],
    ["S3_SECRET_ACCESS_KEY", stringValue("S3_SECRET_ACCESS_KEY")],
    ["MINIO_ROOT_USER", stringValue("MINIO_ROOT_USER")],
    ["MINIO_ROOT_PASSWORD", stringValue("MINIO_ROOT_PASSWORD")],
  ]) {
    if (value === DEV_MINIO_SECRET || value?.startsWith("replace-with-")) {
      errors.push(`${name} still uses a development/example value.`);
    }
  }
  const endpoint = stringValue("S3_ENDPOINT");
  if (endpoint) {
    rejectLocalUrl("S3_ENDPOINT", endpoint);
    validateS3Endpoint(endpoint);
  }
}

function validateBootstrapSecrets() {
  const postgresPassword = stringValue("POSTGRES_PASSWORD");
  if (postgresPassword && (postgresPassword === DEV_MINIO_SECRET || postgresPassword.startsWith("replace-with-"))) {
    errors.push("POSTGRES_PASSWORD still uses a development/example value.");
  }
  if (args.requireSeed) {
    const email = requiredString("SEED_OWNER_EMAIL");
    if (email === "owner@example.com" || hasExampleDomain(email)) {
      errors.push("SEED_OWNER_EMAIL still uses an example placeholder.");
    }
    const password = requiredString("SEED_OWNER_PASSWORD");
    if (password && (password === DEV_SEED_PASSWORD || password.startsWith("replace-with-") || password.length < 16)) {
      errors.push("SEED_OWNER_PASSWORD must be a real bootstrap password of at least 16 characters.");
    }
    return;
  }
  if (stringValue("SEED_OWNER_EMAIL") === "owner@example.com") {
    warnings.push("SEED_OWNER_EMAIL is still the example owner address. Do not bootstrap production with this value.");
  }
  if (stringValue("SEED_OWNER_PASSWORD") === DEV_SEED_PASSWORD) {
    warnings.push("SEED_OWNER_PASSWORD is still the local default. Do not run the production seed command with this value.");
  }
}

function validateMcp() {
  const apiUrl = stringValue("MYSKILLS_API_URL");
  if (apiUrl) {
    rejectLocalUrl("MYSKILLS_API_URL", apiUrl);
  }
  const host = stringValue("MYSKILLS_MCP_HOST");
  if (host && !isLoopbackHost(host)) {
    const allowedHosts = csv("MYSKILLS_MCP_ALLOWED_HOSTS");
    if (allowedHosts.length === 0) {
      errors.push("MYSKILLS_MCP_ALLOWED_HOSTS is required when MYSKILLS_MCP_HOST is not loopback.");
    }
    if (allowedHosts.includes("*")) {
      errors.push("MYSKILLS_MCP_ALLOWED_HOSTS must not contain '*'.");
    }
  }
  for (const origin of csv("MYSKILLS_MCP_ALLOWED_ORIGINS")) {
    validateUrlValue("MYSKILLS_MCP_ALLOWED_ORIGINS", origin, { https: true });
    rejectLocalUrl("MYSKILLS_MCP_ALLOWED_ORIGINS", origin);
  }
}

function requiredUrl(name, options) {
  const value = requiredString(name);
  if (value) {
    validateUrlValue(name, value, options);
  }
}

function requiredUrlOrAbsolutePath(name, options) {
  const value = requiredString(name);
  if (!value) {
    return;
  }
  if (value.startsWith("/") && !value.startsWith("//")) {
    return;
  }
  validateUrlValue(name, value, options);
}

function validateS3Endpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push("S3_ENDPOINT must be a valid URL.");
    return;
  }
  if (url.protocol === "https:") {
    return;
  }
  if (url.protocol === "http:" && booleanValue("S3_ALLOW_INSECURE_ENDPOINT")) {
    warnings.push("S3_ALLOW_INSECURE_ENDPOINT=true is set; only use this for trusted private-network object storage.");
    return;
  }
  errors.push("S3_ENDPOINT must use https unless S3_ALLOW_INSECURE_ENDPOINT=true is set for trusted private-network object storage.");
}

function rejectExampleValue(name) {
  const value = stringValue(name);
  if (value.startsWith("replace-with-") || hasExampleDomain(value)) {
    errors.push(`${name} still uses an example placeholder.`);
  }
}

function hasExampleDomain(value) {
  try {
    return isExampleHostname(new URL(value).hostname);
  } catch {
    const emailDomain = value.match(/@([A-Za-z0-9.-]+)>?$/)?.[1];
    return emailDomain ? isExampleHostname(emailDomain) : isExampleHostname(value);
  }
}

function isExampleHostname(value) {
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  return hostname === "example.com" || hostname.endsWith(".example.com");
}

function rejectLocalUrl(name, value) {
  try {
    const url = new URL(value);
    if (isLoopbackHost(url.hostname)) {
      errors.push(`${name} must not use localhost or loopback in production.`);
    }
  } catch {
    return;
  }
}

function validateUrlValue(name, value, options) {
  try {
    const url = new URL(value);
    if (options.https && url.protocol !== "https:") {
      errors.push(`${name} must use https.`);
    }
  } catch {
    errors.push(`${name} must be a valid URL.`);
  }
}

function requiredString(name) {
  const value = stringValue(name);
  if (!value) {
    errors.push(`${name} is required.`);
    return "";
  }
  return value;
}

function stringValue(name) {
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

function booleanValue(name) {
  const value = stringValue(name).toLowerCase();
  if (!value) {
    return false;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  errors.push(`${name} must be true or false.`);
  return false;
}

function csv(name) {
  return stringValue(name).split(",").map((item) => item.trim()).filter(Boolean);
}

function isLoopbackHost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
