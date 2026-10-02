import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { inspectHostPlatformImage, pushHostPlatformImage, verifyHostPlatformManifest, fetchHostPlatformManifest } from "../lib/host-platform-receipt.mjs";
function fixture() {
  const source = { commit: "a".repeat(40), version: "0.1.0-beta.19" };
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: `sha256:${"c".repeat(64)}`, size: 128 }, layers: [{ digest: `sha256:${"d".repeat(64)}`, size: 123 }] }));
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const selected = { Id: digest, Descriptor: { digest }, Os: "linux", Architecture: "amd64", Config: { Labels: { "org.opencontainers.image.revision": source.commit, "org.opencontainers.image.version": source.version } } };
  return { source, bytes, headerDigest: digest, before: selected, after: structuredClone(selected), name: "api" };
}
test("fixture publication compares selected platform identities even when unqualified upstream inspection returns an index", () => {
  const f = fixture(), calls = [];
  const docker = args => { calls.push(args); return { status: 0, stdout: JSON.stringify([args.includes("--platform") ? f.before : { ...f.before, Id: `sha256:${"e".repeat(64)}`, Descriptor: { digest: `sha256:${"e".repeat(64)}` } }]) }; };
  assert.notEqual(JSON.parse(docker(["image", "inspect", "postgres"]).stdout)[0].Id, f.headerDigest);
  f.before = inspectHostPlatformImage(docker, "postgres"); f.after = inspectHostPlatformImage(docker, "pinned-reference");
  pushHostPlatformImage(docker, "loopback-fixture-tag");
  assert.equal(verifyHostPlatformManifest(f), f.headerDigest);
  assert.deepEqual(calls.at(-1), ["push", "--platform", "linux/amd64", "loopback-fixture-tag"]);
  assert.deepEqual(calls[1], ["image", "inspect", "--platform", "linux/amd64", "postgres"]);
  assert.equal(verifyHostPlatformManifest({ ...f, name: "postgres", before: { ...f.before, Config: {} }, after: { ...f.after, Config: {} } }), f.headerDigest, "upstream Postgres is not relabeled as application source");
});
test("platform receipts deny index, altered bytes, mismatched platform/digest or source labels with bounded diagnostics", () => {
  for (const failure of ["index", "bytes", "platform", "digest", "labels"] ) {
    const f = fixture();
    if (failure === "index") { f.bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [] })); f.headerDigest = `sha256:${createHash("sha256").update(f.bytes).digest("hex")}`; }
    if (failure === "bytes") f.bytes = Buffer.concat([f.bytes, Buffer.from(" ")]);
    if (failure === "platform") f.after.Architecture = "arm64";
    if (failure === "digest") f.after.Descriptor.digest = `sha256:${"f".repeat(64)}`;
    if (failure === "labels") f.after.Config.Labels["org.opencontainers.image.revision"] = "secret.invalid/provider-output";
    assert.throws(() => verifyHostPlatformManifest(f), error => { assert.equal(error.message, "HOST_PLATFORM_RECEIPT_INVALID"); assert.ok(error.hostPlatformFailure.reason); assert.equal(error.hostPlatformFailure.role, "api"); assert.equal(error.hostPlatformFailure.check, { index: "manifest", bytes: "digest", platform: "identity", digest: "identity", labels: "labels" }[failure]); assert.doesNotMatch(JSON.stringify(error.hostPlatformFailure), /secret.invalid|provider-output|Config|Labels/); return true; });
  }
});

test("platform manifest fetch reports fixed image role and bounded operation categories", async () => {
  const f = fixture();
  const success = await fetchHostPlatformManifest(async () => new Response(f.bytes, { headers: { "docker-content-digest": f.headerDigest } }), "http://fixture.invalid/secret-path", "postgres");
  assert.deepEqual(success.bytes, f.bytes); assert.equal(success.headerDigest, f.headerDigest);
  for (const [reason, fetcher] of [
    ["fetch-transport", async () => { throw new Error("PASSWORD=secret.invalid"); }],
    ["fetch-timeout", async () => { const error = new Error("secret"); error.name = "TimeoutError"; throw error; }],
    ["fetch-http-status", async () => new Response("secret-output", { status: 500 })],
    ["fetch-size", async () => new Response("secret", { headers: { "content-length": "1048577" } })],
    ["fetch-body", async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("secret-body")); } }))],
  ]) await assert.rejects(fetchHostPlatformManifest(fetcher, "http://fixture.invalid/private", "postgres"), error => { assert.equal(error.hostPlatformFailure.role, "postgres"); assert.equal(error.hostPlatformFailure.check, "fetch"); assert.equal(error.hostPlatformFailure.reason, reason); assert.doesNotMatch(JSON.stringify(error.hostPlatformFailure), /secret|PASSWORD|private|fixture.invalid/); return true; });
});
