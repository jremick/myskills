import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { compareAuthorizedReleases, type ReleaseComparisonRead } from "../src/release-comparison.js";
function fixture() {
  const packageFor = (version: string, files: Array<{path:string;content:string}>) => ({ files: [{ path: "skill.json", content: JSON.stringify({ name: "compare", version }) }, ...files] });
  const base = packageFor("1.0.0", [{ path: "same.txt", content: "same" }, { path: "removed.txt", content: "old" }, { path: "changed.txt", content: "a".repeat(50_000) + "OLD" }]);
  const target = packageFor("2.0.0", [{ path: "same.txt", content: "same" }, { path: "added.txt", content: "new" }, { path: "changed.txt", content: "a".repeat(50_000) + "NEW" }]);
  const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const input = { base: { slug: "compare", version: "1.0.0", artifactSha256: sha(base) }, target: { slug: "compare", version: "2.0.0", artifactSha256: sha(target) } };
  const read: ReleaseComparisonRead = async (kind, pin) => {
    const payload = pin.version === "1.0.0" ? base : target;
    return kind === "bundle" ? payload : { release: { slug: pin.slug, version: pin.version, reviewStatus: "approved", lifecycleStatus: "approved", publishedAt: "2026-10-01T00:00:00Z", artifact: { sha256: sha(payload), byteSize: Buffer.byteLength(JSON.stringify(payload)) } } };
  };
  return { input, read, base, target, sha };
}
test("comparison reports all statuses and complete byte identities despite identical truncated previews", async () => {
  const f = fixture(); const result = await compareAuthorizedReleases(f.input, f.read);
  assert.deepEqual(result.totals, { added: 1, removed: 1, modified: 2, unchanged: 1 });
  const change = result.changes.find(item => item.path === "changed.txt")!;
  assert.equal(change.status, "modified"); assert.equal(change.base!.preview, change.target!.preview);
  assert.equal(change.base!.previewTruncated, true); assert.notEqual(change.base!.sha256, change.target!.sha256);
  assert.equal(change.base!.byteSize, 50_003);
  assert.ok(JSON.stringify(result).length < 40_000);
  assert.deepEqual(result.changes.map(item => item.path), [...result.changes.map(item => item.path)].sort());
});
test("comparison refuses wrong digest, correctly hashed foreign identity, unsafe paths and management-only unpublished release", async () => {
  for (const failure of ["digest", "identity", "path", "unpublished"] as const) {
    const f = fixture();
    if (failure === "digest") f.input.base.artifactSha256 = "f".repeat(64);
    if (failure === "identity") f.base.files[0]!.content = JSON.stringify({ name: "foreign", version: "1.0.0" });
    if (failure === "path") f.base.files.push({ path: "../escape", content: "unsafe" });
    if (failure === "identity" || failure === "path") f.input.base.artifactSha256 = f.sha(f.base);
    await assert.rejects(compareAuthorizedReleases(f.input, async (kind, pin) => {
      const value = await f.read(kind, pin);
      if (failure === "unpublished" && kind === "release") (value.release as Record<string, unknown>).publishedAt = null;
      return value;
    }), /readable published exact releases/);
  }
});
test("authorization denial or revocation during final re-read yields no partial comparison", async () => {
  for (const deniedAt of [1, 3, 5, 6]) {
    const f = fixture(); let reads = 0;
    await assert.rejects(compareAuthorizedReleases(f.input, async (kind, pin) => { if (++reads === deniedAt) throw new Error("API authorization revoked"); return f.read(kind, pin); }), /revoked/);
    assert.equal(reads, deniedAt);
  }
});
