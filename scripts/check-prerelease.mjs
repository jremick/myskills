#!/usr/bin/env node

import { accessSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  hasBlockingFindings,
  parseSkillManifest,
  scanTextForPackageRisks,
} from "../packages/skill-package/dist/index.js";
import { validateProductionComposePolicy } from "./production-compose-policy.mjs";

const root = process.cwd();
const failures = [];
const supportedNodeRange = ">=22.13 <23 || >=24 <25";
const packagePaths = listPackagePaths();
const packages = packagePaths.map((path) => ({ path, manifest: readJson(path) })).filter(({ manifest }) => manifest);
const rootPackage = packages.find(({ path }) => path === "package.json")?.manifest;
const version = String(rootPackage?.version ?? "");
const expectedTag = `v${version}`;
const expectedNpmTag = version.match(/-(alpha|beta|rc)(?:\.|$)/)?.[1];

const requiredPaths = [
  "LICENSE",
  "SECURITY.md",
  "SUPPORT.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "docs/GETTING_STARTED.md",
  "docs/ALPHA_RELEASE_GOAL.md",
  "docs/BETA_RELEASE_GOAL.md",
  "docs/BUSINESS_SAFE_RELEASE_GOAL.md",
  "docs/CODEX_CLOUD.md",
  "docs/COMPATIBILITY.md",
  "docs/API_MCP_CLI_PLAN.md",
  "docs/ARCHITECTURE.md",
  "docs/DATA_MODEL.md",
  "docs/DESIGN_SYSTEM.md",
  "docs/PRODUCT_BRIEF.md",
  "docs/RAILWAY_DEPLOYMENT.md",
  "docs/RELEASE.md",
  "docs/ROADMAP.md",
  "docs/THREAT_MODEL.md",
  "docs/UPGRADE_POLICY.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/pull_request_template.md",
  "examples/skills/release-notes-helper/skill.json",
  "examples/skills/release-notes-helper/README.md",
  "examples/skills/release-notes-helper/SKILL.md",
];

const policyFiles = [
  "README.md",
  "apps/api/README.md",
  "apps/cli/README.md",
  "apps/mcp/README.md",
  "apps/web/README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "docs/GETTING_STARTED.md",
  "docs/BETA_RELEASE_GOAL.md",
  "docs/BUSINESS_SAFE_RELEASE_GOAL.md",
  "docs/CODEX_CLOUD.md",
  "docs/COMPATIBILITY.md",
  "docs/DEPLOYMENT.md",
  "docs/API_MCP_CLI_PLAN.md",
  "docs/ARCHITECTURE.md",
  "docs/DATA_MODEL.md",
  "docs/DESIGN_SYSTEM.md",
  "docs/PRODUCT_BRIEF.md",
  "docs/RAILWAY_DEPLOYMENT.md",
  "docs/RELEASE.md",
  "docs/ROADMAP.md",
  "docs/SECURITY_MODEL.md",
  "docs/THREAT_MODEL.md",
  "docs/UPGRADE_POLICY.md",
];

const forbiddenPolicyPhrases = [
  /not public yet/i,
  /private while the core architecture/i,
  /will be finalized before public release/i,
  /repo is not ready for a public release/i,
  /current alpha controls/i,
  /current alpha repository/i,
  /first public private-development launch/i,
  /private-development deployment currently/i,
  /^## Public Alpha Install$/im,
  ...[
    ["check:alpha", "-release"],
    ["check-alpha", "-release"],
    ["deterministic alpha", "-release check"],
  ].map((parts) => new RegExp(escapeRegExp(parts.join("")), "i")),
];

const forbiddenExamplePhrases = [
  [0x61, 0x78, 0x6f, 0x6e],
  [0x6a, 0x6f, 0x6e, 0x61, 0x73],
  [0x63, 0x6f, 0x6e, 0x66, 0x6c, 0x75, 0x65, 0x6e, 0x63, 0x65],
].map((codes) => new RegExp(`\\b${String.fromCharCode(...codes)}\\b`, "i"));

