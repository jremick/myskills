import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { boundedInteger, captureSnapshot, createRecoveryDirectory, destinationConfiguration, isMissingObject, limits,
  postgresClient, putFile, readObject, recoveryDefaults, required, restoreSnapshot, sendS3, sha256,
  snapshotStatus, sourceConfiguration, storageClient, storageConfiguration, withDeadline } from "./registry-recovery.mjs";

const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const runPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z_[a-f0-9]{16}$/;
const markerLimit = 4_096;
const metadataBudget = 64 * 1024 * 1024;
const lockName = "myskills-registry-backup-v1";

export function backupConfiguration(env = process.env, mode = "execute") {
  const instanceId = required(env, "MYSKILLS_BACKUP_INSTANCE_ID");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(instanceId)) throw new Error("Backup instance identity is invalid.");
  const config = { ...recoveryDefaults(env), instanceId, namespace: `registry-v1/${instanceId}/`,
    backupStorage: storageConfiguration(env, "BACKUP"), backupBucket: required(env, "MYSKILLS_RECOVERY_BACKUP_S3_BUCKET"),
    freshnessMs: 26 * 60 * 60 * 1000, retentionDays: 7 };
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.backupBucket)) throw new Error("Backup bucket name is invalid.");
  if (mode === "execute") {
    Object.assign(config, sourceConfiguration(env));
    // A distinct destination name is required even if endpoints or credentials differ.
    if (config.sourceBucket === config.backupBucket) throw new Error("Backup bucket must differ from the source artifact bucket.");
  } else if (mode === "restore") Object.assign(config, destinationConfiguration(env));
  else if (mode !== "status") throw new Error("Unsupported backup mode.");
  return config;
}

function object(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key))) throw new Error("Backup metadata has an unsupported shape.");
}
function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Backup timestamp is invalid.");
}
function digestFile(value, maximumBytes) {
  if (!hashPattern.test(value.sha256) || typeof value.sha256 !== "string") throw new Error("Backup digest is invalid.");
  boundedInteger(value.byteSize, -1, 1, maximumBytes, "Backup file size");
  if (typeof value.byteSize !== "number") throw new Error("Backup file size must be numeric.");
}

export function validateManifest(manifest, config) {
  object(manifest, ["schemaVersion", "capturedAt", "database", "tables", "artifacts", "instanceId"]);
  if (manifest.schemaVersion !== 1 || manifest.instanceId !== config.instanceId) throw new Error("Backup manifest identity or version differs.");
  timestamp(manifest.capturedAt);
  object(manifest.database, ["file", "byteSize", "sha256"]);
  if (manifest.database.file !== "database.dump") throw new Error("Backup archive path is invalid.");
  digestFile(manifest.database, config.maximumBytes);
  if (!Array.isArray(manifest.tables) || manifest.tables.length < 1 || manifest.tables.length > limits.tables) throw new Error("Backup table count is invalid.");
  const tables = new Set();
  for (const table of manifest.tables) {
    object(table, ["table", "rows", "fingerprint"]);
    if (typeof table.table !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(table.table) || tables.has(table.table)
      || !Number.isSafeInteger(table.rows) || table.rows < 0 || table.rows > limits.rows || typeof table.fingerprint !== "string" || !/^[a-f0-9]{32}$/.test(table.fingerprint)) throw new Error("Backup table metadata is invalid.");
    tables.add(table.table);
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length > limits.artifacts) throw new Error("Backup artifact count is invalid.");
  const identities = new Set(); const keys = new Set(); let bytes = 0;
  for (const artifact of manifest.artifacts) {
    object(artifact, ["id", "key", "sha256", "byteSize", "contentType", "storage", "file"]);
    if (typeof artifact.id !== "string" || !idPattern.test(artifact.id) || identities.has(artifact.id) || artifact.file !== `${artifact.id}.bin`
      || typeof artifact.key !== "string" || Buffer.byteLength(artifact.key) < 1 || Buffer.byteLength(artifact.key) > 1024 || [...artifact.key].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || keys.has(artifact.key)
      || typeof artifact.contentType !== "string" || !/^[\x20-\x7e]{1,128}$/.test(artifact.contentType) || !["s3", "database"].includes(artifact.storage)) throw new Error("Backup artifact metadata is invalid.");
    digestFile(artifact, limits.artifactBytes);
    bytes += artifact.byteSize; identities.add(artifact.id); keys.add(artifact.key);
  }
  if (bytes > config.maximumBytes) throw new Error("Backup artifact bytes exceed their budget.");
  return manifest;
}

