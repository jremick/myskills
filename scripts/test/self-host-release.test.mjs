import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// Failure cases, recorded before implementation: mutable tags; missing, tampered,
// mismatched, duplicate or traversal receipts; secret carryover; stale source;
// local-file substitution; output overwrite/symlinks; implicit Docker execution.
// The CLI boundary uses a disposable Git source and actual filesystem outputs.
const toolsRoot = resolve(import.meta.dirname, "..");
const names = ["api", "web", "mcp", "ops", "minio", "postgres"];
const bundleFiles = ["compose.yml", "myskills.sh", ".env.example", ".env.bootstrap.example"];
const hash = (value) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "myskills-release-test-")));
  const root = join(base, "repo");
  mkdirSync(join(root, "deploy/self-host"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.1.0-beta.18" }));
  for (const file of bundleFiles) writeFileSync(join(root, "deploy/self-host", file), `committed ${file}\n`);
  for (const name of names.filter((value) => value !== "postgres")) writeFileSync(join(root, `Dockerfile.${name}`), "FROM scratch\n");
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  git(["add", "."]);
  git(["-c", "user.name=Release Fixture", "-c", "user.email=fixture@invalid.test", "commit", "-qm", "source"]);
  const commit = git(["rev-parse", "HEAD"]).trim();
  const input = { schemaVersion: 1, source: { commit, version: "0.1.0-beta.18" }, images: {} };
  mkdirSync(join(base, "receipts"));
  for (const [index, name] of names.entries()) {
    const ref = `registry.invalid/myskills/${name}@sha256:${String(index + 1).repeat(64)}`;
    input.images[name] = { ref, platforms: [] };
    for (const arch of ["amd64", "arm64"]) {
      const platform = `linux/${arch}`;
      const digest = `sha256:${hash(`${name}-${arch}`)}`;
      const entry = { platform, digest, manifestEvidence: null, runtimeEvidence: null };
      for (const kind of ["oci-manifest", "container-runtime"]) {
        if (kind === "container-runtime" && arch === "arm64") continue;
        const receipt = { schemaVersion: 1, imageRef: ref, platformDigest: digest, platform, kind, status: "passed" };
        if (kind === "container-runtime") { receipt.executionMode = "native"; receipt.hostPlatform = platform; }
        if (kind === "oci-manifest") {
          if (name === "postgres") receipt.upstreamVersion = "17-alpine";
          else receipt.labels = { "org.opencontainers.image.revision": commit, "org.opencontainers.image.version": input.source.version };
        }
        const file = `receipts/${name}-${arch}-${kind}.json`;
        const bytes = JSON.stringify(receipt);
        writeFileSync(join(base, file), bytes);
        entry[kind === "oci-manifest" ? "manifestEvidence" : "runtimeEvidence"] = { file, sha256: hash(bytes) };
      }
      input.images[name].platforms.push(entry);
    }
  }
  const inputFile = join(base, "input.json");
  const out = join(base, "bundle");
  const save = () => writeFileSync(inputFile, JSON.stringify(input));
  save();
  return { base, root, input, inputFile, out, save, git, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function run(script, f, args = []) {
  return spawnSync(process.execPath, [join(toolsRoot, script), ...args], { cwd: f.root, encoding: "utf8" });
}

function bundle(f) {
  f.save();
  return run("create-self-host-bundle.mjs", f, ["--input", f.inputFile, "--out", f.out]);
}

test("bundle CLI preserves exact Git source, pinned references and hashed supplied receipts", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "deploy/self-host/myskills.sh"), "LOCAL PRIVATE CHANGES\n");
    writeFileSync(join(f.root, ".env"), "AUTH_SECRET=private-instance-marker\n");
    const result = bundle(f);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(f.out, "release-manifest.json"), "utf8"));
    assert.deepEqual(manifest.source, f.input.source);
    assert.equal(readFileSync(join(f.out, "myskills.sh"), "utf8"), "committed myskills.sh\n");
    assert.equal(existsSync(join(f.out, ".env")), false);
    assert.equal(manifest.images.api.platforms[1].runtimeEvidence, null);
    const env = readFileSync(join(f.out, "release.env"), "utf8");
    assert.match(env, new RegExp(`^MYSKILLS_API_IMAGE=${f.input.images.api.ref}$`, "m"));
    assert.match(env, new RegExp(`^MYSKILLS_SOURCE_COMMIT=${f.input.source.commit}$`, "m"));
    assert.doesNotMatch(env, /AUTH_SECRET|private-instance-marker|SEED_/);
    const sums = readFileSync(join(f.out, "SHA256SUMS"), "utf8").trim().split("\n");
    assert.equal(sums.length, 24);
    for (const line of sums) {
      const [digest, file] = line.split("  ");
      assert.equal(hash(readFileSync(join(f.out, file))), digest, file);
    }
    const proof = manifest.images.api.platforms[0].manifestEvidence;
    assert.match(proof.file, /^evidence\/api-amd64-oci-manifest\.json$/);
    assert.equal(hash(readFileSync(join(f.out, proof.file))), proof.sha256);
  } finally { f.cleanup(); }
});

