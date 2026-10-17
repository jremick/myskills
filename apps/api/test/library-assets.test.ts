import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildCandidatePackage, type CandidatePackageInput } from "../src/libraries/packaging.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64");
const instructions = Buffer.from("---\nname: upstream\ndescription: A skill with an image.\n---\nUse the supplied information.\n");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const candidate = (extra: Record<string, Buffer>) => {
  const files = { "SKILL.md": instructions, ...extra };
  let fetches = 0;
  const input: CandidatePackageInput = {
    entries: Object.entries(files).map(([path, bytes]) => ({ path, type: "blob", mode: "100644", sha: createHash("sha1").update(bytes).digest("hex"), size: bytes.length })),
    rootPath: "", fetchBlob: async file => { fetches++; return files[file.sourcePath as keyof typeof files]; },
    slug: "imported-skill", version: "0.0.1", visibility: "private", licenseSpdx: null, overrides: { license: "MIT" },
    source: { repositoryId: "1", fullName: "example/skills", url: "https://github.com/example/skills", commit: "a".repeat(40), treeSha: "b".repeat(40), ref: { kind: "default-branch" }, upstreamLabel: null, releaseId: null },
  };
  return { input, fetches: () => fetches };
};

test("library candidates preserve validated image bytes, provenance and encoded artifact content", async () => {
  const fixture = candidate({ "assets/logo.png": png, "assets/vector.svg": Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>') });
  const result = await buildCandidatePackage(fixture.input);
  assert.equal(result.ready, true, JSON.stringify(result.findings));
  const logo = result.files!.find(file => file.path === "assets/logo.png")!;
  assert.deepEqual(Buffer.from(logo.content, "base64"), png);
  assert.deepEqual(result.fileDigests.find(file => file.path === logo.path), { path: logo.path, sha256: hash(png), bytes: png.length, origin: "upstream", sourcePath: logo.sourcePath, gitBlobSha: logo.gitBlobSha });
  assert.equal(result.provenanceFiles.find(file => file.path === logo.path)?.sha256, hash(png));
  assert.equal(JSON.parse(result.files!.find(file => file.path === "myskills-import.json")!.content).importer, "myskills-library-importer/3");
});

test("library image bounds are independent of the text budget and invalid images block", async () => {
  const jpeg = Buffer.alloc(1024 * 1024);
  jpeg.set([0xff, 0xd8, 0xff, 0xe0]); jpeg.set([0xff, 0xd9], jpeg.length - 2);
  const fixture = candidate({ "reference.md": Buffer.alloc(4 * 1024 * 1024, "a"), "a.jpg": jpeg, "b.jpg": jpeg });
  assert.equal((await buildCandidatePackage(fixture.input)).ready, true);
  for (const bytes of [Buffer.from("spoofed PNG"), Buffer.alloc(1024 * 1024 + 1)]) {
    const bad = candidate({ "logo.png": bytes });
    const result = await buildCandidatePackage(bad.input);
    assert.equal(result.ready, false);
    assert.equal(result.files, null);
    if (bytes.length > 1024 * 1024) assert.equal(bad.fetches(), 0);
  }
});