export function runPrefix(config, runId) {
  if (typeof runId !== "string" || !runPattern.test(runId)) throw new Error("Backup run identity is invalid.");
  return `${config.namespace}${runId}/`;
}
function validateMarker(marker, config, runId) {
  object(marker, ["schemaVersion", "namespace", "runId", "capturedAt", "completedAt", "manifest"]);
  if (marker.schemaVersion !== 1 || marker.namespace !== config.namespace || marker.runId !== runId) throw new Error("Backup completion marker is outside the requested namespace.");
  runPrefix(config, marker.runId); timestamp(marker.capturedAt); timestamp(marker.completedAt);
  if (Date.parse(marker.completedAt) < Date.parse(marker.capturedAt) || Date.parse(marker.capturedAt) > Date.now() + 60_000) throw new Error("Backup completion time is invalid.");
  object(marker.manifest, ["byteSize", "sha256"]); digestFile(marker.manifest, limits.manifestBytes);
  return marker;
}
const localFiles = (manifest) => [{ ...manifest.database, path: "database.dump" }, ...manifest.artifacts.map((item) => ({ ...item, path: `objects/${item.file}` }))];

async function listRuns(client, config, signal) {
  const runs = new Set(); const tokens = new Set(); let token;
  for (let page = 0; page < 16; page++) {
    signal.throwIfAborted();
    const response = await sendS3(client, new ListObjectsV2Command({ Bucket: config.backupBucket, Prefix: config.namespace, Delimiter: "/", MaxKeys: 100, ...(token ? { ContinuationToken: token } : {}) }), signal);
    if ((response.Contents ?? []).length) throw new Error("Unexpected objects in the backup namespace; retention refused.");
    for (const entry of response.CommonPrefixes ?? []) {
      if (typeof entry.Prefix !== "string" || !entry.Prefix.startsWith(config.namespace) || !entry.Prefix.endsWith("/")) throw new Error("Foreign backup prefix; retention refused.");
      const runId = entry.Prefix.slice(config.namespace.length, -1);
      if (runPrefix(config, runId) !== entry.Prefix) throw new Error("Foreign backup prefix; retention refused.");
      runs.add(runId);
      if (runs.size > 128) throw new Error("Backup listing exceeds its run budget; operator cleanup required.");
    }
    if (!response.IsTruncated) return [...runs];
    token = response.NextContinuationToken;
    if (typeof token !== "string" || !token || token.length > 4096 || tokens.has(token)) throw new Error("Backup pagination is incomplete; retention refused.");
    tokens.add(token);
  }
  throw new Error("Backup listing exceeds its page budget; retention refused.");
}

export async function loadCompletedSet(client, config, runId, signal) {
  const prefix = runPrefix(config, runId);
  const markerObject = await readObject(client, config.backupBucket, `${prefix}complete.json`, markerLimit, signal);
  const marker = validateMarker(JSON.parse(markerObject.bytes.toString("utf8")), config, runId);
  const contents = await readObject(client, config.backupBucket, `${prefix}manifest.json`, marker.manifest.byteSize, signal, { expected: marker.manifest });
  const manifest = validateManifest(JSON.parse(contents.bytes.toString("utf8")), config);
  if (manifest.capturedAt !== marker.capturedAt) throw new Error("Backup snapshot times differ.");
  return { marker, manifest, manifestBytes: contents.bytes, markerSha256: markerObject.sha256 };
}

async function completedSets(client, config, signal) {
  const runs = await listRuns(client, config, signal);
  const sets = []; let bytes = 0;
  for (const runId of runs) {
    let set;
    try { set = await loadCompletedSet(client, config, runId, signal); }
    catch (error) {
      // Only a missing completion marker is an incomplete attempt; a missing manifest is corruption.
      if (isMissingObject(error)) {
        try { await readObject(client, config.backupBucket, `${runPrefix(config, runId)}complete.json`, markerLimit, signal); }
        catch (check) { if (isMissingObject(check)) continue; throw check; }
      }
      throw error;
    }
    bytes += set.marker.manifest.byteSize;
    if (bytes > metadataBudget) throw new Error("Backup manifests exceed the metadata budget.");
    sets.push(set);
  }
  return sets;
}

