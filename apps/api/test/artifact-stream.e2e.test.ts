import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { S3Client } from "@aws-sdk/client-s3";
import { S3ArtifactObjectStorage, ArtifactStorageTimeoutError } from "../src/artifacts/storage.js";

// Written before the bounded storage reader. The real SDK and HTTP stream must
// reject oversized headers/chunks and invalid UTF-8 without buffering all text.
// Existing command fixtures cannot detect unbounded SDK body consumption.
for (const mode of ["bounded", "split-utf8", "header-overflow", "chunk-overflow", "invalid-utf8", "stalled-body"] as const) {
  test(`S3 SDK streamed delivery: ${mode}`, async (t) => {
    let socketClosed = false;
    const server = createServer((_request, reply) => {
      reply.once("close", () => { socketClosed = true; });
      reply.setHeader("content-type", "application/vnd.myskills-app.package+json");
      if (mode === "header-overflow") reply.setHeader("content-length", "10000000");
      if (mode === "bounded") reply.end("exact body");
      else if (mode === "split-utf8") { reply.write(Buffer.from([0xe2])); reply.end(Buffer.from([0x82, 0xac])); }
      else if (mode === "invalid-utf8") reply.end(Buffer.from([0xc3, 0x28]));
      else if (mode === "stalled-body") { reply.write("x"); }
      else { reply.write("x".repeat(32)); reply.end("x".repeat(32)); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const client = new S3Client({ endpoint: `http://127.0.0.1:${address.port}`, region: "us-east-1", forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: "synthetic-stream-key", secretAccessKey: "synthetic-stream-secret" } });
    t.after(() => client.destroy());
    const storage = new S3ArtifactObjectStorage({ bucket: "fixture", client, requestTimeoutMs: mode === "stalled-body" ? 200 : 2_000 });
    if (mode === "bounded") assert.equal((await storage.getObject("immutable-object", { maxBytes: 32 })).body, "exact body");
    else if (mode === "split-utf8") assert.equal((await storage.getObject("immutable-object", { maxBytes: 3 })).body, "€");
    else if (mode === "stalled-body") {
      await assert.rejects(storage.getObject("immutable-object", { maxBytes: 32 }), ArtifactStorageTimeoutError);
      for (let attempts = 0; !socketClosed && attempts < 50; attempts++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(socketClosed, true, "deadline must close the actual upstream socket");
    }
    else await assert.rejects(storage.getObject("immutable-object", { maxBytes: 32 }), mode === "invalid-utf8" ? /UTF-8/ : /byte limit/);
  });
}