for (const path of requiredPaths) assertPath(path);

checkVersionCoherence();
checkLocalEnvLoading();
checkPublicPackages();
checkCapabilityVersion();
checkReleaseMarkers();
checkPolicyLanguageAndLinks();
checkWorkflowContracts();
checkImplementationInvariants();
checkExamples();

if (failures.length > 0) {
  console.error("Prerelease check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Prerelease check passed for ${expectedTag}.`);
console.log(`Verified ${packages.length} package manifests, ${policyFiles.length} policy/docs files, and ${requiredPaths.length} required paths.`);

function checkVersionCoherence() {
  if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(version)) {
    failures.push(`Root package version ${JSON.stringify(version)} is not a beta prerelease version.`);
  }
  if (rootPackage?.engines?.node !== supportedNodeRange) {
    failures.push(`Root engines.node must be ${JSON.stringify(supportedNodeRange)}.`);
  }
  if (!/^npm@\d+\.\d+\.\d+$/.test(String(rootPackage?.packageManager ?? ""))) {
    failures.push("Root packageManager must pin an exact npm version.");
  }

  const workspaceByName = new Map(packages.slice(1).map(({ manifest }) => [manifest.name, manifest]));
  for (const { path, manifest } of packages) {
    if (manifest.version !== version) {
      failures.push(`${path} version ${JSON.stringify(manifest.version)} does not match root version ${version}.`);
    }
    if (manifest.license !== "Apache-2.0") {
      failures.push(`${path} must declare license Apache-2.0.`);
    }
    for (const group of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, specifier] of Object.entries(manifest[group] ?? {})) {
        if (workspaceByName.has(name) && specifier !== version) {
          failures.push(`${path} ${group}.${name} must match workspace version ${version}; received ${specifier}.`);
        }
      }
    }
  }
}

function checkLocalEnvLoading() {
  const expectedScripts = new Map([
    ["@myskills-app/api", ["db:migrate", "db:seed", "dev", "start"]],
    ["@myskills-app/web", ["dev", "preview"]],
    ["@myskills-app/mcp", ["dev", "dev:http", "start", "start:http"]],
  ]);
  for (const [name, scriptNames] of expectedScripts) {
    const workspace = packages.find(({ manifest }) => manifest.name === name);
    if (!workspace) {
      failures.push(`Workspace ${name} is missing.`);
      continue;
    }
    for (const scriptName of scriptNames) {
      const command = workspace.manifest.scripts?.[scriptName];
      if (!String(command ?? "").includes("--env-file-if-exists=../../.env")) {
        failures.push(`${workspace.path} scripts.${scriptName} must load the repository-root .env through Node.`);
      }
    }
  }

  const envTemplate = readText(".env.example") ?? "";
  for (const name of ["DATABASE_URL", "VITE_API_BASE_URL", "MYSKILLS_API_URL", "MYSKILLS_TOKEN", "SEED_OWNER_EMAIL", "SEED_OWNER_PASSWORD"]) {
    if (!new RegExp(`^${name}=`, "m").test(envTemplate)) failures.push(`.env.example must declare ${name}.`);
  }
  assertContains("docs/GETTING_STARTED.md", "cp .env.example .env");
  assertContains("docs/GETTING_STARTED.md", "No shell-specific `source`");
}

