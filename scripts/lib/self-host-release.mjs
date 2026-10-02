import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

export const imageNames = ["api", "web", "mcp", "ops", "minio", "postgres"];
export const supportedPlatforms = ["linux/amd64", "linux/arm64"];
const bundleFiles = ["compose.yml", "myskills.sh", ".env.example", ".env.bootstrap.example"];
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const refPattern = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function shape(value, required, optional = []) {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "Expected a release object.");
  check(required.every((key) => Object.hasOwn(value, key)), "Required release fields are missing.");
  check(Object.keys(value).every((key) => [...required, ...optional].includes(key)), "Unexpected release fields are not allowed in public artifacts.");
}

function readSmallFile(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    check(info.isFile(), "Release input must be a regular file, not a symlink.");
    check(info.size <= 1024 * 1024, "Release input exceeds the one MiB limit.");
    noSymlinkAncestors(file);
    const named = lstatSync(file);
    check(named.isFile() && named.dev === info.dev && named.ino === info.ino, "Release input changed while opening.");
    // Read one extra byte to detect growth without ever consuming an unbounded file.
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0, count;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, length)) !== 0) length += count;
    check(length === info.size && fstatSync(fd).size === info.size, "Release input size changed while reading.");
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}

function json(bytes) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Release JSON is invalid."); }
}

export function git(root, args, options = {}) {
  try {
    return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  } catch { throw new Error("Could not read the immutable Git source."); }
}

export function sourceIdentity(root, commit) {
  check(typeof commit === "string" && commitPattern.test(commit), "Source requires a full immutable commit SHA.");
  check(git(root, ["rev-parse", "--verify", `${commit}^{commit}`]).trim() === commit, "Source commit identity does not match.");
  const sourcePackage = json(Buffer.from(git(root, ["show", `${commit}:package.json`])));
  const currentPackage = json(readSmallFile(resolve(root, "package.json")));
  check(typeof sourcePackage.version === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(sourcePackage.version), "Source package version is invalid.");
  check(currentPackage.version === sourcePackage.version, "Current package version does not match the selected source.");
  return { commit, version: sourcePackage.version };
}

function noSymlinkAncestors(path) {
  let current = resolve(path);
  while (current !== parse(current).root) {
    if (existsSync(current)) check(!lstatSync(current).isSymbolicLink(), "Symlink paths are not allowed; use a canonical path.");
    current = dirname(current);
  }
}

export function validateOutput(root, outputDir, { external = false } = {}) {
  const output = resolve(outputDir);
  noSymlinkAncestors(output);
  check(!existsSync(output), "Output already exists; no files will be overwritten.");
  const canonicalRoot = realpathSync(root);
  const inside = relative(canonicalRoot, output);
  const isInside = inside === "" || (!inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside));
  if (external) check(!isInside, "OCI build output must be outside the source checkout.");
  else if (isInside) check(inside.startsWith(`dist${sep}`), "Bundle output inside the source checkout must be below dist.");
  return output;
}

