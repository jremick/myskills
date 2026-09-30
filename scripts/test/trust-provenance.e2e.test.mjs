import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

// Written before provenance generation. The executable must bind clean git,
// lockfile and artifact bytes; reject mutable/private identities; be deterministic;
// and label supplied image refs and unsigned state without inventing evidence.
const script = resolve("scripts/create-trust-provenance.mjs");

test("provenance CLI: deterministic production SBOM, exact source/artifacts and fail-closed inputs", (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "myskills-trust-provenance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic verification");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", license: "MIT", packageManager: "npm@11.12.1" }));
  const lock = { name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: {
    "": { name: "fixture", version: "1.0.0", dependencies: { "prod-example": "1.2.3" } },
    "node_modules/prod-example": { version: "1.2.3", resolved: "https://registry.npmjs.org/prod-example/-/prod-example-1.2.3.tgz", integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`, license: "MIT" },
    "node_modules/dev-example": { version: "2.0.0", dev: true },
  } };
  writeFileSync(resolve(root, "package-lock.json"), JSON.stringify(lock));
  writeFileSync(resolve(root, ".gitignore"), "dist/\n");
  git("add", "."); git("commit", "-qm", "Synthetic provenance source");
  const sha = git("rev-parse", "HEAD");
  mkdirSync(resolve(root, "dist/release"), { recursive: true });
  git("archive", "--format=tar", "--prefix=fixture-1.0.0/", "-o", resolve(root, "dist/release/source.tar"), "HEAD");
  const archive = readFileSync(resolve(root, "dist/release/source.tar"));
  const artifact = { file: "source.tar", byteSize: archive.length, sha256: hash(archive) };
  writeFileSync(resolve(root, "dist/release/release-metadata.json"), JSON.stringify({ name: "fixture", version: "1.0.0", commitSha: sha, dirty: false, artifacts: [artifact] }));
  const image = `api=ghcr.io/example/fixture@sha256:${"1".repeat(64)}`;
  const run = (out, extra = []) => spawnSync(process.execPath, [script, "--release", "dist/release", "--out", out, "--image", image, ...extra], { cwd: root, encoding: "utf8" });
  for (const out of ["dist/provenance-a", "dist/provenance-b"]) { const result = run(out); assert.equal(result.status, 0, result.stderr); }
  for (const file of ["sbom.cdx.json", "provenance.json", "signing-preparation.json", "SHA256SUMS"]) assert.equal(readFileSync(resolve(root, "dist/provenance-a", file), "utf8"), readFileSync(resolve(root, "dist/provenance-b", file), "utf8"));
  const sbom = JSON.parse(readFileSync(resolve(root, "dist/provenance-a/sbom.cdx.json")));
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.components.length, 1);
  assert.equal(sbom.components[0].name, "prod-example");
  assert.equal(sbom.components[0].hashes[0].alg, "SHA-512");
  const provenance = JSON.parse(readFileSync(resolve(root, "dist/provenance-a/provenance.json")));
  assert.equal(provenance.source.commitSha, sha);
  assert.deepEqual(provenance.release.artifacts, [artifact]);
  assert.equal(provenance.images[0].evidence, "supplied_immutable_reference_only");
  assert.equal(provenance.signing.status, "unsigned_authority_not_selected");
  assert.equal(run("dist/provenance-a").status, 1, "must not overwrite existing outputs");
  for (const value of ["api=ghcr.io/example/fixture:latest", image, "api=https://user:secret@example.test/image"]) {
    const bad = run("dist/bad", ["--image", value]);
    assert.equal(bad.status, 1);
    assert.equal(bad.stderr.includes("user:secret"), false);
  }
  writeFileSync(resolve(root, "dist/release/source.tar"), "changed bytes");
  assert.equal(run("dist/bad-artifact").status, 1);
  writeFileSync(resolve(root, "dist/release/source.tar"), archive);
  writeFileSync(resolve(root, "package-lock.json"), "{}");
  assert.equal(run("dist/dirty-source").status, 1);
});

function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