function checkPublicPackages() {
  const workspaceByName = new Map(packages.slice(1).map(({ manifest, path }) => [manifest.name, { manifest, path }]));
  const publicPackages = packages.filter(({ manifest }) => manifest.private === false);
  if (publicPackages.length === 0) failures.push("No public package manifest is declared.");

  for (const { path, manifest } of publicPackages) {
    if (manifest.engines?.node !== supportedNodeRange) {
      failures.push(`${path} engines.node must be ${JSON.stringify(supportedNodeRange)}.`);
    }
    if (manifest.name === "@jarel/myskills") {
      const actualFiles = [...(manifest.files ?? [])].sort();
      const expectedFiles = ["README.md", "dist/index.js"].sort();
      if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
        failures.push(`${path} files must allowlist only README.md and dist/index.js.`);
      }
      if (!expectedNpmTag || manifest.publishConfig?.tag !== expectedNpmTag) {
        failures.push(`${path} publishConfig.tag must match prerelease channel ${JSON.stringify(expectedNpmTag)}.`);
      }
    }

    for (const group of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, specifier] of Object.entries(manifest[group] ?? {})) {
        if (/^(?:file|link|workspace):/.test(String(specifier))) {
          failures.push(`${path} public ${group}.${name} uses non-publishable specifier ${specifier}.`);
        }
        const workspace = workspaceByName.get(name);
        if (workspace && workspace.manifest.private !== false) {
          failures.push(`${path} public runtime dependency ${name} points at private workspace ${workspace.path}.`);
        }
      }
    }
  }
}