function receiptEvidence(base, record, name, entry, kind, source, ref) {
  shape(record, ["file", "sha256"]);
  check(typeof record.file === "string" && /^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*\.json$/.test(record.file) && !isAbsolute(record.file) && record.file.split("/").every((part) => part !== "." && part !== ".." && part.length > 0), "Evidence path must be a safe relative JSON path.");
  check(typeof record.sha256 === "string" && shaPattern.test(record.sha256), "Evidence requires a SHA256 hash.");
  const path = resolve(base, record.file);
  noSymlinkAncestors(path);
  const bytes = readSmallFile(path);
  check(sha256(bytes) === record.sha256, "Evidence checksum does not match.");
  const receipt = json(bytes);
  shape(receipt, ["schemaVersion", "imageRef", "platformDigest", "platform", "kind", "status", ...(kind === "container-runtime" ? ["executionMode", "hostPlatform"] : [])], kind === "oci-manifest" ? name === "postgres" ? ["upstreamVersion"] : ["labels"] : []);
  check(receipt.schemaVersion === 1 && receipt.kind === kind && receipt.status === "passed", "Evidence kind, schema or status does not match.");
  check(receipt.imageRef === ref && receipt.platformDigest === entry.digest && receipt.platform === entry.platform, "Evidence image or platform identity does not match.");
  if (kind === "container-runtime") {
    check(["native", "emulated"].includes(receipt.executionMode) && supportedPlatforms.includes(receipt.hostPlatform), "Runtime execution mode or host platform is invalid.");
    check(receipt.executionMode === "native" ? receipt.hostPlatform === entry.platform : receipt.hostPlatform !== entry.platform, "Runtime execution mode does not match the host and image CPU platforms.");
  }
  if (kind === "oci-manifest") {
    if (name === "postgres") check(receipt.upstreamVersion === "17-alpine", "Postgres evidence must identify the 17-alpine upstream image.");
    else {
      shape(receipt.labels, ["org.opencontainers.image.revision", "org.opencontainers.image.version"]);
      check(receipt.labels["org.opencontainers.image.revision"] === source.commit && receipt.labels["org.opencontainers.image.version"] === source.version, "OCI source labels do not match the release source.");
    }
  }
  const file = `evidence/${name}-${entry.platform.split("/")[1]}-${kind}.json`;
  return { record: { file, sha256: record.sha256 }, bytes };
}

export function loadReleaseInput(root, inputFile) {
  const inputPath = resolve(inputFile);
  noSymlinkAncestors(inputPath);
  const input = json(readSmallFile(inputPath));
  shape(input, ["schemaVersion", "source", "images"]);
  check(input.schemaVersion === 1, "Unsupported release schema.");
  shape(input.source, ["commit", "version"]);
  const source = sourceIdentity(root, input.source.commit);
  check(input.source.version === source.version, "Release version does not match the selected source package.");
  shape(input.images, imageNames);
  const manifest = { schemaVersion: 1, source, images: {} };
  const evidenceFiles = [];
  for (const name of imageNames) {
    const image = input.images[name];
    shape(image, ["ref", "platforms"]);
    check(typeof image.ref === "string" && refPattern.test(image.ref), "Every release image must use a repository@sha256 digest reference.");
    check(Array.isArray(image.platforms) && image.platforms.length >= 1 && image.platforms.length <= 2, "Image platform evidence must contain one or two supported platforms.");
    const seen = new Set();
    const platforms = image.platforms.map((entry) => {
      shape(entry, ["platform", "digest", "manifestEvidence", "runtimeEvidence"]);
      check(supportedPlatforms.includes(entry.platform) && !seen.has(entry.platform), "Platform evidence is unsupported or duplicated.");
      seen.add(entry.platform);
      check(typeof entry.digest === "string" && digestPattern.test(entry.digest), "Platform digest is invalid.");
      const proof = receiptEvidence(dirname(inputPath), entry.manifestEvidence, name, entry, "oci-manifest", source, image.ref);
      evidenceFiles.push({ file: proof.record.file, bytes: proof.bytes });
      let runtimeEvidence = null;
      if (entry.runtimeEvidence !== null) {
        const runtime = receiptEvidence(dirname(inputPath), entry.runtimeEvidence, name, entry, "container-runtime", source, image.ref);
        evidenceFiles.push({ file: runtime.record.file, bytes: runtime.bytes });
        runtimeEvidence = runtime.record;
      }
      return { platform: entry.platform, digest: entry.digest, manifestEvidence: proof.record, runtimeEvidence };
    });
    manifest.images[name] = { ref: image.ref, platforms };
  }
  check(supportedPlatforms.some((platform) => imageNames.every((name) => manifest.images[name].platforms.some((entry) => entry.platform === platform))), "Images do not share a supported deployment platform.");
  return { manifest, evidenceFiles };
}

