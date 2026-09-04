#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const maximumArtifactBytes = 14 * 1024 * 1024;
const maximumRowsPerTable = 1_000_000;
const timeoutMs = 180_000;

/** No network or file changes. Restore destinations are always newly created on loopback. */
export function recoveryConfiguration(env = process.env) {
  const sourceDatabase = databaseUrl(required(env, "MYSKILLS_RECOVERY_SOURCE_DATABASE_URL"));
  const destinationServer = databaseUrl(required(env, "MYSKILLS_RECOVERY_DESTINATION_POSTGRES_URL"));
  if (!loopback(destinationServer.hostname)) throw new Error("Recovery destination Postgres must be on loopback.");
  const sourceStorage = storageConfiguration(env, "SOURCE");
  const destinationStorage = storageConfiguration(env, "DESTINATION");
  if (!loopback(new URL(destinationStorage.endpoint).hostname)) throw new Error("Recovery destination object storage must be on loopback.");
  const maximumBytes = Number(env.MYSKILLS_RECOVERY_MAXIMUM_BYTES ?? 512 * 1024 * 1024);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < maximumArtifactBytes || maximumBytes > 2 * 1024 * 1024 * 1024) {
    throw new Error("Recovery byte budget must be an integer from 14 MiB through 2 GiB.");
  }
  return {
    sourceDatabase,
    destinationServer,
    sourceStorage,
    destinationStorage,
    maximumBytes,
    sourceBucket: required(env, "MYSKILLS_RECOVERY_SOURCE_S3_BUCKET"),
    outputParent: resolve(env.MYSKILLS_RECOVERY_OUTPUT_PARENT ?? tmpdir()),
    pgBin: env.MYSKILLS_RECOVERY_PG_BIN ? resolve(env.MYSKILLS_RECOVERY_PG_BIN) : null,
  };
}

