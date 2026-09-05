import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { backupConfiguration, loadCompletedSet, publishBackup, registryBackupStatus, restoreRegistryBackup,
  retentionCandidates, runPrefix, runRegistryBackup, validateManifest, withBackupLock } from "../lib/registry-backup.mjs";
import { captureSnapshot, createRecoveryDirectory, readObject, sha256, withDeadline } from "../lib/registry-recovery.mjs";
import { recoveryConfiguration, rehearseRegistryRecovery } from "../rehearse-registry-recovery.mjs";

const instanceId = "fixture-registry";
const objectId = "00000000-0000-4000-a000-000000000001";
const inlineId = "00000000-0000-4000-a000-000000000002";
const payload = { files: [{ path: "SKILL.md", content: "fixture package" }] };
const artifactBytes = Buffer.from(JSON.stringify(payload));
const archiveBytes = Buffer.from("PGDMP fixture archive");
const signal = () => new AbortController().signal;
const runIdAt = (time, suffix = "0000000000000001") => `${new Date(time).toISOString().replaceAll(":", "-")}_${suffix}`;
const missing = () => Object.assign(new Error("fixture private provider error"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });

function env(outputParent = tmpdir()) {
  return {
    MYSKILLS_BACKUP_INSTANCE_ID: instanceId,
    MYSKILLS_RECOVERY_OUTPUT_PARENT: outputParent,
    MYSKILLS_RECOVERY_SOURCE_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1/source",
    MYSKILLS_RECOVERY_DESTINATION_POSTGRES_URL: "postgres://fixture:fixture@127.0.0.1/postgres",
    MYSKILLS_RECOVERY_SOURCE_S3_ENDPOINT: "http://127.0.0.1:9000",
    MYSKILLS_RECOVERY_SOURCE_S3_BUCKET: "fixture-source",
    MYSKILLS_RECOVERY_SOURCE_S3_ACCESS_KEY_ID: "fixture-access",
    MYSKILLS_RECOVERY_SOURCE_S3_SECRET_ACCESS_KEY: "fixture-secret",
    MYSKILLS_RECOVERY_BACKUP_S3_ENDPOINT: "https://backup.example.test",
    MYSKILLS_RECOVERY_BACKUP_S3_BUCKET: "fixture-backup",
    MYSKILLS_RECOVERY_BACKUP_S3_ACCESS_KEY_ID: "fixture-backup-access",
    MYSKILLS_RECOVERY_BACKUP_S3_SECRET_ACCESS_KEY: "fixture-backup-secret",
    MYSKILLS_RECOVERY_DESTINATION_S3_ENDPOINT: "http://127.0.0.1:9100",
    MYSKILLS_RECOVERY_DESTINATION_S3_ACCESS_KEY_ID: "fixture-local-access",
    MYSKILLS_RECOVERY_DESTINATION_S3_SECRET_ACCESS_KEY: "fixture-local-secret",
  };
}
function manifestAt(time = Date.now()) {
  return { schemaVersion: 1, instanceId, capturedAt: new Date(time).toISOString(),
    database: { file: "database.dump", byteSize: archiveBytes.length, sha256: sha256(archiveBytes) },
    tables: [{ table: "instance_settings", rows: 1, fingerprint: "a".repeat(32) }, { table: "skill_artifacts", rows: 2, fingerprint: "a".repeat(32) }],
    artifacts: [objectId, inlineId].map((id, index) => ({ id, file: `${id}.bin`, key: `skills/${id}/artifact.json`,
      byteSize: artifactBytes.length, sha256: sha256(artifactBytes), contentType: "application/json", storage: index ? "database" : "s3" })) };
}
async function directory(t) {
  const parent = await mkdtemp(join(tmpdir(), "myskills-backup-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return parent;
}
async function writeFixture(config, manifest) {
  const root = await createRecoveryDirectory(config);
  await writeFile(join(root, "database.dump"), archiveBytes);
  for (const item of manifest.artifacts) await writeFile(join(root, "objects", item.file), artifactBytes);
  return root;
}

class FakeStorage {
  objects = new Map(); requests = []; buckets = new Set(); hook;
  key(bucket, key) { return `${bucket}\n${key}`; }
  async send(command, options) {
    const type = command.constructor.name; const input = command.input;
    this.requests.push({ type, bucket: input.Bucket, key: input.Key, input });
    options?.abortSignal?.throwIfAborted();
    const overridden = await this.hook?.(type, input, options);
    if (overridden !== undefined) return overridden;
    const identity = this.key(input.Bucket, input.Key);
    if (type === "PutObjectCommand") {
      if (input.IfNoneMatch === "*" && this.objects.has(identity)) throw new Error("Precondition failed");
      const bytes = Buffer.isBuffer(input.Body) ? input.Body : Buffer.concat(await Array.fromAsync(input.Body, (chunk) => Buffer.from(chunk)));
      this.objects.set(identity, { bytes, contentType: input.ContentType, metadata: input.Metadata }); return {};
    }
    if (type === "GetObjectCommand") {
      const value = this.objects.get(identity); if (!value) throw missing();
      return { Body: Readable.from([value.bytes]), ContentLength: value.bytes.length, ContentType: value.contentType, Metadata: value.metadata };
    }
    if (type === "DeleteObjectCommand") { this.objects.delete(identity); return {}; }
    if (type === "HeadBucketCommand") { if (!this.buckets.has(input.Bucket)) throw missing(); return {}; }
    if (type === "CreateBucketCommand") { this.buckets.add(input.Bucket); return {}; }
    if (type === "ListObjectsV2Command") {
      const prefixes = new Set(); const contents = [];
      for (const identity of this.objects.keys()) {
        const [bucket, key] = identity.split("\n");
        if (bucket !== input.Bucket || !key.startsWith(input.Prefix)) continue;
        const rest = key.slice(input.Prefix.length); const slash = rest.indexOf("/");
        if (slash < 0) contents.push({ Key: key }); else prefixes.add(`${input.Prefix}${rest.slice(0, slash + 1)}`);
      }
      return { IsTruncated: false, CommonPrefixes: [...prefixes].map((Prefix) => ({ Prefix })), Contents: contents };
    }
    throw new Error("Unexpected S3 command");
  }
  destroy() {}
}
class FakePostgres extends EventEmitter {
  queries = []; acquired = true; identity = instanceId; closed = false; badFingerprint = false;
  artifacts = manifestAt().artifacts;
  async connect() {}
  async end() { this.closed = true; this.emit("end"); }
  async query(sql, parameters) {
    this.queries.push({ sql, parameters });
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: this.acquired }] };
    if (sql.includes("pg_export_snapshot")) return { rows: [{ snapshot: "00000001-00000002-1", captured_at: new Date() }] };
    if (sql.includes("WHERE key = 'instance_id'")) return { rows: [{ value: this.identity }] };
    if (sql.includes("FROM pg_tables")) return { rows: [{ tablename: "instance_settings" }, { tablename: "skill_artifacts" }] };
    if (sql.includes("count(*)")) return { rows: [{ count: sql.includes("skill_artifacts") ? String(this.artifacts.length) : "1" }] };
    if (sql.includes("string_agg")) return { rows: [{ fingerprint: (this.badFingerprint ? "b" : "a").repeat(32) }] };
    if (sql.includes("FROM public.skill_artifacts ORDER")) return { rows: this.artifacts.map((item) => ({ id: item.id, storage_key: item.key,
      sha256: item.sha256, byte_size: item.byteSize, content_type: item.contentType, has_inline_payload: item.storage === "database" })) };
    if (sql.includes("SELECT payload")) return { rows: [{ payload }] };
    if (sql.includes("FROM pg_database")) return { rows: [], rowCount: 0 };
    if (/^(BEGIN|SET|COMMIT|ROLLBACK|CREATE DATABASE)/.test(sql)) return { rows: [] };
    throw new Error("Unexpected SQL");
  }
}
async function dump(_config, _snapshot, path) { await writeFile(path, archiveBytes); return manifestAt().database; }
function sourceObjects() {
  const store = new FakeStorage(); const item = manifestAt().artifacts[0];
  store.objects.set(store.key("fixture-source", item.key), { bytes: artifactBytes, contentType: item.contentType, metadata: { sha256: item.sha256 } });
  return store;
}
function dependencies(backup, source = new FakePostgres()) {
  const sourceS3 = sourceObjects();
  return { source, sourceS3, postgresClient: () => source,
    storageClient: (config) => config.endpoint.includes("backup.example.test") ? backup : sourceS3,
    captureSnapshot: (config, pg, s3, root, context) => captureSnapshot(config, pg, s3, root, context, dump) };
}
async function storedSet(t, store, time = Date.now(), suffix) {
  const config = backupConfiguration(env(await directory(t)));
  const manifest = manifestAt(time); const root = await writeFixture(config, manifest); const runId = runIdAt(time, suffix);
  const set = await publishBackup(store, config, manifest, root, runId, signal());
  return { config, manifest, runId, root, set };
}

