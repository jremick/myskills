import { canonicalizeJson, sha256Hex } from "./architecture-canonical.js";
import type { CompiledArchitecture } from "./architecture-contracts.js";

export const architectureArtifactContract = "codex-workspace-architecture/v1" as const;
export const architectureArtifactLimits = { metadataBytes: 256 * 1024, entryBytes: 16 * 1024, files: 2000, bytes: 16 * 1024 * 1024 } as const;
export interface ArtifactFile { path: string; content: string }
export interface ArtifactFileIdentity { path: string; digest: string; size: number }
export interface ArchitectureArtifactPackage { refId: string; slug: string; version: string; digest: string; size: number; platform: "codex" }
export interface ArchitectureArtifactNode { id: string; kind: "router" | "leaf"; label: string; name: string; refId: string | null; children: string[] }
export interface ArchitectureArtifactProjection {
  contract: typeof architectureArtifactContract;
  architectureId: string; revisionId: string; revisionDigest: string; compiledDigest: string;
  targetId: string; generation: number; targetIdentityDigest: string; adapterDigest: string; capabilitiesDigest: string;
  profileId: string; environmentId: string; policyDigest: string; consentDigest: string; observationId: string; observationDigest: string;
  entryNodeIds: string[]; nodes: ArchitectureArtifactNode[]; routers: { nodeId: string; digest: string; routes: { from: string; to: string; kind: string }[] }[];
  disabledNodeIds: string[]; packages: ArchitectureArtifactPackage[];
}
export interface ArchitectureArtifactIntent {
  projection: ArchitectureArtifactProjection; reviewRunId: string;
  baselineRunId: string | null; baselineDigest: string;
  files: ArtifactFileIdentity[]; treeDigest: string;
  placements: string[]; removals: string[];
}
export const artifactHash = (value: unknown): string => sha256Hex(canonicalizeJson(value));
export const artifactNamespace = (architectureId: string): string => sha256Hex(architectureId).slice(0, 20);
export const artifactPrivateRoot = (architectureId: string): string => `.myskills-app/architectures/${artifactNamespace(architectureId)}/active`;
export function artifactGeneratedName(architectureId: string, nodeId: string): string { return `ms-${artifactNamespace(architectureId)}-${sha256Hex(nodeId).slice(0, 20)}`; }
export function projectArchitectureArtifact(compiled: CompiledArchitecture, input: Omit<ArchitectureArtifactProjection, "contract" | "nodes" | "routers" | "disabledNodeIds" | "entryNodeIds" | "architectureId" | "revisionDigest" | "compiledDigest">): ArchitectureArtifactProjection {
  const incoming = new Set(compiled.edges.map(edge => edge.to));
  const value: ArchitectureArtifactProjection = { ...input, contract: architectureArtifactContract, architectureId: compiled.architectureId, revisionDigest: compiled.revisionDigest, compiledDigest: artifactHash(compiled),
    entryNodeIds: compiled.nodes.filter(node => !incoming.has(node.id)).map(node => node.id),
    nodes: compiled.nodes.map(node => ({ id: node.id, kind: node.kind, label: node.label, name: artifactGeneratedName(compiled.architectureId, node.id), refId: node.skillRefId ?? null, children: [...node.childNodeIds] })),
    routers: compiled.routers.map(router => ({ nodeId: router.nodeId, digest: router.digest, routes: router.routes.map(route => ({ ...route })) })), disabledNodeIds: [...compiled.disabledNodeIds] };
  assertArchitectureArtifactProjection(value);
  return value;
}

