#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// This is a deterministic inventory and signing input, never a signed attestation.
try { main(); } catch (error) {
  console.error(error instanceof SyntaxError || error.code ? "Provenance could not read or validate its bounded inputs." : error.message);
  process.exitCode = 1;
}

function main() {
  const args = argumentsOf(process.argv.slice(2));
  const root = process.cwd();
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (git("status", "--porcelain", "--untracked-files=all").trim()) throw new Error("Provenance requires a clean source checkout.");
  const commitSha = git("rev-parse", "HEAD").trim();
  const pkg = JSON.parse(git("show", `${commitSha}:package.json`));
  const lockBytes = Buffer.from(git("show", `${commitSha}:package-lock.json`));
  const lock = JSON.parse(lockBytes);
  if (lock.lockfileVersion !== 3 || !lock.packages || lock.version !== pkg.version) throw new Error("A matching npm lockfile version 3 is required.");
  const releaseDir = safeDirectory(root, args.release);
  const metadataBytes = boundedFile(resolve(releaseDir, "release-metadata.json"));
  const metadata = JSON.parse(metadataBytes);
  if (metadata.commitSha !== commitSha || metadata.version !== pkg.version || metadata.name !== pkg.name || metadata.dirty !== false) {
    throw new Error("Release metadata must match this clean source revision and package.");
  }
  if (!Array.isArray(metadata.artifacts) || !metadata.artifacts.length) throw new Error("Release artifact metadata is required.");
  const seenFiles = new Set();
  const artifacts = metadata.artifacts.map(record => {
    if (!record || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}$/.test(record.file) || seenFiles.has(record.file)) throw new Error("Release artifact identity is invalid or duplicated.");
    seenFiles.add(record.file);
    if (!Number.isSafeInteger(record.byteSize) || record.byteSize < 1 || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error("Release artifact integrity metadata is invalid.");
    const bytes = boundedFile(resolve(releaseDir, record.file));
    if (bytes.length !== record.byteSize || hash(bytes) !== record.sha256) throw new Error("Release artifact bytes do not match their declared digest and size.");
    return { file: record.file, byteSize: record.byteSize, sha256: record.sha256 };
  }).sort((a, b) => compare(a.file, b.file));
  const archive = artifacts.filter(record => record.file.endsWith(".tar"));
  if (archive.length !== 1) throw new Error("One reproducible source tar is required.");
  const source = execFileSync("git", ["archive", "--format=tar", `--prefix=${pkg.name}-${pkg.version}/`, commitSha], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
  if (hash(source) !== archive[0].sha256) throw new Error("Source archive does not reproduce from this exact revision.");
  const components = Object.entries(lock.packages).filter(([path, item]) => path.includes("node_modules/") && !item.link && item.dev !== true).map(([path, item]) => {
    const name = item.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) || typeof item.version !== "string" || !/^[a-zA-Z0-9.+_-]{1,100}$/.test(item.version)) throw new Error("Production dependency identity is invalid.");
    // Bundled children have no individual resolved/integrity in npm's lockfile.
    // Validate their containing tarball, but never copy its hash onto a child.
    let ownerPath = path, owner = item;
    while (owner.inBundle === true) {
      const separator = ownerPath.lastIndexOf("/node_modules/");
      if (separator < 0) throw new Error("Bundled dependency has no containing lockfile package.");
      ownerPath = ownerPath.slice(0, separator);
      owner = lock.packages[ownerPath];
      if (!owner) throw new Error("Bundled dependency has no containing lockfile package.");
    }
    const url = new URL(owner.resolved);
    if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.username || url.password || url.search || url.hash) throw new Error("Production dependencies must use public credential-free npm registry identities.");
    const sri = /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(owner.integrity ?? "");
    if (!sri) throw new Error("Every production dependency needs supported lockfile integrity.");
    const digest = Buffer.from(sri[2], "base64");
    if (digest.length !== (sri[1] === "sha512" ? 64 : 32) || digest.toString("base64") !== sri[2]) throw new Error("Production dependency integrity is invalid.");
    return {
      type: "library", "bom-ref": `npm:${path}@${item.version}`, name, version: item.version,
      purl: `pkg:npm/${name.replace("@", "%40")}@${item.version}`,
      ...(item.inBundle === true ? {} : { hashes: [{ alg: sri[1] === "sha512" ? "SHA-512" : "SHA-256", content: digest.toString("hex") }] }),
      properties: [{ name: "myskills:lockfile-path", value: path }, ...(item.inBundle === true ? [
        { name: "myskills:bundled-in", value: `npm:${ownerPath}@${owner.version}` },
        { name: "myskills:integrity-evidence", value: "containing package tarball integrity; individual bundled package integrity unavailable" },
      ] : [])],
    };
  }).sort((a, b) => compare(a["bom-ref"], b["bom-ref"]));
  const images = args.images.sort((a, b) => compare(a.role, b.role));
  const sbom = {
    $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json", bomFormat: "CycloneDX", specVersion: "1.6", version: 1,
    metadata: { component: { type: "application", name: pkg.name, version: pkg.version }, properties: [
      { name: "myskills:inventory-scope", value: "npm production lockfile entries; excludes OS/image contents and runtime install proof" },
      { name: "myskills:source-revision", value: commitSha },
    ] }, components,
  };
  const files = { "sbom.cdx.json": serialize(sbom) };
  const signing = { status: "unsigned_authority_not_selected", requires: ["supported signing authority and identity", "approved publication target", "verification of signature identity and immutable subject digests"] };
  const provenance = {
    schemaVersion: 1,
    source: { commitSha, version: pkg.version, packageManager: pkg.packageManager, lockfile: { file: "package-lock.json", sha256: hash(lockBytes) } },
    release: { metadata: { file: "release-metadata.json", sha256: hash(metadataBytes) }, artifacts, sourceArchiveReproduced: true },
    dependencyInventory: { file: "sbom.cdx.json", sha256: hash(files["sbom.cdx.json"]), components: components.length, evidence: "production_lockfile_inventory_only" },
    images: images.map(image => ({ ...image, evidence: "supplied_immutable_reference_only" })),
    signing,
  };
  files["provenance.json"] = serialize(provenance);
  files["signing-preparation.json"] = serialize({ schemaVersion: 1, ...signing, subjects: [
    ...artifacts.map(record => ({ name: record.file, digest: { sha256: record.sha256 } })),
    ...Object.entries(files).map(([name, body]) => ({ name, digest: { sha256: hash(body) } })),
    ...images.map(image => ({ name: image.role, digest: { sha256: image.ref.split("@sha256:")[1] } })),
  ].sort((a, b) => compare(a.name, b.name)) });
  files.SHA256SUMS = Object.entries(files).sort(([a], [b]) => compare(a, b)).map(([name, body]) => `${hash(body)}  ${name}\n`).join("");
  const out = safeDirectory(root, args.out, false);
  const withinDist = relative(resolve(root, "dist"), out);
  if (!withinDist || withinDist.startsWith("..") || isAbsolute(withinDist)) throw new Error("Provenance output must be a fresh subdirectory of dist.");
  mkdirSync(resolve(out, ".."), { recursive: true });
  mkdirSync(out); // Exclusive directory: never replace an earlier receipt.
  for (const [name, body] of Object.entries(files)) writeFileSync(resolve(out, name), body, { flag: "wx" });
  console.log(`Unsigned provenance prepared: ${components.length} production dependencies, ${images.length} supplied image references.`);
}