function checkCapabilityVersion() {
  const versionSourcePath = "apps/api/src/version.ts";
  const versionSource = readText(versionSourcePath) ?? "";
  if (!/require\(["']\.\.\/\.\.\/\.\.\/package\.json["']\)/.test(versionSource)
      || !/export\s+const\s+API_VERSION\s*=\s*metadata\.version/.test(versionSource)) {
    failures.push(`${versionSourcePath} must derive API_VERSION from the root package manifest.`);
  }

  const appSourcePath = "apps/api/src/app.ts";
  const appSource = readText(appSourcePath) ?? "";
  if (!/import\s*\{\s*API_VERSION\s*\}\s*from\s*["']\.\/version\.js["']/.test(appSource)
      || !/version:\s*API_VERSION/.test(appSource)) {
    failures.push(`${appSourcePath} must expose the shared API_VERSION in /v1/capabilities.`);
  }
}

function checkReleaseMarkers() {
  assertContains("README.md", `Current target: **${expectedTag}**.`);
  assertContains("CHANGELOG.md", `Target release: \`${expectedTag}\`.`);
  assertContains("docs/BETA_RELEASE_GOAL.md", `Target release: \`${expectedTag}\`.`);
  assertContains("docs/BETA_RELEASE_GOAL.md", "npm run release:verify");
  assertContains("docs/RELEASE.md", "npm run release:verify");
  assertContains("docs/RELEASE.md", "## Approval Boundary");
  assertContains("docs/RELEASE.md", "## Rollback");

  for (const path of [
    "docs/API_MCP_CLI_PLAN.md",
    "docs/ARCHITECTURE.md",
    "docs/BETA_RELEASE_GOAL.md",
    "docs/CODEX_CLOUD.md",
    "docs/COMPATIBILITY.md",
    "docs/DATA_MODEL.md",
    "docs/DESIGN_SYSTEM.md",
    "docs/PRODUCT_BRIEF.md",
    "docs/RAILWAY_DEPLOYMENT.md",
    "docs/RELEASE.md",
    "docs/ROADMAP.md",
  ]) {
    assertContains(path, `Version: ${version}`);
  }
}

function checkPolicyLanguageAndLinks() {
  for (const path of policyFiles) {
    const text = readText(path);
    if (text === null) continue;
    for (const phrase of forbiddenPolicyPhrases) {
      if (phrase.test(text)) failures.push(`${path} contains stale maturity language matching ${phrase}.`);
    }
    checkLocalMarkdownLinks(path, text);
  }
}

function checkWorkflowContracts() {
  const ci = readText(".github/workflows/ci.yml") ?? "";
  for (const expected of ["22.x", "24.x", "npm run check", "npm run test:e2e:fullstack", "needs: [check-supported-node, railway-images, web-e2e, postgres-integration]"]) {
    if (!ci.includes(expected)) failures.push(`.github/workflows/ci.yml must include ${JSON.stringify(expected)}.`);
  }
  for (const expected of ["needs.check-supported-node.result", "needs.railway-images.result", "needs.web-e2e.result", "needs.postgres-integration.result"]) {
    if (!ci.includes(expected)) failures.push(`.github/workflows/ci.yml aggregate check must inspect ${JSON.stringify(expected)}.`);
  }

  const release = readText(".github/workflows/release.yml") ?? "";
  for (const expected of ["fetch-depth: 0", "merge-base --is-ancestor", "npm run release:verify"]) {
    if (!release.includes(expected)) failures.push(`.github/workflows/release.yml must include ${JSON.stringify(expected)}.`);
  }
  if (/\b(?:npm\s+publish|gh\s+release\s+create|docker\s+push)\b/.test(release)) {
    failures.push("Release verification workflow must not publish npm packages, GitHub Releases, or container images.");
  }

  const installDeclaredNpm = `npm install -g "$(node -p 'require("./package.json").packageManager')"`;
  for (const [path, workflow] of [
    [".github/workflows/ci.yml", ci],
    [".github/workflows/release.yml", release],
  ]) {
    if (!workflow.includes(installDeclaredNpm)) {
      failures.push(`${path} must install the declared npm version without passing escaped quotes to node -p.`);
    }
    if (workflow.includes(String.raw`require(\"./package.json\")`)) {
      failures.push(`${path} must not escape package.json quotes inside the shell's single-quoted node -p expression.`);
    }
  }

  for (const [path, workflow] of [
    [".github/workflows/ci.yml", ci],
    [".github/workflows/release.yml", release],
  ]) {
    for (const dockerfile of ["Dockerfile.api", "Dockerfile.web"]) {
      if (!workflow.includes(`docker build --file ${dockerfile}`)) {
        failures.push(`${path} must build the live Railway image from ${dockerfile}.`);
      }
    }
  }
}

function checkImplementationInvariants() {
  const apiSource = readText("apps/api/src/app.ts") ?? "";
  for (const expected of ["app.addHook(\"onRequest\"", "requestLimiter", "API_RATE_LIMITED"]) {
    if (!apiSource.includes(expected)) failures.push(`apps/api/src/app.ts must retain the global request-limit invariant ${JSON.stringify(expected)}.`);
  }

  const nginx = readText("deploy/nginx.railway.conf.template") ?? "";
  if (!nginx.includes("client_max_body_size 14m;")) {
    failures.push("deploy/nginx.railway.conf.template must accept the API's bounded 14 MiB submission request envelope.");
  }

  const productionCompose = readText("docker-compose.production.example.yml") ?? "";
  if (!productionCompose.includes("http://127.0.0.1:3001/ready")) {
    failures.push("docker-compose.production.example.yml API healthcheck must use dependency-aware /ready.");
  }
  const productionEnvTemplate = readText(".env.production.example") ?? "";
  for (const error of validateProductionComposePolicy(productionCompose, productionEnvTemplate)) {
    failures.push(error);
  }

  const mcpHttpSource = readText("apps/mcp/src/http.ts") ?? "";
  for (const expected of ["new BoundedIpRateLimiter", "options.rateLimiter.consume", "sendPreBodyJsonRpcError(request, response, 429"]) {
    if (!mcpHttpSource.includes(expected)) failures.push(`apps/mcp/src/http.ts must retain the bounded request-limit invariant ${JSON.stringify(expected)}.`);
  }
  const mcpHttpTests = readText("apps/mcp/test/http.test.ts") ?? "";
  for (const expected of [
    "rate limits by socket IP by default and preserves health",
    "only trusts forwarded client IPs when proxy hops are explicit",
    "assert.equal(limited.status, 429)",
  ]) {
    if (!mcpHttpTests.includes(expected)) failures.push(`apps/mcp/test/http.test.ts must retain the MCP limiter proof ${JSON.stringify(expected)}.`);
  }

  const applicationSourceFiles = readdirSync(resolve(root, "apps"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => listFiles(resolve(root, "apps", entry.name, "src")))
    .filter((path) => /\.[cm]?tsx?$/.test(path));
  const nodeHttpServers = applicationSourceFiles
    .filter((path) => readFileSync(path, "utf8").includes("createServer("))
    .map((path) => relative(root, path));
  if (nodeHttpServers.some((path) => path !== "apps/mcp/src/http.ts")) {
    failures.push(`New raw Node HTTP server surfaces require an explicit prerelease rate-limit invariant: ${nodeHttpServers.join(", ")}.`);
  }
  const fastifyServers = applicationSourceFiles
    .filter((path) => readFileSync(path, "utf8").includes("Fastify("))
    .map((path) => relative(root, path));
  if (fastifyServers.some((path) => path !== "apps/api/src/app.ts")) {
    failures.push(`New Fastify server surfaces require an explicit prerelease rate-limit invariant: ${fastifyServers.join(", ")}.`);
  }

  for (const expected of ["MYSKILLS_MCP_TRUST_PROXY_HOPS", "120 requests per minute", "256 KiB"]) {
    assertContains("apps/mcp/README.md", expected);
  }
}

function checkExamples() {
  const exampleRoot = resolve(root, "examples/skills");
  let exampleDirs = [];
  try {
    exampleDirs = readdirSync(exampleRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(exampleRoot, entry.name));
  } catch {
    failures.push("examples/skills is missing.");
  }
  if (exampleDirs.length === 0) failures.push("No public example skill packages found under examples/skills.");
  for (const dir of exampleDirs) validateExampleSkill(dir);
}

function validateExampleSkill(dir) {
  const manifestPath = join(dir, "skill.json");
  let manifest;
  try {
    manifest = parseSkillManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  } catch (error) {
    failures.push(`${relative(root, manifestPath)} has an invalid manifest: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (manifest.visibility !== "public") failures.push(`${relative(root, manifestPath)} must be public.`);

  for (const file of listFiles(dir)) {
    const text = readFileSync(file, "utf8");
    const relativePath = relative(root, file);
    for (const phrase of forbiddenExamplePhrases) {
      if (phrase.test(text)) failures.push(`${relativePath} contains private-source carryover matching ${phrase}.`);
    }
    if (hasBlockingFindings(scanTextForPackageRisks(text))) {
      failures.push(`${relativePath} contains blocking package scan findings.`);
    }
  }
}

function listPackagePaths() {
  const paths = ["package.json"];
  for (const directory of ["apps", "packages"]) {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      if (entry.isDirectory()) paths.push(`${directory}/${entry.name}/package.json`);
    }
  }
  return paths.sort((left, right) => left === "package.json" ? -1 : right === "package.json" ? 1 : left.localeCompare(right));
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function checkLocalMarkdownLinks(path, text) {
  const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of text.matchAll(pattern)) {
    let target = match[1]?.trim().split(/\s+["']/)[0] ?? "";
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    if (!target || /^(?:https?:|mailto:|data:|#)/i.test(target)) continue;
    target = target.split("#")[0]?.split("?")[0] ?? "";
    if (!target) continue;
    try {
      accessSync(resolve(root, dirname(path), decodeURIComponent(target)));
    } catch {
      failures.push(`${path} links to missing local target ${target}.`);
    }
  }
}

function assertPath(path) {
  try {
    accessSync(resolve(root, path));
  } catch {
    failures.push(`${path} is missing.`);
  }
}

function assertContains(path, expected) {
  const text = readText(path);
  if (text !== null && !text.includes(expected)) failures.push(`${path} must contain ${JSON.stringify(expected)}.`);
}

function readJson(path) {
  const text = readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    failures.push(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(resolve(root, path), "utf8");
  } catch {
    failures.push(`${path} is missing or unreadable.`);
    return null;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