/** Backup is read-only against source. No existing database or bucket is reset or deleted. */
export async function rehearseRegistryRecovery(env = process.env) {
  const config = recoveryConfiguration(env);
  const parent = await realpath(config.outputParent);
  const withinRepository = relative(repositoryRoot, parent);
  if (!withinRepository || (!withinRepository.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(withinRepository))) {
    throw new Error("Recovery backups must be stored outside the source repository.");
  }
  const recoveryRoot = await mkdtemp(join(parent, "myskills-recovery-"));
  await chmod(recoveryRoot, 0o700);
  const objectDirectory = join(recoveryRoot, "objects");
  await mkdir(objectDirectory, { mode: 0o700 });
  const suffix = `${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
  const destinationDatabase = `myskills_recovery_${suffix}`;
  const destinationBucket = `myskills-recovery-${suffix.replaceAll("_", "-")}`;
  const source = new pg.Client({ connectionString: config.sourceDatabase.href, statement_timeout: timeoutMs, query_timeout: timeoutMs });
  const destinationAdmin = new pg.Client({ connectionString: config.destinationServer.href, connectionTimeoutMillis: 10_000 });
  const sourceS3 = new S3Client(config.sourceStorage);
  const destinationS3 = new S3Client(config.destinationStorage);
  let destination;
  let phase = "connect-source";
  let copiedBytes = 0;
  let sourceOpen = false;
  const startedAt = new Date().toISOString();
  const safeStatus = { schemaVersion: 1, passed: false, startedAt, destinationDatabase, destinationBucket };
  try {
    await source.connect();
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    sourceOpen = true;
    await source.query("SET LOCAL lock_timeout = '5s'");
    await source.query("SET LOCAL TIME ZONE 'UTC'");
    const snapshot = (await source.query("SELECT pg_export_snapshot() AS snapshot, transaction_timestamp() AS captured_at")).rows[0];
    if (!/^[0-9A-Fa-f-]+$/.test(snapshot.snapshot)) throw new Error("Source returned an invalid snapshot identifier.");
    phase = "fingerprint-source";
    const before = await databaseFingerprints(source);
    phase = "read-artifact-manifest";
    const records = (await source.query(`SELECT id, storage_key, sha256, byte_size, content_type,
      jsonb_array_length(coalesce(payload->'files', '[]'::jsonb)) > 0 AS has_inline_payload
      FROM public.skill_artifacts ORDER BY id LIMIT 10001`)).rows;
    if (records.length > 10_000) throw new Error("Artifact count exceeds the bounded recovery rehearsal limit.");
    const declaredBytes = records.reduce((sum, artifact) => sum + Number(artifact.byte_size), 0);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > config.maximumBytes) throw new Error("Referenced artifacts exceed the recovery byte budget.");
    const artifacts = [];
    for (const artifact of records) {
      phase = "copy-artifact";
      const expectedSize = Number(artifact.byte_size);
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > maximumArtifactBytes || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
        throw new Error("Source artifact metadata is outside supported bounds.");
      }
      let bytes;
      let storage = "s3";
      try {
        const object = await sourceS3.send(new GetObjectCommand({ Bucket: config.sourceBucket, Key: artifact.storage_key }), { abortSignal: AbortSignal.timeout(30_000) });
        bytes = await objectBytes(object.Body, expectedSize);
        if (object.ContentType !== artifact.content_type || object.Metadata?.sha256 !== artifact.sha256) throw new Error("Object metadata differs from the database recovery snapshot.");
      } catch (error) {
        if (!isMissingObject(error) || !artifact.has_inline_payload) throw error;
        const { payload } = (await source.query("SELECT payload FROM public.skill_artifacts WHERE id = $1", [artifact.id])).rows[0];
        bytes = Buffer.from(JSON.stringify(payload));
        storage = "database";
      }
      if (bytes.length !== expectedSize || sha256(bytes) !== artifact.sha256) throw new Error("Artifact bytes differ from the database recovery snapshot.");
      copiedBytes += bytes.length;
      if (copiedBytes > config.maximumBytes) throw new Error("Recovery artifact byte budget exceeded.");
      const file = `${artifact.id}.bin`;
      if (!/^[a-f0-9-]+\.bin$/i.test(file)) throw new Error("Artifact identity is invalid.");
      await writeFile(join(objectDirectory, file), bytes, { flag: "wx", mode: 0o600 });
      artifacts.push({ id: artifact.id, key: artifact.storage_key, sha256: artifact.sha256, byteSize: expectedSize, contentType: artifact.content_type, storage, file });
    }
    if (!artifacts.some((artifact) => artifact.storage === "s3")) throw new Error("Recovery rehearsal requires a real object-backed package, not only inline seed payloads.");
    phase = "dump-source-snapshot";
    const archivePath = join(recoveryRoot, "database.dump");
    const archive = await dumpDatabase(config, snapshot.snapshot, archivePath);
    await source.query("COMMIT");
    sourceOpen = false;
    const manifest = { schemaVersion: 1, capturedAt: snapshot.captured_at, database: archive, tables: before, artifacts };
    await writeFile(join(recoveryRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });

    // Restore only the snapshot just captured. The random destination cannot name an existing database or bucket.
    phase = "create-isolated-destinations";
    await destinationAdmin.connect();
    const existing = await destinationAdmin.query("SELECT 1 FROM pg_database WHERE datname = $1", [destinationDatabase]);
    if (existing.rowCount) throw new Error("Recovery destination database already exists.");
    await assertBucketAbsent(destinationS3, destinationBucket);
    await destinationAdmin.query(`CREATE DATABASE ${identifier(destinationDatabase)} TEMPLATE template0`);
    await destinationS3.send(new CreateBucketCommand({ Bucket: destinationBucket }), { abortSignal: AbortSignal.timeout(30_000) });
    const restoredUrl = new URL(config.destinationServer.href);
    restoredUrl.pathname = `/${destinationDatabase}`;
    phase = "restore-database";
    // pg_restore --create is deliberately not used: it can select the original source database name.
    await restoreDatabase(config, restoredUrl, archivePath);
    destination = new pg.Client({ connectionString: restoredUrl.href, statement_timeout: timeoutMs, query_timeout: timeoutMs });
    await destination.connect();
    await destination.query("SET TIME ZONE 'UTC'");
    phase = "restore-artifacts";
    for (const artifact of artifacts) {
      const bytes = await readFile(join(objectDirectory, artifact.file));
      if (bytes.length !== artifact.byteSize || sha256(bytes) !== artifact.sha256) throw new Error("Backup artifact changed before restore.");
      if (artifact.storage === "database") continue;
      await destinationS3.send(new PutObjectCommand({ Bucket: destinationBucket, Key: artifact.key, Body: bytes,
        ContentLength: bytes.length, ContentType: artifact.contentType, Metadata: { sha256: artifact.sha256 }, IfNoneMatch: "*" }), { abortSignal: AbortSignal.timeout(30_000) });
      const restored = await destinationS3.send(new GetObjectCommand({ Bucket: destinationBucket, Key: artifact.key }), { abortSignal: AbortSignal.timeout(30_000) });
      if (restored.ContentType !== artifact.contentType || restored.Metadata?.sha256 !== artifact.sha256
        || sha256(await objectBytes(restored.Body, artifact.byteSize)) !== artifact.sha256) throw new Error("Restored object failed byte and metadata verification.");
    }
    phase = "verify-restored-database";
    const after = await databaseFingerprints(destination);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Restored table contents differ from the source snapshot.");
    const report = { ...safeStatus, passed: true, capturedAt: snapshot.captured_at, completedAt: new Date().toISOString(),
      elapsedSeconds: Math.ceil((Date.now() - new Date(startedAt).getTime()) / 1000),
      tableCount: before.length, artifactCount: artifacts.length, objectBackedCount: artifacts.filter((artifact) => artifact.storage === "s3").length,
      artifactBytes: copiedBytes, databaseDumpSha256: archive.sha256, databaseDumpBytes: archive.byteSize,
      sourceWrites: false, restoredApplicationRuntime: "not-tested" };
    await writeFile(join(recoveryRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return { report, recoveryRoot };
  } catch {
    // Raw pg/S3 errors can include connection strings, object keys, or database contents.
    await writeFile(join(recoveryRoot, "failure.json"), `${JSON.stringify({ ...safeStatus, failedPhase: phase }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    throw new Error(`Recovery rehearsal failed during ${phase}. Partial backup and isolated destinations were retained for operator inspection.`);
  } finally {
    if (sourceOpen) await source.query("ROLLBACK").catch(() => {});
    await Promise.allSettled([source.end(), destinationAdmin.end(), destination?.end()]);
    sourceS3.destroy();
    destinationS3.destroy();
  }
}

async function databaseFingerprints(client) {
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows;
  const result = [];
  for (const { tablename } of tables) {
    const table = `public.${identifier(tablename)}`;
    const count = Number((await client.query(`SELECT count(*)::text AS count FROM ${table}`)).rows[0].count);
    if (count > maximumRowsPerTable) throw new Error("A table exceeds the bounded rehearsal row limit.");
    // This comparison fingerprint is not a signature. The archive and artifact integrity checks use SHA-256.
    const { fingerprint } = (await client.query(`SELECT md5(coalesce(string_agg(md5(to_jsonb(row)::text), '' ORDER BY md5(to_jsonb(row)::text)), '')) AS fingerprint FROM ${table} AS row`)).rows[0];
    result.push({ table: tablename, rows: count, fingerprint });
  }
  return result;
}

async function dumpDatabase(config, snapshot, archivePath) {
  const child = postgresProcess(config, "pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--schema=public", `--snapshot=${snapshot}`], config.sourceDatabase);
  const hash = createHash("sha256");
  let byteSize = 0;
  const guard = new Transform({ transform(chunk, _encoding, callback) {
    byteSize += chunk.length;
    if (byteSize > config.maximumBytes) { child.kill("SIGKILL"); callback(new Error("Database archive exceeded the byte budget.")); return; }
    hash.update(chunk);
    callback(null, chunk);
  } });
  await Promise.all([pipeline(child.stdout, guard, createWriteStream(archivePath, { flags: "wx", mode: 0o600 })), child.completion]);
  return { file: "database.dump", byteSize, sha256: hash.digest("hex") };
}