function argumentsOf(input) {
  const result = { release: null, out: null, images: [] };
  const roles = new Set();
  for (let i = 0; i < input.length; i += 2) {
    const option = input[i], value = input[i + 1];
    if (!value) throw new Error("Each provenance option requires a value.");
    if (option === "--release" || option === "--out") {
      const key = option.slice(2);
      if (result[key] !== null) throw new Error("Duplicate provenance directory option.");
      result[key] = value;
    } else if (option === "--image") {
      const match = /^(api|web|mcp|ops|minio|postgres)=([a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64})$/.exec(value);
      if (!match || roles.has(match[1]) || match[2].includes("..") || !match[2].includes("/") || match[2].split("@")[0].split("/").some(part => !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(part))) throw new Error("Each image needs a unique supported role and immutable credential-free digest reference.");
      roles.add(match[1]); result.images.push({ role: match[1], ref: match[2] });
    } else throw new Error("Unknown provenance option.");
  }
  if (!result.release || !result.out) throw new Error("Usage: create-trust-provenance.mjs --release dist/release --out dist/provenance [--image role=repository@sha256:digest]");
  return result;
}

function safeDirectory(root, path, mustExist = true) {
  const absolute = resolve(root, path);
  const local = relative(root, absolute);
  if (!local || local.startsWith("..") || isAbsolute(local)) throw new Error("Provenance directories must be inside the source checkout.");
  let current = root;
  for (const part of local.split(/[\\/]/)) {
    current = resolve(current, part);
    try { if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) throw new Error("Provenance directory is not a plain directory."); }
    catch (error) { if (error.code !== "ENOENT" || mustExist) throw error; }
  }
  return absolute;
}

function boundedFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 * 1024) throw new Error("Provenance input must be a bounded plain file.");
  return readFileSync(path);
}
function serialize(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
