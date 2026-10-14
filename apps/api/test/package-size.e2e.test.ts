import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildApp, SUBMISSION_BODY_LIMIT_BYTES } from "../src/app.js";
import { MemoryArtifactObjectStorage } from "../src/artifacts/storage.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";

// Failure inventory: valid text expands past parser/storage bounds in JSON,
// while requests over the new bounded envelope must still fail closed.
test("five MiB escaped text plus image overhead crosses API parsing and artifact storage bounds", async (t) => {
  const app = buildApp({ skillRepository: new MemorySkillRepository([]) });
  t.after(() => app.close());
  const files = [{ path: "SKILL.md", content: "\u0001".repeat(5 * 1024 * 1024) },
    ...Array.from({ length: 5 }, (_, index) => ({ path: `assets/image-${index}.png`, content: Buffer.alloc(1024 * 1024).toString("base64") }))];
  const body = JSON.stringify({ files });
  assert.ok(Buffer.byteLength(body) > 36 * 1024 * 1024);
  const parsed = await app.inject({ method: "POST", url: "/v1/submissions", payload: body, headers: { "content-type": "application/json" } });
  assert.equal(parsed.statusCode, 503, "body parser accepts the envelope before authentication checks");
  assert.equal(parsed.json().error.code, "AUTH_SERVICE_UNAVAILABLE");
  const storage = new MemoryArtifactObjectStorage();
  await storage.putObject({ key: "size-fixture", body, contentType: "application/json", sha256: createHash("sha256").update(body).digest("hex") });
  assert.equal((await storage.getObject("size-fixture")).body, body);
  const oversized = await app.inject({ method: "POST", url: "/v1/submissions", payload: JSON.stringify({ text: "x".repeat(SUBMISSION_BODY_LIMIT_BYTES) }), headers: { "content-type": "application/json" } });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.json().error.code, "SUBMISSION_BODY_TOO_LARGE");
});