const invalidInputs = [
  ["mutable image tag", (f) => { f.input.images.api.ref = "registry.invalid/api:latest"; }],
  ["missing manifest evidence", (f) => { f.input.images.api.platforms[0].manifestEvidence = null; }],
  ["unsupported platform", (f) => { f.input.images.api.platforms[0].platform = "linux/ppc64le"; }],
  ["duplicate platform", (f) => { f.input.images.api.platforms.push(f.input.images.api.platforms[0]); }],
  ["evidence traversal", (f) => { f.input.images.api.platforms[0].manifestEvidence.file = "../input.json"; }],
  ["absolute evidence path", (f) => { f.input.images.api.platforms[0].manifestEvidence.file = f.inputFile; }],
  ["stale version", (f) => { f.input.source.version = "0.1.0-beta.17"; }],
  ["non-immutable source", (f) => { f.input.source.commit = "HEAD"; }],
  ["unknown secret field", (f) => { f.input.AUTH_SECRET = "private-secret-marker"; }],
  ["missing image", (f) => { delete f.input.images.ops; }],
  ["forged digest", (f) => { f.input.images.api.platforms[0].digest = `sha256:${"f".repeat(64)}`; }],
  ["tampered evidence", (f) => { writeFileSync(join(f.base, f.input.images.api.platforms[0].manifestEvidence.file), "{}"); }],
  ["symlink evidence", (f) => {
    const file = join(f.base, f.input.images.api.platforms[0].manifestEvidence.file);
    const target = `${file}.original`;
    writeFileSync(target, readFileSync(file)); rmSync(file); symlinkSync(target, file);
  }],
];
for (const [name, mutate] of invalidInputs) {
  test(`bundle rejects ${name} before writing output without disclosing input values`, () => {
    const f = fixture();
    try {
      mutate(f);
      const result = bundle(f);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Self-host release:/);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /private-secret-marker/);
      assert.equal(existsSync(f.out), false);
    } finally { f.cleanup(); }
  });
}

for (const [name, mutate] of [
  ["wrong source labels", (receipt) => { receipt.labels["org.opencontainers.image.revision"] = "a".repeat(40); }],
  ["failed status", (receipt) => { receipt.status = "failed"; }],
  ["wrong image reference", (receipt) => { receipt.imageRef = "registry.invalid/another@sha256:" + "1".repeat(64); }],
  ["wrong platform", (receipt) => { receipt.platform = "linux/arm64"; }],
  ["wrong platform digest", (receipt) => { receipt.platformDigest = "sha256:" + "f".repeat(64); }],
  ["wrong receipt kind", (receipt) => { receipt.kind = "container-runtime"; }],
  ["raw logs", (receipt) => { receipt.logs = "AUTH_SECRET=private-secret-marker"; }],
]) {
  test(`bundle rejects a correctly hashed receipt with ${name}`, () => {
    const f = fixture();
    try {
      const evidence = f.input.images.api.platforms[0].manifestEvidence;
      const path = join(f.base, evidence.file);
      const receipt = JSON.parse(readFileSync(path, "utf8"));
      mutate(receipt);
      const bytes = JSON.stringify(receipt);
      writeFileSync(path, bytes); evidence.sha256 = hash(bytes);
      const result = bundle(f);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Self-host release:/);
      assert.equal(existsSync(f.out), false);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /private-secret-marker/);
    } finally { f.cleanup(); }
  });
}

for (const [name, mutate] of [
  ["missing execution mode", (receipt) => { delete receipt.executionMode; }],
  ["misclaimed native CPU", (receipt) => { receipt.hostPlatform = "linux/arm64"; }],
  ["ambiguous emulation", (receipt) => { receipt.executionMode = "emulated"; }],
]) {
  test(`bundle rejects runtime evidence with ${name}`, () => {
    const f = fixture();
    try {
      const evidence = f.input.images.api.platforms[0].runtimeEvidence;
      const file = join(f.base, evidence.file);
      const receipt = JSON.parse(readFileSync(file, "utf8")); mutate(receipt);
      const bytes = JSON.stringify(receipt); writeFileSync(file, bytes); evidence.sha256 = hash(bytes);
      const result = bundle(f);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /runtime|execution|CPU|platform|fields/i);
      assert.equal(existsSync(f.out), false);
    } finally { f.cleanup(); }
  });
}