async function restoreDatabase(config, url, archivePath) {
  // --clean only rebuilds the empty schema in the database created immediately above.
  // There is no caller-supplied restore database name and no --create that could select the source name.
  const child = postgresProcess(config, "pg_restore", ["--clean", "--if-exists", "--no-owner", "--no-acl", "--exit-on-error", "--dbname", decodeURIComponent(url.pathname.slice(1)), archivePath], url);
  child.stdout.resume();
  await child.completion;
}

function postgresProcess(config, program, args, url) {
  const databaseEnv = {
    PATH: process.env.PATH,
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: url.searchParams.get("sslmode") ?? "prefer",
    PGCONNECT_TIMEOUT: "10",
  };
  const child = spawn(config.pgBin ? join(config.pgBin, program) : program, args, { env: databaseEnv, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.resume();
  child.completion = new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Postgres recovery command timed out.")); }, timeoutMs);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Postgres recovery executable could not start.")); });
    child.once("close", (code) => { clearTimeout(timer); if (code === 0) resolvePromise(); else reject(new Error("Postgres recovery command failed.")); });
  });
  return child;
}

async function assertBucketAbsent(client, bucket) {
  try { await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(10_000) }); }
  catch (error) { if (error?.$metadata?.httpStatusCode === 404) return; throw error; }
  throw new Error("Recovery destination bucket already exists.");
}

