import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AppError } from "@myskills-app/core";
import { readArtifactPayload } from "../src/artifacts/package-payload.js";
import {
  createArtifactObjectStorageFromEnv,
  MemoryArtifactObjectStorage,
  S3ArtifactObjectStorage,
} from "../src/artifacts/storage.js";

const PACKAGE_CONTENT_TYPE = "application/vnd.myskills-app.package+json";

test("memory artifact storage writes and reads exact object text", async () => {
  const storage = new MemoryArtifactObjectStorage();
  const body = JSON.stringify({ files: [{ path: "skill.json", content: "{}" }] });
  await storage.putObject({
    key: "submissions/test/0.1.0/artifact.json",
    body,
    contentType: PACKAGE_CONTENT_TYPE,
    sha256: createHash("sha256").update(body).digest("hex"),
  });

  assert.deepEqual(await storage.getObject("submissions/test/0.1.0/artifact.json"), {
    body,
    contentType: PACKAGE_CONTENT_TYPE,
    sha256: createHash("sha256").update(body).digest("hex"),
  });
  await assert.rejects(() => storage.getObject("missing.json"), /Artifact object not found/);
});

test("S3 artifact storage maps put and get commands without network", async () => {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const body = JSON.stringify({ files: [{ path: "README.md", content: "Hello" }] });
  const storage = new S3ArtifactObjectStorage({
    bucket: "myskills-app-dev",
    client: {
      async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
        calls.push({ name: command.constructor.name, input: command.input });
        if (command.constructor.name === "GetObjectCommand") {
          return {
            ContentType: PACKAGE_CONTENT_TYPE,
            Metadata: { sha256: createHash("sha256").update(body).digest("hex") },
            Body: {
              transformToString: async () => body,
            },
          };
        }
        return {};
      },
    },
  });

  const sha256 = createHash("sha256").update(body).digest("hex");
  await storage.putObject({
    key: "submissions/example/0.1.0/artifact.json",
    body,
    contentType: PACKAGE_CONTENT_TYPE,
    sha256,
  });
  assert.deepEqual(await storage.getObject("submissions/example/0.1.0/artifact.json"), {
    body,
    contentType: PACKAGE_CONTENT_TYPE,
    sha256,
  });

  assert.equal(calls[0].name, "PutObjectCommand");
  assert.deepEqual(calls[0].input, {
    Bucket: "myskills-app-dev",
    Key: "submissions/example/0.1.0/artifact.json",
    Body: body,
    ContentType: PACKAGE_CONTENT_TYPE,
    ContentLength: Buffer.byteLength(body),
    Metadata: { sha256 },
  });
  assert.equal(calls[1].name, "GetObjectCommand");
  assert.deepEqual(calls[1].input, {
    Bucket: "myskills-app-dev",
    Key: "submissions/example/0.1.0/artifact.json",
  });
});

test("artifact payload reader serves object-backed payloads when metadata matches", async () => {
  const storage = new MemoryArtifactObjectStorage();
  const payload = { files: [{ path: "skill.json", content: "{}" }] };
  const body = JSON.stringify(payload);
  const artifact = artifactRecord("submissions/object-backed.json", body, { payload: { files: [] } });
  await storage.putObject({
    key: artifact.storageKey,
    body,
    contentType: artifact.contentType,
    sha256: artifact.sha256,
  });

  assert.deepEqual(await readArtifactPayload({ artifactStorage: storage, artifact }), payload);
});

test("artifact payload reader supports legacy DB payload fallback only when the object is missing", async () => {
  const legacyPayload = { files: [{ path: "README.md", content: "legacy" }] };

  assert.deepEqual(await readArtifactPayload({
    artifactStorage: new MemoryArtifactObjectStorage(),
    artifact: artifactRecord("submissions/legacy.json", JSON.stringify(legacyPayload), { payload: legacyPayload }),
  }), legacyPayload);

  await assert.rejects(
    () => readArtifactPayload({
      artifactStorage: new MemoryArtifactObjectStorage(),
      artifact: artifactRecord("submissions/object-backed.json", JSON.stringify(legacyPayload), { payload: { files: [] } }),
    }),
    hasAppErrorCode("ARTIFACT_PAYLOAD_UNAVAILABLE"),
  );
});

test("artifact payload reader fails closed when legacy DB fallback does not match metadata", async () => {
  const expectedPayload = { files: [{ path: "README.md", content: "expected" }] };
  const stalePayload = { files: [{ path: "README.md", content: "stale" }] };

  await assert.rejects(
    () => readArtifactPayload({
      artifactStorage: new MemoryArtifactObjectStorage(),
      artifact: artifactRecord("submissions/stale-legacy.json", JSON.stringify(expectedPayload), { payload: stalePayload }),
    }),
    hasAppErrorCode("ARTIFACT_METADATA_MISMATCH"),
  );
});

test("artifact payload reader fails closed on object metadata mismatch even with DB payload present", async () => {
  const storage = new MemoryArtifactObjectStorage();
  const payload = { files: [{ path: "skill.json", content: "{}" }] };
  const expectedBody = JSON.stringify(payload);
  const storedBody = JSON.stringify({ files: [{ path: "skill.json", content: "{\"changed\":true}" }] });
  const artifact = artifactRecord("submissions/mismatch.json", expectedBody, { payload });
  await storage.putObject({
    key: artifact.storageKey,
    body: storedBody,
    contentType: artifact.contentType,
    sha256: createHash("sha256").update(storedBody).digest("hex"),
  });

  await assert.rejects(
    () => readArtifactPayload({ artifactStorage: storage, artifact }),
    hasAppErrorCode("ARTIFACT_METADATA_MISMATCH"),
  );
});

