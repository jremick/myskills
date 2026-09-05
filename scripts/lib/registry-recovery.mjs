import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const limits = Object.freeze({ artifactBytes: 14 * 1024 * 1024, artifacts: 10_000, rows: 1_000_000,
  tables: 256, manifestBytes: 8 * 1024 * 1024, ioMs: 30_000, sqlMs: 180_000, connectMs: 10_000 });
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const required = (env, key) => { const value = env[key]?.trim(); if (!value) throw new Error(`${key} is required.`); return value; };
export const loopback = (host) => ["localhost", "127.0.0.1", "[::1]"].includes(host);
const identifier = (name) => `"${name.replaceAll('"', '""')}"`;
export const isMissingObject = (error) => error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404;

export function boundedInteger(value, fallback, minimum, maximum, label) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error(`${label} is outside supported bounds.`);
  return number;
}

export function recoveryDefaults(env) {
  return {
    maximumBytes: boundedInteger(env.MYSKILLS_RECOVERY_MAXIMUM_BYTES, 512 * 1024 * 1024, limits.artifactBytes, 2 * 1024 * 1024 * 1024, "Recovery byte budget"),
    timeoutMs: boundedInteger(env.MYSKILLS_RECOVERY_TIMEOUT_MS, 600_000, 1_000, 1_800_000, "Recovery deadline"),
    outputParent: resolve(env.MYSKILLS_RECOVERY_OUTPUT_PARENT ?? tmpdir()),
    pgBin: env.MYSKILLS_RECOVERY_PG_BIN ? resolve(env.MYSKILLS_RECOVERY_PG_BIN) : null,
  };
}

export function databaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Recovery database URL is invalid."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1) || url.hash
    || [...url.searchParams.keys()].some((key) => key !== "sslmode")) throw new Error("Recovery database URL has an unsupported form or connection option.");
  return url;
}

export function storageConfiguration(env, role) {
  const prefix = `MYSKILLS_RECOVERY_${role}_S3_`;
  let endpoint;
  try { endpoint = new URL(required(env, `${prefix}ENDPOINT`)); } catch { throw new Error(`${role} object endpoint is invalid.`); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !["http:", "https:"].includes(endpoint.protocol)
    || (endpoint.protocol !== "https:" && !loopback(endpoint.hostname))) throw new Error(`${role} object endpoint requires HTTPS outside loopback and cannot contain credentials.`);
  const style = env[`${prefix}FORCE_PATH_STYLE`] ?? "true";
  if (!["true", "false"].includes(style)) throw new Error(`${role} S3 path style must be true or false.`);
  return { endpoint: endpoint.href, region: env[`${prefix}REGION`] ?? "us-east-1", forcePathStyle: style === "true", maxAttempts: 1,
    credentials: { accessKeyId: required(env, `${prefix}ACCESS_KEY_ID`), secretAccessKey: required(env, `${prefix}SECRET_ACCESS_KEY`),
      ...(env[`${prefix}SESSION_TOKEN`] ? { sessionToken: env[`${prefix}SESSION_TOKEN`] } : {}) } };
}

export function sourceConfiguration(env) {
  return { sourceDatabase: databaseUrl(required(env, "MYSKILLS_RECOVERY_SOURCE_DATABASE_URL")),
    sourceStorage: storageConfiguration(env, "SOURCE"), sourceBucket: required(env, "MYSKILLS_RECOVERY_SOURCE_S3_BUCKET") };
}

export function destinationConfiguration(env) {
  const destinationServer = databaseUrl(required(env, "MYSKILLS_RECOVERY_DESTINATION_POSTGRES_URL"));
  if (!loopback(destinationServer.hostname)) throw new Error("Recovery destination Postgres must be on loopback.");
  const destinationStorage = storageConfiguration(env, "DESTINATION");
  if (!loopback(new URL(destinationStorage.endpoint).hostname)) throw new Error("Recovery destination object storage must be on loopback.");
  return { destinationServer, destinationStorage };
}

export async function createRecoveryDirectory(config) {
  const parent = await realpath(config.outputParent);
  const inside = relative(repositoryRoot, parent);
  if (!inside || (!inside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(inside))) {
    throw new Error("Recovery backups must be stored outside the source repository.");
  }
  const root = await mkdtemp(join(parent, "myskills-recovery-"));
  await chmod(root, 0o700);
  await mkdir(join(root, "objects"), { mode: 0o700 });
  return root;
}

/** Every deadline also propagates cancellation to streams, child processes and clients. */
export async function withDeadline(milliseconds, operation, parentSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  const timer = setTimeout(() => controller.abort(new Error("Recovery deadline exceeded.")), milliseconds);
  if (parentSignal?.aborted) abort(); else parentSignal?.addEventListener("abort", abort, { once: true });
  let rejectAbort;
  const cancelled = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason); });
  controller.signal.addEventListener("abort", rejectAbort, { once: true });
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([operation(controller.signal), cancelled]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectAbort);
  }
}