/** One newest completed set per UTC capture day. Attempts never consume retention days. */
export function retentionCandidates(sets, config, currentRunId) {
  if (!sets.some((set) => set.marker.runId === currentRunId)) throw new Error("Current verified backup is missing; retention refused.");
  const ordered = [...sets].sort((a, b) => b.manifest.capturedAt.localeCompare(a.manifest.capturedAt) || b.marker.runId.localeCompare(a.marker.runId));
  const keptDays = new Set(); const remove = [];
  for (const set of ordered) {
    validateManifest(set.manifest, config); validateMarker(set.marker, config, set.marker.runId);
    const day = set.manifest.capturedAt.slice(0, 10);
    if (keptDays.has(day) || keptDays.size >= config.retentionDays) remove.push(set);
    else keptDays.add(day);
  }
  if (remove.some((set) => set.marker.runId === currentRunId)) throw new Error("Current backup is not the newest recovery point; retention refused.");
  if (remove.length > 16) throw new Error("Retention deletion budget exceeded; operator cleanup required.");
  return remove;
}

async function pruneCompletedSets(client, config, candidates, signal) {
  let deleted = 0;
  for (const set of candidates) {
    const prefix = runPrefix(config, set.marker.runId);
    const reread = await readObject(client, config.backupBucket, `${prefix}complete.json`, markerLimit, signal);
    if (reread.sha256 !== set.markerSha256) throw new Error("Backup completion marker changed; retention refused.");
    // Unpublish first. An interrupted deletion leaves an incomplete set for explicit operator inspection.
    for (const path of ["complete.json", "manifest.json", ...localFiles(set.manifest).map((file) => file.path)]) {
      signal.throwIfAborted();
      await sendS3(client, new DeleteObjectCommand({ Bucket: config.backupBucket, Key: `${prefix}${path}` }), signal);
    }
    deleted++;
  }
  return deleted;
}

export async function publishBackup(client, config, manifest, root, runId, signal) {
  validateManifest(manifest, config);
  const prefix = runPrefix(config, runId);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  if (manifestBytes.length > limits.manifestBytes) throw new Error("Backup manifest exceeds its byte budget.");
  for (const file of localFiles(manifest)) {
    signal.throwIfAborted();
    await putFile(client, config.backupBucket, `${prefix}${file.path}`, join(root, file.path), file, signal);
    await readObject(client, config.backupBucket, `${prefix}${file.path}`, file.byteSize, signal, { expected: file, discard: true });
  }
  const manifestDescription = { byteSize: manifestBytes.length, sha256: sha256(manifestBytes) };
  await sendS3(client, new PutObjectCommand({ Bucket: config.backupBucket, Key: `${prefix}manifest.json`, Body: manifestBytes, ContentType: "application/json", IfNoneMatch: "*" }), signal);
  await readObject(client, config.backupBucket, `${prefix}manifest.json`, manifestBytes.length, signal, { expected: manifestDescription });
  const marker = { schemaVersion: 1, namespace: config.namespace, runId, capturedAt: manifest.capturedAt, completedAt: new Date().toISOString(), manifest: manifestDescription };
  await sendS3(client, new PutObjectCommand({ Bucket: config.backupBucket, Key: `${prefix}complete.json`, Body: Buffer.from(JSON.stringify(marker)), ContentType: "application/json", IfNoneMatch: "*" }), signal);
  const readback = await loadCompletedSet(client, config, runId, signal);
  if (JSON.stringify(readback.marker) !== JSON.stringify(marker)) throw new Error("Backup completion readback differs.");
  return readback;
}

/** Connection loss immediately cancels storage work and invalidates permission to prune. */
export async function withBackupLock(client, signal, operation) {
  const controller = new AbortController();
  const lost = () => controller.abort(new Error("Backup source connection was lost."));
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  client.on("error", lost); client.on("end", lost);
  try {
    signal.throwIfAborted();
    await client.connect();
    // Session settings and advisory locks do not mutate source application data.
    await client.query("SET default_transaction_read_only = on");
    const result = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [lockName]);
    if (result.rows[0]?.acquired !== true) throw new Error("Another registry backup is already running.");
    return await withDeadline(1_800_000, operation, controller.signal);
  } finally {
    client.off("error", lost); client.off("end", lost); signal.removeEventListener("abort", abort);
    // Closing the session releases the lock even after cancellation; no persistent lease is written.
    await client.end();
  }
}