/** Original package bytes/layout remain private. Generated prose is guidance. */
export function renderArchitectureArtifact(projection: ArchitectureArtifactProjection, packages: ReadonlyMap<string, readonly ArtifactFile[]>): ArtifactFile[] {
  assertArchitectureArtifactProjection(projection);
  const files: ArtifactFile[] = [];
  const root = artifactPrivateRoot(projection.architectureId);
  const context = canonicalizeJson(projection) + "\n";
  if (bytes(context) > architectureArtifactLimits.metadataBytes) throw new Error("Artifact context exceeds its bound.");
  files.push({ path: `${root}/context.json`, content: context });
  for (const node of projection.nodes) {
    const nodeRoot = `${root}/${sha256Hex(node.id).slice(0, 20)}/payload`;
    const routes = node.children.map(id => {
      const child = projection.nodes.find(candidate => candidate.id === id)!;
      return `- ${markdownLabel(child.label)}: ../${child.name}/SKILL.md`;
    });
    const content = `---\nname: ${node.name}\ndescription: ${JSON.stringify(`Architecture ${node.kind} ${node.id}; profile ${projection.profileId}; environment ${projection.environmentId}`)}\n---\n\n${markdownLabel(node.label)}\n\nProfile: ${JSON.stringify(projection.profileId)}. Environment: ${JSON.stringify(projection.environmentId)}.\nRouting guidance; this text does not enforce runtime policy.\nContext: ../../../${root}/context.json\n${node.refId ? `Exact instructions and relative assets: ../../../${nodeRoot}/SKILL.md\n` : ""}${routes.length ? `\nOrdered routes:\n${routes.join("\n")}\n` : ""}`;
    if (bytes(content) > architectureArtifactLimits.entryBytes) throw new Error("Artifact entry exceeds its bound.");
    files.push({ path: `.agents/skills/${node.name}/SKILL.md`, content });
    if (node.refId) {
      const payload = packages.get(node.refId);
      if (!payload) throw new Error("An exact artifact payload is missing.");
      for (const file of payload) { artifactRelativePath(file.path); files.push({ path: `${nodeRoot}/${file.path}`, content: file.content }); }
    }
  }
  identifyArtifactFiles(files);
  return files;
}
export function identifyArtifactFiles(files: readonly ArtifactFile[]): ArtifactFileIdentity[] {
  if (!files.length || files.length > architectureArtifactLimits.files) throw new Error("Artifact file count exceeds its bound.");
  const seen = new Set<string>(); let total = 0;
  const result = files.map(file => {
    artifactRelativePath(file.path);
    const key = file.path.toLowerCase().normalize("NFC");
    if (seen.has(key)) throw new Error("Artifact paths collide."); seen.add(key);
    const size = bytes(file.content); total += size;
    if (total > architectureArtifactLimits.bytes) throw new Error("Artifact bytes exceed their bound.");
    return { path: file.path, digest: sha256Hex(file.content), size };
  }).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return result;
}
export function createArchitectureArtifactIntent(projection: ArchitectureArtifactProjection, reviewRunId: string, files: readonly ArtifactFile[], baseline: { runId: string; intent: ArchitectureArtifactIntent } | null): ArchitectureArtifactIntent {
  const identities = identifyArtifactFiles(files);
  const placements = [artifactPrivateRoot(projection.architectureId), ...projection.nodes.map(node => `.agents/skills/${node.name}`)];
  const value: ArchitectureArtifactIntent = { projection, reviewRunId, baselineRunId: baseline?.runId ?? null, baselineDigest: artifactHash(baseline?.intent ?? null), files: identities, treeDigest: artifactHash(identities), placements, removals: (baseline?.intent.placements ?? []).filter(p => !placements.includes(p)) };
  assertArchitectureArtifactIntent(value); return value;
}