/** Leave this unref timer armed until process exit, including after a cancellation race settles. */
export function armProcessDeadline(milliseconds) {
  setTimeout(() => {
    console.error(JSON.stringify({ passed: false, failedPhase: "deadline" }));
    process.exit(1);
  }, milliseconds + 1_000).unref();
}

export function postgresClient(url, signal) {
  const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: limits.connectMs,
    statement_timeout: limits.sqlMs, query_timeout: limits.sqlMs });
  const abort = () => { void client.end().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  client.once("end", () => signal.removeEventListener("abort", abort));
  // A disconnected source invalidates its advisory lock. The runner adds an abort listener too.
  client.on("error", () => {});
  return client;
}
export const storageClient = (config) => new S3Client(config);

export async function sendS3(client, command, signal) {
  return withDeadline(limits.ioMs, (ioSignal) => client.send(command, { abortSignal: ioSignal }), signal);
}

/** The deadline includes reading the body, not just receipt of response headers. */
export async function readObject(client, bucket, key, maximumBytes, signal, { path, expected, metadata, discard = false } = {}) {
  return withDeadline(limits.ioMs, async (ioSignal) => {
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: ioSignal });
    const body = object.Body;
    if (!body) throw new Error("Object response has no body.");
    const stop = () => body.destroy?.();
    ioSignal.addEventListener("abort", stop, { once: true });
    try {
      ioSignal.throwIfAborted();
      if (object.ContentLength !== undefined && (!Number.isSafeInteger(object.ContentLength) || object.ContentLength < 0 || object.ContentLength > maximumBytes)) throw new Error("Object exceeds its byte budget.");
      if (metadata && (object.ContentType !== metadata.contentType || object.Metadata?.sha256 !== metadata.sha256)) throw new Error("Object metadata differs from the snapshot.");
      const hash = createHash("sha256");
      let byteSize = 0;
      const chunks = [];
      const guard = new Transform({ transform(chunk, _encoding, callback) {
        byteSize += chunk.length;
        if (byteSize > maximumBytes) { callback(new Error("Object exceeded its byte budget.")); return; }
        hash.update(chunk); callback(null, chunk);
      } });
      const output = path ? createWriteStream(path, { flags: "wx", mode: 0o600 }) : new Writable({ write(chunk, _encoding, callback) { if (!discard) chunks.push(Buffer.from(chunk)); callback(); } });
      await pipeline(body, guard, output, { signal: ioSignal });
      const digest = hash.digest("hex");
      if (expected && (byteSize !== expected.byteSize || digest !== expected.sha256)) throw new Error("Object bytes differ from the snapshot.");
      return { byteSize, sha256: digest, ...(path || discard ? {} : { bytes: Buffer.concat(chunks) }) };
    } finally { ioSignal.removeEventListener("abort", stop); body.destroy?.(); }
  }, signal);
}

export async function putFile(client, bucket, key, path, description, signal) {
  const body = createReadStream(path);
  try {
    await sendS3(client, new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: description.byteSize,
      ContentType: description.contentType ?? "application/octet-stream", Metadata: { sha256: description.sha256 }, IfNoneMatch: "*" }), signal);
  } finally { body.destroy(); }
}

export async function fileIntegrity(path, maximumBytes, signal) {
  const hash = createHash("sha256");
  let byteSize = 0;
  await pipeline(createReadStream(path), new Writable({ write(chunk, _encoding, callback) {
    byteSize += chunk.length;
    if (byteSize > maximumBytes) { callback(new Error("File exceeds its byte budget.")); return; }
    hash.update(chunk); callback();
  } }), { signal });
  return { byteSize, sha256: hash.digest("hex") };
}