// These use actual capture/backup/restore orchestration with local fake PG and S3 transports.
// They do not replace the required live PG18 + retained-remote-set restore drill.
test("source, backup and isolated destination S3 path styles are independent; legacy default remains true", () => {
  const values = { ...env(), MYSKILLS_RECOVERY_SOURCE_S3_FORCE_PATH_STYLE: "true", MYSKILLS_RECOVERY_BACKUP_S3_FORCE_PATH_STYLE: "false", MYSKILLS_RECOVERY_DESTINATION_S3_FORCE_PATH_STYLE: "false" };
  assert.equal(backupConfiguration(values).sourceStorage.forcePathStyle, true);
  assert.equal(backupConfiguration(values).backupStorage.forcePathStyle, false);
  assert.equal(backupConfiguration(values, "restore").destinationStorage.forcePathStyle, false);
  assert.equal(recoveryConfiguration(env()).destinationStorage.forcePathStyle, true);
  assert.throws(() => backupConfiguration({ ...values, MYSKILLS_RECOVERY_BACKUP_S3_FORCE_PATH_STYLE: "yes" }), /true or false/);
  assert.throws(() => backupConfiguration({ ...values, MYSKILLS_RECOVERY_BACKUP_S3_BUCKET: "fixture-source" }), /differ/);
  assert.throws(() => backupConfiguration({ ...values, MYSKILLS_BACKUP_INSTANCE_ID: "../foreign" }), /identity/);
  assert.throws(() => backupConfiguration({ ...values, MYSKILLS_RECOVERY_DESTINATION_POSTGRES_URL: "postgres://fixture:fixture@remote.example.test/postgres" }, "restore"), /loopback/);
  assert.throws(() => backupConfiguration({ ...values, MYSKILLS_RECOVERY_DESTINATION_S3_ENDPOINT: "https://remote.example.test" }, "restore"), /loopback/);
});