function markdownLabel(value: string): string { return JSON.stringify(value).replace(/[\\`*_{}\[\]()<>#!|]/g, "\\$&"); }
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digestPattern = /^[a-f0-9]{64}$/;
function record(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Artifact schema has missing or unknown fields.");
}
function id(value: unknown): asserts value is string { if (typeof value !== "string" || !idPattern.test(value)) throw new Error("Artifact identifier is invalid."); }
function digest(value: unknown): asserts value is string { if (typeof value !== "string" || !digestPattern.test(value)) throw new Error("Artifact digest is invalid."); }
function list(value: unknown, maximum: number): asserts value is unknown[] { if (!Array.isArray(value) || value.length > maximum) throw new Error("Artifact list exceeds its bound."); }
export function artifactRelativePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 512 || !value.length || value.split("/").some(p => !p || p === "." || p === ".." || /[\\:\u0000-\u001f\u007f]/.test(p) || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error("Artifact path is not portable and relative.");
}
function bytes(value: string): number { return new TextEncoder().encode(value).length; }
export function assertArchitectureArtifactProjection(value: unknown): asserts value is ArchitectureArtifactProjection {
  record(value, ["contract","architectureId","revisionId","revisionDigest","compiledDigest","targetId","generation","targetIdentityDigest","adapterDigest","capabilitiesDigest","profileId","environmentId","policyDigest","consentDigest","observationId","observationDigest","entryNodeIds","nodes","routers","disabledNodeIds","packages"]);
  if (value.contract !== architectureArtifactContract || !Number.isInteger(value.generation) || Number(value.generation) < 1 || Number(value.generation) > 1e9) throw new Error("Artifact contract or generation is invalid.");
  for (const key of ["architectureId","revisionId","targetId","profileId","environmentId","observationId"]) id(value[key]);
  for (const key of ["revisionDigest","compiledDigest","targetIdentityDigest","adapterDigest","capabilitiesDigest","policyDigest","consentDigest","observationDigest"]) digest(value[key]);
  list(value.nodes, 500); list(value.routers, 500); list(value.packages, 500); list(value.entryNodeIds, 500); list(value.disabledNodeIds, 500);
  const nodes = value.nodes as ArchitectureArtifactNode[]; const names = new Set<string>(); const nodeIds = new Set<string>();
  for (const node of nodes) {
    record(node,["id","kind","label","name","refId","children"]); id(node.id);
    if (!["router","leaf"].includes(String(node.kind)) || typeof node.label !== "string" || node.label.length > 1000 || /[\u0000-\u001f\u007f]/.test(node.label)) throw new Error("Artifact node is invalid.");
    if (node.name !== artifactGeneratedName(String(value.architectureId),node.id) || names.has(String(node.name)) || nodeIds.has(node.id)) throw new Error("Artifact generated names collide.");
    names.add(String(node.name)); nodeIds.add(node.id); if (node.refId !== null) id(node.refId); list(node.children,500); node.children.forEach(id);
  }
  const incoming = new Set<string>();
  for (const node of nodes) for (const child of node.children) { if (!nodeIds.has(child) || incoming.has(child) || child === node.id || node.kind !== "router") throw new Error("Artifact route is invalid."); incoming.add(child); }
  const roots = nodes.filter(n => !incoming.has(n.id)).map(n => n.id);
  if (canonicalizeJson(roots) !== canonicalizeJson(value.entryNodeIds)) throw new Error("Artifact roots do not match routes.");
  const visited = new Set<string>(); const visit = (n: ArchitectureArtifactNode, depth = 0) => { if (depth > 12) throw new Error("Artifact topology exceeds depth bound."); if (visited.has(n.id)) throw new Error("Artifact cycle."); visited.add(n.id); n.children.forEach(child => visit(nodes.find(x=>x.id===child)!, depth + 1)); }; roots.forEach(root => visit(nodes.find(n=>n.id===root)!));
  if (visited.size !== nodes.length) throw new Error("Artifact contains unreachable nodes.");
  for (const disabled of value.disabledNodeIds) { id(disabled); if (nodeIds.has(disabled)) throw new Error("Disabled node has active exposure."); }
  const refs = new Set<string>();
  for (const pkg of value.packages) {
    record(pkg,["refId","slug","version","digest","size","platform"]); id(pkg.refId); id(pkg.slug); id(pkg.version); digest(pkg.digest);
    if (pkg.platform !== "codex" || !Number.isInteger(pkg.size) || Number(pkg.size) < 1 || Number(pkg.size)>16*1024*1024 || refs.has(pkg.refId)) throw new Error("Artifact package is invalid."); refs.add(pkg.refId);
  }
  if (nodes.some(node => node.refId && !refs.has(node.refId)) || [...refs].some(ref=>!nodes.some(node=>node.refId===ref))) throw new Error("Artifact package references differ.");
  for (const router of value.routers) {
    record(router,["nodeId","digest","routes"]); id(router.nodeId); digest(router.digest); list(router.routes,500);
    const node = nodes.find(node => node.id === router.nodeId && node.kind === "router");
    for (const route of router.routes) { record(route,["from","to","kind"]); id(route.from); id(route.to); id(route.kind); }
    if (!node || canonicalizeJson(node.children)!==canonicalizeJson(router.routes.map(route=>(route as {to:string}).to)) || router.routes.some(route => (route as {from:string}).from !== node.id) || artifactHash({nodeId:node.id,childNodeIds:node.children,routes:router.routes})!==router.digest) throw new Error("Artifact router differs from compiled routes.");
  }
  if (value.routers.length!==nodes.filter(n=>n.kind==="router").length || new Set(value.routers.map(r=>(r as {nodeId:string}).nodeId)).size!==value.routers.length || bytes(canonicalizeJson(value))>architectureArtifactLimits.metadataBytes) throw new Error("Artifact projection is incomplete or oversized.");
}
export function assertArchitectureArtifactIntent(value: unknown): asserts value is ArchitectureArtifactIntent {
  record(value,["projection","reviewRunId","baselineRunId","baselineDigest","files","treeDigest","placements","removals"]);
  assertArchitectureArtifactProjection(value.projection); id(value.reviewRunId); if(value.baselineRunId!==null) id(value.baselineRunId); digest(value.baselineDigest); digest(value.treeDigest);
  list(value.files,architectureArtifactLimits.files); list(value.placements,501); list(value.removals,501);
  const projection = value.projection; const allowed = [artifactPrivateRoot(projection.architectureId),...projection.nodes.map(n=>`.agents/skills/${n.name}`)];
  if(canonicalizeJson(allowed)!==canonicalizeJson(value.placements)) throw new Error("Artifact placements differ from graph.");
  const seen=new Set<string>(); let total=0;
  for(const file of value.files) { record(file,["path","digest","size"]); artifactRelativePath(file.path); digest(file.digest); if(!Number.isInteger(file.size)||Number(file.size)<0) throw new Error("Artifact file size invalid."); total+=Number(file.size); const key=file.path.toLowerCase().normalize("NFC"); if(seen.has(key)||!allowed.some(p=>String(file.path).startsWith(p+"/"))) throw new Error("Artifact file collision or ownership mismatch."); seen.add(key); }
  for(const removal of value.removals) { artifactRelativePath(removal); if(!new RegExp(`^\\.agents/skills/ms-${artifactNamespace(projection.architectureId)}-[a-f0-9]{20}$`).test(removal)||allowed.includes(removal)) throw new Error("Artifact removal is not owned."); }
  if(total>architectureArtifactLimits.bytes || artifactHash(value.files)!==value.treeDigest || new Set(value.removals).size!==value.removals.length || bytes(canonicalizeJson(value))>architectureArtifactLimits.metadataBytes) throw new Error("Artifact tree is oversized or inconsistent.");
}