export async function captureSnapshot(config, source, sourceS3, root, context, dump = dumpDatabase) {
  const { signal, phase } = context;
  signal.throwIfAborted();
  await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await source.query("SET LOCAL lock_timeout = '5s'");
    await source.query("SET LOCAL TIME ZONE 'UTC'");
    const snapshot = (await source.query("SELECT pg_export_snapshot() AS snapshot, transaction_timestamp() AS captured_at")).rows[0];
    if (!/^[0-9A-Fa-f-]+$/.test(snapshot.snapshot)) throw new Error("Invalid snapshot identifier.");
    const identity = config.instanceId ? (await source.query("SELECT value FROM public.instance_settings WHERE key = 'instance_id'")).rows[0]?.value : undefined;
    if (config.instanceId && identity !== config.instanceId) throw new Error("Source registry identity differs from the configured backup namespace.");
    phase("fingerprint-source");
    const tables = await databaseFingerprints(source, signal);
    phase("read-artifact-manifest");
    const records = (await source.query(`SELECT id, storage_key, sha256, byte_size, content_type,
      jsonb_array_length(coalesce(payload->'files', '[]'::jsonb)) > 0 AS has_inline_payload
      FROM public.skill_artifacts ORDER BY id LIMIT 10001`)).rows;
    if (records.length > limits.artifacts) throw new Error("Artifact count exceeds its limit.");
    const declaredBytes = records.reduce((sum, item) => sum + Number(item.byte_size), 0);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > config.maximumBytes) throw new Error("Referenced artifacts exceed the recovery byte budget.");
    const artifacts = [];
    for (const artifact of records) {
      signal.throwIfAborted(); phase("copy-artifact");
      const expected = { byteSize: Number(artifact.byte_size), sha256: artifact.sha256 };
      if (!Number.isSafeInteger(expected.byteSize) || expected.byteSize < 1 || expected.byteSize > limits.artifactBytes || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw new Error("Unsupported artifact metadata.");
      const file = `${artifact.id}.bin`;
      if (!/^[a-f0-9-]+\.bin$/i.test(file)) throw new Error("Invalid artifact identity.");
      let bytes; let storage = "s3";
      try {
        ({ bytes } = await readObject(sourceS3, config.sourceBucket, artifact.storage_key, expected.byteSize, signal,
          { expected, metadata: { contentType: artifact.content_type, sha256: artifact.sha256 } }));
      } catch (error) {
        if (!isMissingObject(error) || !artifact.has_inline_payload) throw error;
        const { payload } = (await source.query("SELECT payload FROM public.skill_artifacts WHERE id = $1", [artifact.id])).rows[0];
        bytes = Buffer.from(JSON.stringify(payload)); storage = "database";
      }
      if (bytes.length !== expected.byteSize || sha256(bytes) !== expected.sha256) throw new Error("Artifact bytes differ from the recovery snapshot.");
      await writeFile(join(root, "objects", file), bytes, { flag: "wx", mode: 0o600, signal });
      artifacts.push({ id: artifact.id, key: artifact.storage_key, ...expected, contentType: artifact.content_type, storage, file });
    }
    if (config.requireObjectBacked && !artifacts.some((artifact) => artifact.storage === "s3")) throw new Error("Recovery rehearsal requires a real object-backed package, not only inline seed payloads.");
    phase("dump-source-snapshot");
    const database = await dump(config, snapshot.snapshot, join(root, "database.dump"), signal);
    await source.query("COMMIT");
    const manifest = { schemaVersion: 1, capturedAt: new Date(snapshot.captured_at).toISOString(), database, tables, artifacts,
      ...(identity ? { instanceId: identity } : {}) };
    await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600, signal });
    return manifest;
  } catch (error) {
    if (!signal.aborted) await source.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function databaseFingerprints(client, signal) {
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename LIMIT 257")).rows;
  if (tables.length > limits.tables) throw new Error("Database table count exceeds its limit.");
  const result = [];
  for (const { tablename } of tables) {
    signal.throwIfAborted();
    const table = `public.${identifier(tablename)}`;
    const count = Number((await client.query(`SELECT count(*)::text AS count FROM ${table}`)).rows[0].count);
    if (!Number.isSafeInteger(count) || count > limits.rows) throw new Error("A table exceeds the bounded recovery row limit.");
    // Equality fingerprint, not authentication. Files are checked separately with SHA-256.
    const { fingerprint } = (await client.query(`SELECT md5(coalesce(string_agg(md5(to_jsonb(row)::text), '' ORDER BY md5(to_jsonb(row)::text)), '')) AS fingerprint FROM ${table} AS row`)).rows[0];
    result.push({ table: tablename, rows: count, fingerprint });
  }
  return result;
}

async function dumpDatabase(config, snapshot, archivePath, signal) {
  const child = postgresProcess(config, "pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--schema=public", `--snapshot=${snapshot}`], config.sourceDatabase, signal);
  const hash = createHash("sha256"); let byteSize = 0;
  const guard = new Transform({ transform(chunk, _encoding, callback) {
    byteSize += chunk.length;
    if (byteSize > config.maximumBytes) { child.kill("SIGKILL"); callback(new Error("Database archive exceeded the byte budget.")); return; }
    hash.update(chunk); callback(null, chunk);
  } });
  try { await Promise.all([pipeline(child.stdout, guard, createWriteStream(archivePath, { flags: "wx", mode: 0o600 }), { signal }), child.completion]); }
  finally { child.kill("SIGKILL"); }
  return { file: "database.dump", byteSize, sha256: hash.digest("hex") };
}

