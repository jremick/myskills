import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { S3Client } from "@aws-sdk/client-s3";
import { S3ArtifactObjectStorage } from "../src/artifacts/storage.js";

// Written before the bounded storage reader. The real SDK and HTTP stream must
// reject oversized headers/chunks and invalid UTF-8 without buffering all text.
// Existing command fixtures cannot detect unbounded SDK body consumption.
for (const mode of ["bounded", "header-overflow", "chunk-overflow", "invalid-utf8"] as const) {
  test(`S3 SDK streamed delivery: ${mode}`, async (t) => {
    const server = createServer((_request, reply) => {
      reply.setHeader("content-type", "application/vnd.myskills-app.package+json");
      if (mode === "header-overflow") reply.setHeader("content-length", "10000000");
      if (mode === "bounded") reply.end("exact body");
      else if (mode === "invalid-utf8") reply.end(Buffer.from([0xc3, 0x28]));
      else { reply.write("x".repeat(32)); reply.end("x".repeat(32)); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const client = new S3Client({ endpoint: `http://127.0.0.1:${address.port}`, region: "us-east-1", forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: "synthetic-stream-key", secretAccessKey: "synthetic-stream-secret" } });
    t.after(() => client.destroy());
    const storage = new S3ArtifactObjectStorage({ bucket: "fixture", client, requestTimeoutMs: 2_000 });
    if (mode === "bounded") assert.equal((await storage.getObject("immutable-object", { maxBytes: 32 })).body, "exact body");
    else await assert.rejects(storage.getObject("immutable-object", { maxBytes: 32 }), mode === "invalid-utf8" ? /UTF-8/ : /byte limit/);
  });
}