test("one snapshot includes object and inline bytes; source SQL never mutates application data", async (t) => {
  const backup = new FakeStorage(); const deps = dependencies(backup);
  const report = await runRegistryBackup(env(await directory(t)), deps);
  assert.equal(report.passed, true); assert.equal(report.artifactCount, 2); assert.equal(report.objectBackedCount, 1); assert.equal(report.sourceWrites, false);
  assert.equal(deps.source.closed, true);
  assert(deps.source.queries.some(({ sql }) => sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"));
  assert(deps.source.queries.every(({ sql }) => /^(SELECT|SET|BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())));
  assert.equal(deps.sourceS3.requests.some(({ type }) => ["PutObjectCommand", "DeleteObjectCommand"].includes(type)), false);
  const config = backupConfiguration(env());
  const completed = await loadCompletedSet(backup, config, report.runId, signal());
  assert.equal(completed.manifest.artifacts[1].storage, "database");
  assert(backup.objects.has(backup.key(config.backupBucket, `${runPrefix(config, report.runId)}objects/${inlineId}.bin`)));
  const puts = backup.requests.filter(({ type }) => type === "PutObjectCommand");
  assert(puts.at(-1).key.endsWith("/complete.json"));
  const successful = await registryBackupStatus({ ...env(), MYSKILLS_RECOVERY_SOURCE_DATABASE_URL: undefined }, { storageClient: () => backup });
  assert.equal(successful.passed, true);
});

test("wrong source instance fails before object copy or upload", async (t) => {
  const backup = new FakeStorage(); const source = new FakePostgres(); source.identity = "different-registry";
  const deps = dependencies(backup, source);
  const report = await runRegistryBackup(env(await directory(t)), deps);
  assert.equal(report.passed, false); assert.equal(backup.requests.length, 0); assert.equal(deps.sourceS3.requests.length, 0);
  assert(source.queries.some(({ sql }) => sql === "ROLLBACK"));
});

test("overlap is refused and source connection loss cancels the lock holder", async () => {
  const occupied = new FakePostgres(); occupied.acquired = false;
  let ran = false;
  await assert.rejects(withBackupLock(occupied, signal(), async () => { ran = true; }), /already running/);
  assert.equal(ran, false); assert.equal(occupied.closed, true);
  const disconnected = new FakePostgres(); let lockSignal;
  await assert.rejects(withBackupLock(disconnected, signal(), async (activeSignal) => {
    lockSignal = activeSignal; disconnected.emit("error", new Error("private connection detail"));
    await new Promise(() => {});
  }), /connection was lost/);
  assert.equal(lockSignal.aborted, true); assert.equal(disconnected.closed, true);
});

test("deadline destroys a body that stops after response headers", async () => {
  const body = new Readable({ read() {} });
  const store = { send: async () => ({ Body: body, ContentLength: 10 }) };
  await assert.rejects(withDeadline(20, (active) => readObject(store, "fixture", "fixture", 10, active)), /deadline/);
  assert.equal(body.destroyed, true);
});

test("whole-job deadline ends a stalled capture without a completed set", async (t) => {
  const backup = new FakeStorage(); const deps = dependencies(backup);
  deps.captureSnapshot = async () => new Promise(() => {});
  const report = await runRegistryBackup({ ...env(await directory(t)), MYSKILLS_RECOVERY_TIMEOUT_MS: "1000" }, deps);
  assert.equal(report.passed, false); assert.equal(backup.requests.length, 0);
});

test("corrupt upload readback leaves no completion marker and prunes nothing", async (t) => {
  const backup = new FakeStorage();
  backup.hook = async (type, input) => {
    if (type === "GetObjectCommand" && input.Key.endsWith("database.dump")) return { Body: Readable.from([Buffer.alloc(archiveBytes.length)]), ContentLength: archiveBytes.length };
  };
  const report = await runRegistryBackup(env(await directory(t)), dependencies(backup));
  assert.equal(report.passed, false); assert.equal(report.failedPhase, "upload-and-verify");
  assert.equal(backup.requests.some(({ key, type }) => type === "PutObjectCommand" && key.endsWith("complete.json")), false);
  assert.equal(backup.requests.some(({ type }) => type === "DeleteObjectCommand"), false);
  assert.equal(JSON.stringify(report).includes("fixture-secret"), false);
});

test("retention keeps seven distinct successful days, leaves incomplete attempts and foreign namespaces untouched", async (t) => {
  const backup = new FakeStorage(); const now = Date.now();
  for (let day = 1; day <= 8; day++) await storedSet(t, backup, now - day * 86_400_000);
  const config = backupConfiguration(env());
  const partial = `${runPrefix(config, runIdAt(now - 10 * 86_400_000))}database.dump`;
  const foreign = "registry-v1/another-registry/foreign.json";
  backup.objects.set(backup.key(config.backupBucket, partial), { bytes: archiveBytes });
  backup.objects.set(backup.key(config.backupBucket, foreign), { bytes: archiveBytes });
  const report = await runRegistryBackup(env(await directory(t)), dependencies(backup));
  assert.equal(report.passed, true); assert.equal(report.deletedSets, 2);
  const remaining = [...backup.objects.keys()].filter((key) => key.endsWith("complete.json"));
  assert.equal(remaining.length, 7);
  assert(backup.objects.has(backup.key(config.backupBucket, partial)));
  assert(backup.objects.has(backup.key(config.backupBucket, foreign)));
  assert(backup.requests.filter(({ type }) => type === "DeleteObjectCommand").every(({ bucket, key }) => bucket === config.backupBucket && key.startsWith(config.namespace)));
});

test("same-day retries do not displace historical days", async (t) => {
  const backup = new FakeStorage(); const now = Date.now(); const sets = [];
  for (let day = 1; day <= 7; day++) sets.push((await storedSet(t, backup, now - day * 86_400_000)).set);
  const older = (await storedSet(t, backup, now - 60_000, "0000000000000002")).set;
  const current = (await storedSet(t, backup, now)).set;
  const remove = retentionCandidates([...sets, older, current], backupConfiguration(env()), current.marker.runId);
  assert.equal(remove.length, 2);
  assert(remove.some((set) => set.marker.runId === older.marker.runId));
  assert(remove.some((set) => set.marker.runId === sets[6].marker.runId));
});

test("malformed completed sets and incomplete pagination refuse all retention", async (t) => {
  for (const scenario of ["malformed", "pagination", "foreign"]) {
    const backup = new FakeStorage(); const config = backupConfiguration(env());
    if (scenario === "malformed") backup.objects.set(backup.key(config.backupBucket, `${runPrefix(config, runIdAt(Date.now() - 86_400_000))}complete.json`), { bytes: Buffer.from("{}") });
    else backup.hook = async (type) => type !== "ListObjectsV2Command" ? undefined : scenario === "pagination"
      ? { IsTruncated: true, CommonPrefixes: [] }
      : { IsTruncated: false, CommonPrefixes: [{ Prefix: "registry-v1/foreign/" }] };
    const report = await runRegistryBackup(env(await directory(t)), dependencies(backup));
    assert.equal(report.passed, false, scenario); assert.equal(report.failedPhase, "retention", scenario);
    assert.equal(backup.requests.some(({ type }) => type === "DeleteObjectCommand"), false, scenario);
  }
});

test("remote manifest traversal, extra keys, duplicates, invalid sizes and foreign identities are rejected", () => {
  const config = backupConfiguration(env());
  for (const mutate of [
    (value) => { value.database.file = "../../outside"; },
    (value) => { value.artifacts[0].file = "../outside"; },
    (value) => { value.artifacts[0].byteSize = 1e12; },
    (value) => { value.artifacts.push(value.artifacts[0]); },
    (value) => { value.instanceId = "foreign"; },
    (value) => { value.sourceDatabaseUrl = "credential-bearing-value"; },
    (value) => { value.artifacts[0].storage = "other"; },
    (value) => { value.tables[0].table = "../outside"; },
  ]) { const manifest = manifestAt(); mutate(manifest); assert.throws(() => validateManifest(manifest, config)); }
  assert.throws(() => runPrefix(config, "../foreign"));
});

test("status reports missing or stale success without source database credentials", async (t) => {
  const backup = new FakeStorage(); const values = { ...env(), MYSKILLS_RECOVERY_SOURCE_DATABASE_URL: undefined };
  const deps = { storageClient: () => backup, postgresClient: () => { throw new Error("Status must never connect to source"); } };
  assert.equal((await registryBackupStatus(values, deps)).reason, "missing-completed-backup");
  await storedSet(t, backup, Date.now() - 27 * 60 * 60 * 1000);
  const result = await registryBackupStatus(values, deps);
  assert.equal(result.passed, false); assert.equal(result.reason, "stale");
});

test("restore downloads the retained set, verifies all bytes, and uses only new loopback destinations", async (t) => {
  const backup = new FakeStorage(); const { runId } = await storedSet(t, backup);
  const destinationS3 = new FakeStorage(); const postgres = [];
  const values = { ...env(await directory(t)), MYSKILLS_RECOVERY_SOURCE_DATABASE_URL: undefined };
  const result = await restoreRegistryBackup(values, runId, {
    storageClient: (config) => config.endpoint.includes("backup.example.test") ? backup : destinationS3,
    postgresClient: (url) => { assert.equal(url.hostname, "127.0.0.1"); const client = new FakePostgres(); postgres.push(client); return client; },
    restoreDatabase: async (_config, url, root) => { assert.match(url.pathname, /^\/myskills_recovery_/); assert.deepEqual(await readFile(join(root, "database.dump")), archiveBytes); },
  });
  assert.equal(result.report.passed, true); assert.equal(result.report.artifactCount, 2); assert.equal(result.report.restoredApplicationRuntime, "not-tested");
  assert.equal((await stat(result.recoveryRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(join(result.recoveryRoot, "database.dump"))).mode & 0o777, 0o600);
  assert.equal(destinationS3.requests.filter(({ type }) => type === "PutObjectCommand").length, 1);
  assert.equal(postgres.length, 2);
});

test("missing or corrupt retained bytes fail before any restore destination connection", async (t) => {
  for (const scenario of ["marker", "manifest", "archive", "artifact", "oversize"]) {
    const backup = new FakeStorage(); const { config, runId } = await storedSet(t, backup);
    const prefix = runPrefix(config, runId);
    if (scenario === "marker" || scenario === "manifest") backup.objects.delete(backup.key(config.backupBucket, `${prefix}${scenario === "marker" ? "complete" : "manifest"}.json`));
    else if (scenario === "oversize") backup.hook = async (type, input) => type === "GetObjectCommand" && input.Key.endsWith("complete.json")
      ? { ContentLength: 10_000_000, Body: Readable.from([Buffer.from("{}")]) } : undefined;
    else backup.objects.get(backup.key(config.backupBucket, `${prefix}${scenario === "archive" ? "database.dump" : `objects/${inlineId}.bin`}`)).bytes = Buffer.from("corrupt");
    let connected = false;
    const { report } = await restoreRegistryBackup(env(await directory(t)), runId, { storageClient: () => backup,
      postgresClient: () => { connected = true; throw new Error("No destination may be connected"); } });
    assert.equal(report.passed, false, scenario); assert.equal(connected, false, scenario);
    assert.equal(backup.requests.some(({ type }) => type === "DeleteObjectCommand"), false, scenario);
  }
});

test("legacy rehearsal still captures, restores and verifies inline/object data with its existing API", async (t) => {
  const sourceS3 = sourceObjects(); const destinationS3 = new FakeStorage(); const source = new FakePostgres();
  const { report, recoveryRoot } = await rehearseRegistryRecovery(env(await directory(t)), {
    postgresClient: (url) => url.pathname === "/source" ? source : new FakePostgres(),
    storageClient: (config) => config.endpoint.includes(":9000") ? sourceS3 : destinationS3,
    dumpDatabase: dump, restoreDatabase: async () => {},
  });
  assert.equal(report.passed, true); assert.equal(report.artifactCount, 2); assert.equal(report.sourceWrites, false);
  assert.equal(report.restoredApplicationRuntime, "not-tested");
  const manifest = JSON.parse(await readFile(join(recoveryRoot, "manifest.json")));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.instanceId, undefined);
});

test("recurring backups and restores accept empty and inline-only registries", async (t) => {
  for (const artifacts of [[], [manifestAt().artifacts[1]]]) {
    const backup = new FakeStorage(); const source = new FakePostgres(); source.artifacts = artifacts;
    const values = env(await directory(t));
    const report = await runRegistryBackup(values, dependencies(backup, source));
    assert.equal(report.passed, true); assert.equal(report.artifactCount, artifacts.length); assert.equal(report.objectBackedCount, 0);
    const restored = await restoreRegistryBackup(values, report.runId, {
      storageClient: (config) => config.endpoint.includes("backup.example.test") ? backup : new FakeStorage(),
      postgresClient: () => { const destination = new FakePostgres(); destination.artifacts = artifacts; return destination; },
      restoreDatabase: async () => {},
    });
    assert.equal(restored.report.passed, true); assert.equal(restored.report.artifactCount, artifacts.length);
  }
});

test("legacy rehearsal still requires an object-backed package", async (t) => {
  const source = new FakePostgres(); source.artifacts = [];
  await assert.rejects(rehearseRegistryRecovery(env(await directory(t)), {
    postgresClient: () => source, storageClient: () => new FakeStorage(), dumpDatabase: dump,
  }), /Recovery rehearsal failed/);
});

test("process watchdog survives a settled deadline race with an ignored open handle", async () => {
  const moduleUrl = new URL("../lib/registry-recovery.mjs", import.meta.url).href;
  const code = `import { armProcessDeadline, withDeadline } from ${JSON.stringify(moduleUrl)};
    armProcessDeadline(20);
    setInterval(() => {}, 100);
    await withDeadline(5, async () => new Promise(() => {})).catch(() => {});
    console.log("operation-settled");`;
  await assert.rejects(promisify(execFile)(process.execPath, ["--input-type=module", "--eval", code], { timeout: 5_000 }), (error) => {
    assert.equal(error.code, 1); assert.equal(error.killed, false);
    assert.match(error.stdout, /operation-settled/); assert.match(error.stderr, /"failedPhase":"deadline"/);
    return true;
  });
  const healthy = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `import { armProcessDeadline } from ${JSON.stringify(moduleUrl)}; armProcessDeadline(20_000); console.log("closed");`], { timeout: 2_000 });
  assert.match(healthy.stdout, /closed/);
});