test("artifact payload reader fails closed on content type mismatch", async () => {
  const storage = new MemoryArtifactObjectStorage();
  const payload = { files: [{ path: "skill.json", content: "{}" }] };
  const body = JSON.stringify(payload);
  const artifact = artifactRecord("submissions/content-type.json", body, { payload });
  await storage.putObject({
    key: artifact.storageKey,
    body,
    contentType: "application/json",
    sha256: artifact.sha256,
  });

  await assert.rejects(
    () => readArtifactPayload({ artifactStorage: storage, artifact }),
    hasAppErrorCode("ARTIFACT_METADATA_MISMATCH"),
  );
});

test("artifact payload reader fails closed on invalid object JSON instead of DB fallback", async () => {
  const storage = new MemoryArtifactObjectStorage();
  const legacyPayload = { files: [{ path: "README.md", content: "legacy" }] };
  const body = "{";
  const artifact = artifactRecord("submissions/invalid-json.json", body, { payload: legacyPayload });
  await storage.putObject({
    key: artifact.storageKey,
    body,
    contentType: artifact.contentType,
    sha256: artifact.sha256,
  });

  await assert.rejects(
    () => readArtifactPayload({ artifactStorage: storage, artifact }),
    hasAppErrorCode("INVALID_PACKAGE_PAYLOAD"),
  );
});

test("artifact storage env config defaults to DB fallback outside production", () => {
  assert.equal(createArtifactObjectStorageFromEnv({ NODE_ENV: "development" }), undefined);
  assert.equal(createArtifactObjectStorageFromEnv({ NODE_ENV: "test", ARTIFACT_STORAGE_MODE: "db" }), undefined);
});

test("artifact storage env config rejects unsafe production DB mode and invalid values", () => {
  assert.throws(
    () => createArtifactObjectStorageFromEnv({ NODE_ENV: "production", ARTIFACT_STORAGE_MODE: "db" }),
    /ARTIFACT_STORAGE_MODE=db is not allowed in production/,
  );
  assert.throws(
    () => createArtifactObjectStorageFromEnv({ ARTIFACT_STORAGE_MODE: "filesystem" }),
    /ARTIFACT_STORAGE_MODE must be db or s3/,
  );
  assert.throws(
    () => createArtifactObjectStorageFromEnv({
      ARTIFACT_STORAGE_MODE: "s3",
      S3_BUCKET: "myskills-app-dev",
      S3_FORCE_PATH_STYLE: "yes",
    }),
    /Boolean environment values must be true or false/,
  );
});

test("artifact storage env config validates S3 settings", () => {
  assert.throws(
    () => createArtifactObjectStorageFromEnv({ ARTIFACT_STORAGE_MODE: "s3" }),
    /S3_BUCKET is required/,
  );
  assert.throws(
    () => createArtifactObjectStorageFromEnv({
      ARTIFACT_STORAGE_MODE: "s3",
      S3_BUCKET: "myskills-app-dev",
      S3_ACCESS_KEY_ID: "access-key",
    }),
    /S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be provided together/,
  );

  const storage = createArtifactObjectStorageFromEnv({
    ARTIFACT_STORAGE_MODE: "s3",
    S3_ENDPOINT: "http://localhost:9000",
    S3_REGION: "local",
    S3_BUCKET: "myskills-app-dev",
    S3_ACCESS_KEY_ID: "access-key",
    S3_SECRET_ACCESS_KEY: "secret-key",
  });
  assert.ok(storage);
});

test("artifact storage env config requires trusted S3 transport in production", () => {
  assert.throws(
    () => createArtifactObjectStorageFromEnv({
      NODE_ENV: "production",
      ARTIFACT_STORAGE_MODE: "s3",
      S3_ENDPOINT: "http://object-store.internal:9000",
      S3_REGION: "local",
      S3_BUCKET: "myskills-app",
      S3_ACCESS_KEY_ID: "access-key",
      S3_SECRET_ACCESS_KEY: "secret-key",
    }),
    /S3_ENDPOINT must use https in production/,
  );

  assert.ok(createArtifactObjectStorageFromEnv({
    NODE_ENV: "production",
    ARTIFACT_STORAGE_MODE: "s3",
    S3_ENDPOINT: "https://object-store.example.com",
    S3_REGION: "us-east-1",
    S3_BUCKET: "myskills-app",
    S3_ACCESS_KEY_ID: "access-key",
    S3_SECRET_ACCESS_KEY: "secret-key",
  }));

  assert.ok(createArtifactObjectStorageFromEnv({
    NODE_ENV: "production",
    ARTIFACT_STORAGE_MODE: "s3",
    S3_ENDPOINT: "http://object-store.internal:9000",
    S3_ALLOW_INSECURE_ENDPOINT: "true",
    S3_REGION: "local",
    S3_BUCKET: "myskills-app",
    S3_ACCESS_KEY_ID: "access-key",
    S3_SECRET_ACCESS_KEY: "secret-key",
  }));
});

function artifactRecord(storageKey: string, body: string, options: { payload: unknown }) {
  return {
    storageKey,
    sha256: createHash("sha256").update(body).digest("hex"),
    byteSize: Buffer.byteLength(body),
    contentType: PACKAGE_CONTENT_TYPE,
    payload: options.payload,
  };
}

function hasAppErrorCode(code: string) {
  return (error: unknown): boolean => error instanceof AppError && error.code === code;
}