export function createSelfHostBundle({ root, inputFile, outputDir }) {
  const output = validateOutput(root, outputDir);
  const { manifest, evidenceFiles } = loadReleaseInput(root, inputFile);
  const sourceFiles = bundleFiles.map((file) => {
    const sourcePath = `deploy/self-host/${file}`;
    check(git(root, ["ls-tree", manifest.source.commit, "--", sourcePath]).startsWith("100"), "Bundle source file is missing or is not a regular Git file.");
    return { file, bytes: git(root, ["show", `${manifest.source.commit}:${sourcePath}`], { encoding: null }) };
  });
  const env = [`MYSKILLS_SOURCE_COMMIT=${manifest.source.commit}`, `MYSKILLS_VERSION=${manifest.source.version}`, ...imageNames.map((name) => `MYSKILLS_${name.toUpperCase()}_IMAGE=${manifest.images[name].ref}`)].join("\n") + "\n";
  const files = [...sourceFiles, ...evidenceFiles, { file: "release.env", bytes: Buffer.from(env) }, { file: "release-manifest.json", bytes: Buffer.from(JSON.stringify(manifest, null, 2) + "\n") }].sort((a, b) => a.file.localeCompare(b.file));
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output);
  mkdirSync(resolve(output, "evidence"));
  for (const { file, bytes } of files) writeFileSync(resolve(output, file), bytes, { flag: "wx", mode: file === "myskills.sh" ? 0o755 : 0o644 });
  writeFileSync(resolve(output, "SHA256SUMS"), files.map(({ file, bytes }) => `${sha256(bytes)}  ${file}`).join("\n") + "\n", { flag: "wx" });
  return { output, source: manifest.source, evidence: "supplied-receipts", files: files.length };
}

export function planSelfHostImages({ root, commit, outputDir, platforms = supportedPlatforms }) {
  const source = sourceIdentity(root, commit);
  const output = validateOutput(root, outputDir, { external: true });
  check(platforms.length > 0 && platforms.every((platform) => supportedPlatforms.includes(platform)) && new Set(platforms).size === platforms.length, "Build platforms are unsupported or duplicated.");
  const context = resolve(output, ".source");
  const builds = [];
  for (const image of imageNames.filter((name) => name !== "postgres")) {
    check(git(root, ["ls-tree", source.commit, "--", `Dockerfile.${image}`]).startsWith("100"), "An exact-source Dockerfile is missing.");
    for (const platform of platforms) {
      const archive = `${image}-${platform.split("/")[1]}.oci.tar`;
      const command = ["docker", "buildx", "build", "--platform", platform, "--file", resolve(context, `Dockerfile.${image}`), "--label", `org.opencontainers.image.revision=${source.commit}`, "--label", `org.opencontainers.image.version=${source.version}`, "--build-arg", `MYSKILLS_BUILD_REVISION=${source.commit}`];
      if (image === "web") command.push("--build-arg", "VITE_API_BASE_URL=/api");
      command.push("--output", `type=oci,dest=${resolve(output, archive)}`, context);
      builds.push({ image, platform, archive, command });
    }
  }
  return { schemaVersion: 1, execution: "plan-only", source, context: { kind: "exact-git-archive", commit: source.commit, path: context }, builds, postgres: { upstreamVersion: "17-alpine", execution: "not-built", instruction: "Supply immutable upstream digest and per-platform evidence; this helper does not pull or publish Postgres." } };
}

export function parseOptions(args, valueOptions, flags = []) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    check(!Object.hasOwn(parsed, arg.slice(2)), "Duplicate arguments are not allowed.");
    if (flags.includes(arg)) parsed[arg.slice(2)] = true;
    else {
      check(valueOptions.includes(arg) && args[index + 1] && !args[index + 1].startsWith("--"), "Unknown argument or missing value.");
      parsed[arg.slice(2)] = args[index + 1]; index += 1;
    }
  }
  return parsed;
}