test("failed restore records destinations before creation and retains them privately through each failure phase", async (t) => {
  for (const failedPhase of ["create-isolated-destinations", "restore-database", "restore-artifacts", "verify-restored-database"]) {
    const backup = new FakeStorage(); const { runId } = await storedSet(t, backup);
    const parent = await directory(t); const destinationS3 = new FakeStorage();
    let recordedBeforeCreation = false; let destinations;
    const privateError = "fixture-private-artifact-or-credential";
    if (failedPhase === "restore-artifacts") destinationS3.hook = async (type) => {
      if (type === "PutObjectCommand") throw new Error(privateError);
    };
    const { report, recoveryRoot } = await restoreRegistryBackup(env(parent), runId, {
      storageClient: (config) => config.endpoint.includes("backup.example.test") ? backup : destinationS3,
      postgresClient: () => {
        const client = new FakePostgres();
        client.badFingerprint = failedPhase === "verify-restored-database";
        const query = client.query.bind(client);
        client.query = async (sql, parameters) => {
          if (sql.startsWith("CREATE DATABASE")) {
            const [directoryName] = await readdir(parent);
            destinations = JSON.parse(await readFile(join(parent, directoryName, "destinations.json")));
            assert(sql.includes(destinations.destinationDatabase));
            assert.match(destinations.destinationBucket, /^myskills-recovery-/);
            recordedBeforeCreation = true;
            if (failedPhase === "create-isolated-destinations") throw new Error(privateError);
          }
          return query(sql, parameters);
        };
        return client;
      },
      restoreDatabase: async () => { if (failedPhase === "restore-database") throw new Error(privateError); },
    });
    assert.equal(recordedBeforeCreation, true, failedPhase);
    assert.equal(report.passed, false, failedPhase); assert.equal(report.failedPhase, failedPhase);
    const failurePath = join(recoveryRoot, "failure.json");
    const privateReport = JSON.parse(await readFile(failurePath));
    assert.equal(privateReport.destinationDatabase, destinations.destinationDatabase);
    assert.equal(privateReport.destinationBucket, destinations.destinationBucket);
    assert.equal((await stat(failurePath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(recoveryRoot, "destinations.json"))).mode & 0o777, 0o600);
    for (const withheld of ["destinationDatabase", "destinationBucket", privateError, objectId]) assert.equal(JSON.stringify(report).includes(withheld), false);
    assert.equal(JSON.stringify(privateReport).includes(privateError), false);
  }
});

test("legacy rehearsal retains destination identities when database restore fails", async (t) => {
  const parent = await directory(t);
  await assert.rejects(rehearseRegistryRecovery(env(parent), {
    postgresClient: () => new FakePostgres(),
    storageClient: (config) => config.endpoint.includes(":9000") ? sourceObjects() : new FakeStorage(),
    dumpDatabase: dump, restoreDatabase: async () => { throw new Error("fixture-provider-detail"); },
  }), /failed during restore-database/);
  const [directoryName] = await readdir(parent); const root = join(parent, directoryName);
  const destinations = JSON.parse(await readFile(join(root, "destinations.json")));
  const failure = JSON.parse(await readFile(join(root, "failure.json")));
  assert.equal(failure.destinationDatabase, destinations.destinationDatabase);
  assert.equal(failure.destinationBucket, destinations.destinationBucket);
  assert.equal(failure.failedPhase, "restore-database");
  assert.equal(JSON.stringify(failure).includes("fixture-provider-detail"), false);
});