test("bundle preserves explicitly emulated runtime evidence without changing it to native proof", () => {
  const f = fixture();
  try {
    const evidence = f.input.images.api.platforms[0].runtimeEvidence;
    const file = join(f.base, evidence.file);
    const receipt = JSON.parse(readFileSync(file, "utf8"));
    receipt.executionMode = "emulated"; receipt.hostPlatform = "linux/arm64";
    const bytes = JSON.stringify(receipt); writeFileSync(file, bytes); evidence.sha256 = hash(bytes);
    const result = bundle(f); assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(f.out, "release-manifest.json"), "utf8"));
    const copied = JSON.parse(readFileSync(join(f.out, manifest.images.api.platforms[0].runtimeEvidence.file), "utf8"));
    assert.equal(copied.executionMode, "emulated");
    assert.equal(copied.hostPlatform, "linux/arm64");
  } finally { f.cleanup(); }
});

test("bundle refuses existing output and symlink ancestors without overwriting", () => {
  const f = fixture();
  try {
    mkdirSync(f.out); writeFileSync(join(f.out, "keep"), "preserved");
    assert.equal(bundle(f).status, 1);
    assert.equal(readFileSync(join(f.out, "keep"), "utf8"), "preserved");
    const link = join(f.base, "linked");
    symlinkSync(f.out, link);
    f.out = join(link, "new-output");
    assert.equal(bundle(f).status, 1);
    assert.equal(existsSync(join(f.base, "bundle/new-output")), false);
  } finally { f.cleanup(); }
});

test("build CLI defaults to a local OCI plan for exact-source amd64 and arm64 without filesystem writes", () => {
  const f = fixture();
  try {
    const out = join(f.base, "images");
    const result = run("build-self-host-images.mjs", f, ["--source", f.input.source.commit, "--out", out]);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.execution, "plan-only");
    assert.deepEqual(plan.source, f.input.source);
    assert.equal(plan.builds.length, 10);
    assert.equal(existsSync(out), false);
    for (const build of plan.builds) {
      assert.equal(build.command[0], "docker");
      assert.equal(build.command.includes("--push"), false);
      assert.equal(build.command.includes("--load"), false);
      assert.ok(build.command.includes(`org.opencontainers.image.revision=${f.input.source.commit}`));
      assert.ok(build.command.includes(`org.opencontainers.image.version=${f.input.source.version}`));
      assert.ok(build.command.some((arg) => arg.startsWith("type=oci,dest=")));
    }
    assert.equal(plan.postgres.upstreamVersion, "17-alpine");
    assert.equal(plan.postgres.execution, "not-built");
  } finally { f.cleanup(); }
});

test("build CLI refuses source-tree output, unsafe paths and publication flags", () => {
  const f = fixture();
  try {
    for (const args of [
      ["--source", f.input.source.commit, "--out", join(f.root, "dist/images")],
      ["--source", "HEAD", "--out", join(f.base, "images")],
      ["--source", f.input.source.commit, "--out", join(f.base, "images"), "--push"],
      ["--source", f.input.source.commit, "--out", join(f.base, "images"), "--platform", "linux/ppc64le"],
    ]) assert.equal(run("build-self-host-images.mjs", f, args).status, 1);
    assert.equal(existsSync(join(f.root, "dist")), false);
  } finally { f.cleanup(); }
});

test("operator Compose consumes only release images, separates bootstrap and keeps ingress bounded", () => {
  const compose = readFileSync(resolve(toolsRoot, "../deploy/self-host/compose.yml"), "utf8");
  assert.doesNotMatch(compose, /^\s+build:/m);
  for (const name of names) assert.match(compose, new RegExp(`image: \\$\\{MYSKILLS_${name.toUpperCase()}_IMAGE:\\?`));
  assert.match(compose, /127\.0\.0\.1:\$\{WEB_PORT:-3000\}:80/);
  const service = (name) => compose.split(`\n  ${name}:\n`)[1].split(/\n {2}[a-z][a-z-]+:\n|\nvolumes:/)[0];
  for (const name of ["api", "mcp-http", "postgres", "minio"]) assert.doesNotMatch(service(name), /\n {4}ports:/);
  assert.match(service("bootstrap"), /profiles: \["bootstrap"\]/);
  assert.match(service("bootstrap"), /apps\/api\/dist\/db\/bootstrap-owner\.js/);
  assert.doesNotMatch(service("api"), /SEED_|bootstrap\.env/);
  assert.match(service("mcp-http"), /profiles: \["mcp"\]/);
  assert.match(service("ops"), /profiles: \["operations"\]/);
  assert.match(service("ops"), /network_mode: "service:minio"/);
});
