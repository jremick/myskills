import { createHash } from "node:crypto";

export const hostFixturePlatform = "linux/amd64";
const sha = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const manifestTypes = ["application/vnd.docker.distribution.manifest.v2+json", "application/vnd.oci.image.manifest.v1+json"];
const safeRole = value => ["api", "web", "mcp", "ops", "minio", "postgres", "backup"].includes(value) ? value : "upstream";
function invalid(reason, digest, before, after, role = "upstream", check = "manifest") {
  const error = new Error("HOST_PLATFORM_RECEIPT_INVALID");
  error.hostPlatformFailure = { code: error.message, role: safeRole(role), check, reason, platform: hostFixturePlatform, expectedDigest: sha(digest) ? digest : null, selectedBeforeId: sha(before?.Id) ? before.Id : null, selectedAfterId: sha(after?.Id) ? after.Id : null };
  throw error;
}
export function inspectHostPlatformImage(docker, image, role = "upstream", check = "inspect") {
  const response = docker(["image", "inspect", "--platform", hostFixturePlatform, image]);
  let row;
  try { row = JSON.parse(response.stdout)[0]; }
  catch { return invalid("inspect-shape", null, null, null, role, check); }
  if (row?.Os !== "linux" || row?.Architecture !== "amd64" || !sha(row?.Id)) return invalid("inspect-platform", null, row, null, role, check);
  return row;
}
export function pushHostPlatformImage(docker, tag) {
  return docker(["push", "--platform", hostFixturePlatform, tag]);
}
/** Preserve exact manifest bytes and selected-platform identity; an index cannot masquerade as a platform receipt. */
export function verifyHostPlatformManifest({ bytes, headerDigest, before, after, name, source }) {
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (bytes.length > 1024 * 1024 || digest !== headerDigest) return invalid("manifest-digest", digest, before, after, name, "digest");
  let manifest;
  try { manifest = JSON.parse(bytes); } catch { return invalid("manifest-shape", digest, before, after, name, "manifest"); }
  if (!manifest || typeof manifest !== "object" || manifest.schemaVersion !== 2 || !manifestTypes.includes(manifest.mediaType) || manifest.manifests !== undefined
    || !sha(manifest.config?.digest) || !Number.isSafeInteger(manifest.config?.size) || manifest.config.size < 1
    || !Array.isArray(manifest.layers) || manifest.layers.length > 256
    || !manifest.layers.every(layer => layer && sha(layer.digest) && Number.isSafeInteger(layer.size) && layer.size >= 0)) return invalid("single-platform-manifest-required", digest, before, after, name, "manifest");
  for (const row of [before, after]) {
    if (row?.Os !== "linux" || row?.Architecture !== "amd64" || !sha(row?.Id)) return invalid("inspect-platform", digest, before, after, name, "identity");
    // Docker28 containerd exposes the selected manifest descriptor/ID. Classic
    // storage exposes the image-config ID; both must bind this exact manifest.
    if (row.Descriptor ? row.Descriptor.digest !== digest || row.Id !== digest : row.Id !== manifest.config.digest) return invalid("selected-manifest-identity", digest, before, after, name, "identity");
    if (name !== "postgres" && (row.Config?.Labels?.["org.opencontainers.image.revision"] !== source.commit || row.Config?.Labels?.["org.opencontainers.image.version"] !== source.version)) return invalid("source-labels", digest, before, after, name, "labels");
  }
  if (before.Id !== after.Id) return invalid("pinned-readback-identity", digest, before, after, name, "identity");
  return digest;
}

export async function fetchHostPlatformManifest(fetcher, url, role) {
  let response;
  try { response = await fetcher(url, { headers: { accept: manifestTypes.join(",") }, signal: AbortSignal.timeout(10_000) }); }
  catch (error) { return invalid(["TimeoutError", "AbortError"].includes(error?.name) ? "fetch-timeout" : "fetch-transport", null, null, null, role, "fetch"); }
  if (!response.ok) return invalid("fetch-http-status", null, null, null, role, "fetch");
  if (Number(response.headers.get("content-length")) > 1024 * 1024) return invalid("fetch-size", null, null, null, role, "fetch");
  const chunks = []; let size = 0;
  try {
    if (!response.body) return invalid("fetch-empty", null, null, null, role, "fetch");
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 1024 * 1024) return invalid("fetch-size", null, null, null, role, "fetch");
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error?.hostPlatformFailure) throw error;
    return invalid("fetch-body", null, null, null, role, "fetch");
  }
  return { bytes: Buffer.concat(chunks), headerDigest: response.headers.get("docker-content-digest") };
}