export function postgresProcess(config, program, args, url, signal) {
  signal.throwIfAborted();
  const env = { PATH: process.env.PATH, PGHOST: url.hostname.replace(/^\[|\]$/g, ""), PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: url.searchParams.get("sslmode") ?? "prefer", PGCONNECT_TIMEOUT: "10" };
  const child = spawn(config.pgBin ? join(config.pgBin, program) : program, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.resume();
  child.completion = new Promise((resolvePromise, reject) => {
    const stop = () => { child.kill("SIGKILL"); reject(new Error("Postgres recovery command cancelled.")); };
    const timer = setTimeout(stop, limits.sqlMs);
    signal.addEventListener("abort", stop, { once: true });
    const clean = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); };
    child.once("error", () => { clean(); reject(new Error("Postgres recovery executable could not start.")); });
    child.once("close", (code) => { clean(); if (code === 0) resolvePromise(); else reject(new Error("Postgres recovery command failed.")); });
  });
  return child;
}

export async function restoreSnapshot(config, manifest, root, context, dependencies = {}) {
  const { signal, phase } = context;
  if (!loopback(config.destinationServer.hostname) || !loopback(new URL(config.destinationStorage.endpoint).hostname)) throw new Error("Restore destinations must be on loopback.");
  const makePg = dependencies.postgresClient ?? postgresClient;
  const admin = makePg(config.destinationServer, signal);
  const s3 = (dependencies.storageClient ?? storageClient)(config.destinationStorage);
  const suffix = `${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
  const destinationDatabase = `myskills_recovery_${suffix}`;
  const destinationBucket = `myskills-recovery-${suffix.replaceAll("_", "-")}`;
  let destination;
  try {
    // Verify all local bytes before any destination is created (including the database archive).
    phase("verify-local-backup");
    for (const file of [{ ...manifest.database, local: "database.dump" }, ...manifest.artifacts.map((item) => ({ ...item, local: `objects/${item.file}` }))]) {
      const actual = await fileIntegrity(join(root, file.local), file.byteSize, signal);
      if (actual.byteSize !== file.byteSize || actual.sha256 !== file.sha256) throw new Error("Backup file failed integrity verification.");
    }
    phase("create-isolated-destinations");
    await admin.connect();
    if ((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [destinationDatabase])).rowCount) throw new Error("Recovery destination database already exists.");
    let absent = false;
    try { await sendS3(s3, new HeadBucketCommand({ Bucket: destinationBucket }), signal); }
    catch (error) { if (isMissingObject(error)) absent = true; else throw error; }
    if (!absent) throw new Error("Recovery destination bucket already exists.");
    // Record reserved identities before creation, including when a process exits before its catch handler.
    const destinations = { destinationDatabase, destinationBucket };
    context.onDestinations?.(destinations);
    await writeFile(join(root, "destinations.json"), `${JSON.stringify(destinations)}\n`, { flag: "wx", mode: 0o600, signal });
    await admin.query(`CREATE DATABASE ${identifier(destinationDatabase)} TEMPLATE template0`);
    await sendS3(s3, new CreateBucketCommand({ Bucket: destinationBucket }), signal);
    const url = new URL(config.destinationServer.href); url.pathname = `/${destinationDatabase}`;
    phase("restore-database");
    // Never --create: the archive must not select its original database.
    if (dependencies.restoreDatabase) await dependencies.restoreDatabase(config, url, root, signal);
    else {
      const child = postgresProcess(config, "pg_restore", ["--clean", "--if-exists", "--no-owner", "--no-acl", "--exit-on-error", "--dbname", destinationDatabase, join(root, "database.dump")], url, signal);
      child.stdout.resume(); await child.completion;
    }
    destination = makePg(url, signal); await destination.connect();
    await destination.query("SET TIME ZONE 'UTC'");
    phase("restore-artifacts");
    for (const artifact of manifest.artifacts) {
      signal.throwIfAborted();
      if (artifact.storage === "database") continue;
      await putFile(s3, destinationBucket, artifact.key, join(root, "objects", artifact.file), artifact, signal);
      await readObject(s3, destinationBucket, artifact.key, artifact.byteSize, signal, { expected: artifact, metadata: artifact });
    }
    phase("verify-restored-database");
    if (JSON.stringify(await databaseFingerprints(destination, signal)) !== JSON.stringify(manifest.tables)) throw new Error("Restored table contents differ from the source snapshot.");
    return { destinationDatabase, destinationBucket, restoredApplicationRuntime: "not-tested" };
  } finally { s3.destroy(); await Promise.allSettled([admin.end(), destination?.end()]); }
}

export function snapshotStatus(manifest) {
  return { capturedAt: manifest.capturedAt, tableCount: manifest.tables.length, artifactCount: manifest.artifacts.length,
    objectBackedCount: manifest.artifacts.filter((item) => item.storage === "s3").length,
    artifactBytes: manifest.artifacts.reduce((sum, item) => sum + item.byteSize, 0),
    databaseDumpSha256: manifest.database.sha256, databaseDumpBytes: manifest.database.byteSize, sourceWrites: false };
}