async function objectBytes(body, expectedSize) {
  if (!body) throw new Error("Object response has no body.");
  const chunks = [];
  let length = 0;
  for await (const chunk of body) {
    length += chunk.length;
    if (length > expectedSize || length > maximumArtifactBytes) { body.destroy?.(); throw new Error("Object exceeded declared size."); }
    chunks.push(Buffer.from(chunk));
  }
  if (length !== expectedSize) throw new Error("Object size differs from declared size.");
  return Buffer.concat(chunks);
}

function storageConfiguration(env, role) {
  let endpoint;
  try { endpoint = new URL(required(env, `MYSKILLS_RECOVERY_${role}_S3_ENDPOINT`)); } catch { throw new Error(`${role} object endpoint is invalid.`); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !["http:", "https:"].includes(endpoint.protocol)
    || (endpoint.protocol !== "https:" && !loopback(endpoint.hostname))) throw new Error(`${role} object endpoint requires HTTPS outside loopback and cannot contain credentials.`);
  return { endpoint: endpoint.href, region: env[`MYSKILLS_RECOVERY_${role}_S3_REGION`] ?? "us-east-1", forcePathStyle: true,
    credentials: { accessKeyId: required(env, `MYSKILLS_RECOVERY_${role}_S3_ACCESS_KEY_ID`), secretAccessKey: required(env, `MYSKILLS_RECOVERY_${role}_S3_SECRET_ACCESS_KEY`),
      ...(env[`MYSKILLS_RECOVERY_${role}_S3_SESSION_TOKEN`] ? { sessionToken: env[`MYSKILLS_RECOVERY_${role}_S3_SESSION_TOKEN`] } : {}) } };
}

function databaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Recovery database URL is invalid."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1) || url.hash
    || [...url.searchParams.keys()].some((key) => key !== "sslmode")) throw new Error("Recovery database URL has an unsupported form or connection option.");
  return url;
}

function identifier(value) { return `"${value.replaceAll('"', '""')}"`; }
function loopback(host) { return ["localhost", "127.0.0.1", "[::1]"].includes(host); }
function required(env, key) { const value = env[key]?.trim(); if (!value) throw new Error(`${key} is required.`); return value; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function isMissingObject(error) { return error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404; }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: node scripts/rehearse-registry-recovery.mjs --plan | --execute");
    console.log("Copies one consistent source snapshot to newly created loopback Postgres/S3 destinations. Backups contain private application data. See docs/OPERATIONAL_ACCEPTANCE.md.");
  } else if (args.length === 1 && ["--plan", "--execute"].includes(args[0])) {
    try {
      if (args[0] === "--plan") {
        const config = recoveryConfiguration();
        console.log(JSON.stringify({ sourceReadOnly: true, destination: "new loopback database and object bucket", maximumBytesPerArchiveOrArtifacts: config.maximumBytes }));
      } else {
        const { report, recoveryRoot } = await rehearseRegistryRecovery();
        console.log(JSON.stringify(report, null, 2));
        console.log(`Private recovery evidence: ${recoveryRoot}`);
      }
    } catch (error) { console.error(error instanceof Error ? error.message : "Recovery rehearsal failed."); process.exitCode = 1; }
  } else { console.error("Use --plan or --execute. Run --help for prerequisites."); process.exitCode = 1; }
}