export async function runRegistryBackup(env = process.env, dependencies = {}) {
  const config = backupConfiguration(env);
  const runId = `${new Date().toISOString().replaceAll(":", "-")}_${randomBytes(8).toString("hex")}`;
  const startedAt = new Date().toISOString(); let failedPhase = "connect-source"; let root;
  try {
    return await withDeadline(config.timeoutMs, async (signal) => {
      const source = (dependencies.postgresClient ?? postgresClient)(config.sourceDatabase, signal);
      const makeStorage = dependencies.storageClient ?? storageClient;
      const sourceS3 = makeStorage(config.sourceStorage); const backupS3 = makeStorage(config.backupStorage);
      try {
        return await withBackupLock(source, signal, async (lockSignal) => {
          root = await createRecoveryDirectory(config);
          const context = { signal: lockSignal, phase: (value) => { failedPhase = value; } };
          const manifest = await (dependencies.captureSnapshot ?? captureSnapshot)(config, source, sourceS3, root, context);
          failedPhase = "upload-and-verify";
          const completed = await publishBackup(backupS3, config, manifest, root, runId, lockSignal);
          failedPhase = "retention";
          const sets = await completedSets(backupS3, config, lockSignal);
          const deletedSets = await pruneCompletedSets(backupS3, config, retentionCandidates(sets, config, runId), lockSignal);
          return { schemaVersion: 1, passed: true, runId, startedAt, completedAt: completed.marker.completedAt,
            elapsedSeconds: Math.ceil((Date.now() - Date.parse(startedAt)) / 1000), ...snapshotStatus(manifest),
            manifestSha256: completed.marker.manifest.sha256, deletedSets, retentionDays: config.retentionDays };
        });
      } finally { sourceS3.destroy(); backupS3.destroy(); }
    });
  } catch {
    // Never include raw SQL/S3 errors, connection strings, artifact names or private contents.
    return { schemaVersion: 1, passed: false, runId, startedAt, failedPhase, sourceWrites: false };
  } finally { if (root) await rm(root, { recursive: true, force: true }); }
}

export async function registryBackupStatus(env = process.env, dependencies = {}) {
  const config = backupConfiguration(env, "status");
  return withDeadline(Math.min(config.timeoutMs, 60_000), async (signal) => {
    const client = (dependencies.storageClient ?? storageClient)(config.backupStorage);
    try {
      const sets = await completedSets(client, config, signal);
      const latest = sets.sort((a, b) => b.manifest.capturedAt.localeCompare(a.manifest.capturedAt))[0];
      if (!latest) return { schemaVersion: 1, passed: false, reason: "missing-completed-backup" };
      const ageMs = Date.now() - Date.parse(latest.manifest.capturedAt);
      return { schemaVersion: 1, passed: ageMs <= config.freshnessMs, reason: ageMs <= config.freshnessMs ? "current" : "stale",
        runId: latest.marker.runId, capturedAt: latest.manifest.capturedAt, ageSeconds: Math.max(0, Math.ceil(ageMs / 1000)),
        manifestSha256: latest.marker.manifest.sha256, maximumAgeHours: 26 };
    } finally { client.destroy(); }
  });
}

export async function restoreRegistryBackup(env = process.env, runId, dependencies = {}) {
  const config = backupConfiguration(env, "restore");
  runPrefix(config, runId);
  const recoveryRoot = await createRecoveryDirectory(config);
  const startedAt = new Date().toISOString(); let failedPhase = "download-manifest";
  let destinations = {};
  try {
    return await withDeadline(config.timeoutMs, async (signal) => {
      const client = (dependencies.storageClient ?? storageClient)(config.backupStorage);
      try {
        const { manifest, marker, manifestBytes } = await loadCompletedSet(client, config, runId, signal);
        const prefix = runPrefix(config, runId);
        failedPhase = "download-backup";
        for (const file of localFiles(manifest)) {
          signal.throwIfAborted();
          await readObject(client, config.backupBucket, `${prefix}${file.path}`, file.byteSize, signal,
            { expected: file, path: join(recoveryRoot, file.path) });
        }
        await writeFile(join(recoveryRoot, "manifest.json"), manifestBytes, { flag: "wx", mode: 0o600, signal });
        const result = await restoreSnapshot(config, manifest, recoveryRoot, { signal, phase: (value) => { failedPhase = value; },
          onDestinations: (value) => { destinations = value; } }, dependencies);
        const report = { schemaVersion: 1, passed: true, runId, startedAt, completedAt: new Date().toISOString(),
          elapsedSeconds: Math.ceil((Date.now() - Date.parse(startedAt)) / 1000), ...snapshotStatus(manifest), ...result, manifestSha256: marker.manifest.sha256 };
        await writeFile(join(recoveryRoot, "report.json"), `${JSON.stringify(report)}\n`, { flag: "wx", mode: 0o600, signal });
        return { report, recoveryRoot };
      } finally { client.destroy(); }
    });
  } catch {
    const report = { schemaVersion: 1, passed: false, runId, startedAt, failedPhase, sourceWrites: false };
    await writeFile(join(recoveryRoot, "failure.json"), `${JSON.stringify({ ...report, ...destinations })}\n`, { flag: "wx", mode: 0o600 });
    return { report, recoveryRoot };
  }
}
