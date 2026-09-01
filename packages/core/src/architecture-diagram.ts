import {
  ArchitectureValidationError,
  type ArchitectureMetadata,
  type ArchitectureNodeKind,
  type ArchitectureSpecV1,
  type CompiledArchitecture,
} from "./architecture-contracts.js";
import { assertValidArchitectureSpec } from "./architecture-validation.js";
import { architectureDigest, canonicalizeJson, sha256Hex } from "./architecture-canonical.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const digestPattern = /^[a-f0-9]{64}$/;

/**
 * Bounded caller-provided text for an accessible Mermaid projection.
 *
 * Accessibility text is deliberately separate from the canonical architecture
 * name and description. A caller may provide a context-specific description
 * (for example, a profile-filtered preview), but it can never add topology,
 * paths, or package content through this option.
 */
export interface AccessibleMermaidProjectionOptions {
  title?: string;
  description?: string;
  /** Explicit aliases make the wire-facing option self-documenting. */
  accessibleTitle?: string;
  accessibleDescription?: string;
  accTitle?: string;
  accDescr?: string;
}

export interface MermaidProjectionOptions extends AccessibleMermaidProjectionOptions {
  includeDisabled?: boolean;
  /** Opt in to Mermaid's accTitle/accDescr directives. */
  accessible?: boolean | AccessibleMermaidProjectionOptions;
  /** Descriptive alias for callers that prefer the accessibility term. */
  accessibility?: boolean | AccessibleMermaidProjectionOptions;
  includeAccessibility?: boolean;
}

/** Text limits apply before Mermaid escaping, so output remains bounded. */
export const architectureDiagramLimits = {
  titleLength: 120,
  descriptionLength: 500,
} as const;

function mermaidNodeId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_]/g, "_");
  return `node_${safe || "item"}_${sha256Hex(id).slice(0, 12)}`;
}

function mermaidLabel(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, " ");
}

const architectureDiagramTitleMetadataKeys = [
  "diagramTitle",
  "accessibilityTitle",
  "accessibleTitle",
  "diagram.title",
  "accessibility.title",
] as const;

const architectureDiagramDescriptionMetadataKeys = [
  "diagramDescription",
  "accessibilityDescription",
  "accessibleDescription",
  "diagram.description",
  "accessibility.description",
] as const;

function firstMetadataString(metadata: ArchitectureMetadata | undefined, keys: readonly string[]): string | undefined {
  if (!metadata) return undefined;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

/** Normalize and cap user-facing diagram prose before inserting it into Mermaid. */
function boundedDiagramText(value: unknown, fallback: string, maximum: number): string {
  const source = typeof value === "string" && value.trim().length > 0 ? value : fallback;
  // Mermaid directives are line-oriented. Replace all controls and Unicode
  // line separators, collapse whitespace, and cap by code point rather than
  // UTF-16 code unit so a limit cannot split a surrogate pair.
  const normalized = source
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = Array.from(normalized).slice(0, maximum).join("").trim();
  if (bounded.length > 0) return bounded;
  return Array.from(fallback).slice(0, maximum).join("").trim();
}

interface ArchitectureDiagramAccessibleText {
  title: string;
  description: string;
}

function diagramAccessibleText(
  input: ArchitectureSpecV1 | CompiledArchitecture,
  spec: ArchitectureSpecV1 | undefined,
  options: MermaidProjectionOptions,
  enabled: boolean,
): ArchitectureDiagramAccessibleText | undefined {
  if (!enabled) return undefined;
  const nested = typeof options.accessible === "object" && options.accessible !== null
    ? options.accessible
    : typeof options.accessibility === "object" && options.accessibility !== null
      ? options.accessibility
      : undefined;
  const metadataTitle = spec ? firstMetadataString(spec.metadata, architectureDiagramTitleMetadataKeys) : undefined;
  const metadataDescription = spec ? firstMetadataString(spec.metadata, architectureDiagramDescriptionMetadataKeys) : undefined;
  const fallbackTitle = spec?.name ?? ("architectureId" in input ? input.architectureId : "Skill architecture");
  const fallbackDescription = spec?.description
    ?? (spec ? `Skill architecture ${spec.name}.` : `Compiled skill architecture ${"architectureId" in input ? input.architectureId : ""}.`);
  const title = boundedDiagramText(
    nested?.title
      ?? nested?.accessibleTitle
      ?? nested?.accTitle
      ?? options.title
      ?? options.accessibleTitle
      ?? options.accTitle
      ?? metadataTitle
      ?? fallbackTitle,
    fallbackTitle,
    architectureDiagramLimits.titleLength,
  );
  const description = boundedDiagramText(
    nested?.description
      ?? nested?.accessibleDescription
      ?? nested?.accDescr
      ?? options.description
      ?? options.accessibleDescription
      ?? options.accDescr
      ?? metadataDescription
      ?? fallbackDescription,
    fallbackDescription,
    architectureDiagramLimits.descriptionLength,
  );
  return { title, description };
}

function isAccessibleMermaidProjectionEnabled(options: MermaidProjectionOptions): boolean {
  return options.includeAccessibility === true
    || options.accessible !== undefined && options.accessible !== false
    || options.accessibility !== undefined && options.accessibility !== false;
}

export function mermaidArchitecture(input: ArchitectureSpecV1 | CompiledArchitecture, options: MermaidProjectionOptions = {}): string {
  const spec = "architectureId" in input ? undefined : assertValidArchitectureSpec(input);
  const accessibility = diagramAccessibleText(input, spec, options, isAccessibleMermaidProjectionEnabled(options));
  const lines = ["flowchart TD"];
  if (accessibility) {
    lines.push(`accTitle: ${mermaidLabel(accessibility.title)}`);
    lines.push(`accDescr: ${mermaidLabel(accessibility.description)}`);
  }
  if ("architectureId" in input) {
    const nodes = options.includeDisabled ? input.allNodes : input.nodes;
    const activeIds = new Set(input.nodes.map((node) => node.id));
    for (const node of nodes.slice().sort((left, right) => left.id.localeCompare(right.id))) {
      const suffix = "runtimeExposure" in node ? ` [${node.runtimeExposure}]` : activeIds.has(node.id) ? "" : " [disabled]";
      lines.push(`    ${mermaidNodeId(node.id)}["${mermaidLabel(node.label)} (${node.kind}) · ${mermaidLabel(node.id)}${suffix}"]`);
    }
    for (const edge of input.edges.slice().sort((left, right) => `${left.from}\u0000${left.to}`.localeCompare(`${right.from}\u0000${right.to}`))) lines.push(`    ${mermaidNodeId(edge.from)} -->|${edge.kind}| ${mermaidNodeId(edge.to)}`);
  } else {
    const normalizedSpec = spec as ArchitectureSpecV1;
    const nodes = normalizedSpec.nodes.slice().sort((left, right) => left.id.localeCompare(right.id));
    for (const node of nodes) lines.push(`    ${mermaidNodeId(node.id)}["${mermaidLabel(node.label)} (${node.kind}) · ${mermaidLabel(node.id)}"]`);
    for (const edge of normalizedSpec.edges) lines.push(`    ${mermaidNodeId(edge.from)} -->|${edge.kind}| ${mermaidNodeId(edge.to)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Render Mermaid with an accessible title and description enabled. */
export function accessibleMermaidArchitecture(input: ArchitectureSpecV1 | CompiledArchitecture, options: MermaidProjectionOptions = {}): string {
  const nested = typeof options.accessible === "object" && options.accessible !== null
    ? options.accessible
    : typeof options.accessibility === "object" && options.accessibility !== null
      ? options.accessibility
      : {};
  return mermaidArchitecture(input, {
    ...options,
    accessible: {
      ...nested,
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.accessibleTitle !== undefined ? { accessibleTitle: options.accessibleTitle } : {}),
      ...(options.accessibleDescription !== undefined ? { accessibleDescription: options.accessibleDescription } : {}),
      ...(options.accTitle !== undefined ? { accTitle: options.accTitle } : {}),
      ...(options.accDescr !== undefined ? { accDescr: options.accDescr } : {}),
    },
  });
}

export const renderMermaidArchitecture = mermaidArchitecture;
export const architectureToMermaid = mermaidArchitecture;
export const renderAccessibleMermaidArchitecture = accessibleMermaidArchitecture;
export const mermaidAccessibleArchitecture = accessibleMermaidArchitecture;

export interface AccessibleArchitectureOutlineNode {
  id: string;
  label: string;
  kind: ArchitectureNodeKind;
  children: AccessibleArchitectureOutlineNode[];
}

export interface AccessibleArchitectureOutline {
  title: string;
  text: string;
  tree: AccessibleArchitectureOutlineNode[];
  html: string;
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface AccessibleArchitectureGraphNode {
  id: string;
  label: string;
  kind: ArchitectureNodeKind;
}

interface AccessibleArchitectureGraphEdge {
  from: string;
  to: string;
}

function createAccessibleArchitectureOutlineFromGraph(
  title: string,
  nodes: readonly AccessibleArchitectureGraphNode[],
  edges: readonly AccessibleArchitectureGraphEdge[],
  entryNodeIds: readonly string[],
): AccessibleArchitectureOutline {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const childrenById = new Map<string, string[]>();
  for (const edge of edges) {
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    childrenById.set(edge.from, [...(childrenById.get(edge.from) ?? []), edge.to]);
  }
  for (const children of childrenById.values()) children.sort();
  const makeNode = (id: string): AccessibleArchitectureOutlineNode => {
    const node = nodeById.get(id);
    if (!node) throw new ArchitectureValidationError([{ code: "ARCHITECTURE_ENTRY_UNKNOWN", message: `Node '${id}' does not exist.` }]);
    return { id: node.id, label: node.label, kind: node.kind, children: (childrenById.get(id) ?? []).map(makeNode) };
  };
  const tree = entryNodeIds.filter((id) => nodeById.has(id)).slice().sort().map(makeNode);
  const textLines: string[] = [title];
  const htmlNode = (node: AccessibleArchitectureOutlineNode, level: number): string => {
    textLines.push(`${"  ".repeat(level)}- ${node.label} (${node.kind})`);
    const children = node.children.map((child) => htmlNode(child, level + 1)).join("");
    return `<li role="treeitem" aria-level="${level}" aria-label="${htmlEscape(`${node.label} (${node.kind})`)}">${htmlEscape(node.label)} <span>(${node.kind})</span>${children ? `<ul role="group">${children}</ul>` : ""}</li>`;
  };
  const html = `<ul role="tree" aria-label="${htmlEscape(title)}">${tree.map((node) => htmlNode(node, 1)).join("")}</ul>`;
  return { title, text: textLines.join("\n"), tree, html };
}

export function createAccessibleArchitectureOutline(specInput: ArchitectureSpecV1): AccessibleArchitectureOutline {
  const spec = assertValidArchitectureSpec(specInput);
  return createAccessibleArchitectureOutlineFromGraph(
    spec.name,
    spec.nodes,
    spec.edges,
    spec.entryNodeIds,
  );
}

function compiledArchitectureOutline(
  compiled: CompiledArchitecture,
  title: string,
  includeDisabled: boolean,
): AccessibleArchitectureOutline {
  const selectedNodes = includeDisabled ? compiled.allNodes : compiled.nodes;
  const nodes: AccessibleArchitectureGraphNode[] = selectedNodes.map((node) => ({
    id: node.id,
    label: node.label,
    kind: node.kind,
  }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = compiled.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const incoming = new Set(edges.map((edge) => edge.to));
  const entryNodeIds = nodes.filter((node) => !incoming.has(node.id)).map((node) => node.id);
  return createAccessibleArchitectureOutlineFromGraph(title, nodes, edges, entryNodeIds);
}

export const architectureDiagramArtifactSchemaVersion = 1 as const;
export type ArchitectureDiagramArtifactSchemaVersion = typeof architectureDiagramArtifactSchemaVersion;

export interface ArchitectureDiagramArtifactV1 {
  schemaVersion: ArchitectureDiagramArtifactSchemaVersion;
  architectureId: string;
  /** Architecture revision digest for a compiled or source specification. */
  revisionDigest: string;
  /** Included only when the source is a compiled profile/environment projection. */
  profileId?: string;
  environmentId?: string;
  accessibleTitle: string;
  accessibleDescription: string;
  mermaid: string;
  mermaidSha256: string;
  accessibleOutline: string;
  artifactDigest: string;
}

export type ArchitectureDiagramArtifactInput = Omit<ArchitectureDiagramArtifactV1, "artifactDigest">;

/** Canonical semantic JSON for an artifact, excluding its self-referential digest. */
export function canonicalArchitectureDiagramArtifactJson(input: ArchitectureDiagramArtifactV1 | ArchitectureDiagramArtifactInput): string {
  const { artifactDigest: _artifactDigest, ...semantic } = input as ArchitectureDiagramArtifactV1;
  return canonicalizeJson(semantic);
}

/** Calculate the digest bound to every semantic field in a diagram artifact. */
export function architectureDiagramArtifactDigest(input: ArchitectureDiagramArtifactV1 | ArchitectureDiagramArtifactInput): string {
  return sha256Hex(canonicalArchitectureDiagramArtifactJson(input));
}

function architectureDiagramSourceDigest(input: ArchitectureSpecV1 | CompiledArchitecture): string {
  return "architectureId" in input ? input.revisionDigest : architectureDigest(input);
}

function architectureDiagramProjectionText(
  input: ArchitectureSpecV1 | CompiledArchitecture,
  options: ArchitectureDiagramArtifactOptions,
): ArchitectureDiagramAccessibleText {
  const spec = "architectureId" in input ? undefined : assertValidArchitectureSpec(input);
  return diagramAccessibleText(
    input,
    spec,
    {
      ...options,
      accessible: true,
    },
    true,
  ) as ArchitectureDiagramAccessibleText;
}

export interface ArchitectureDiagramArtifactOptions extends AccessibleMermaidProjectionOptions {
  includeDisabled?: boolean;
}

/**
 * Build a deterministic, metadata-only diagram export. The export is derived
 * from the source revision and never carries SVG, layout coordinates, paths,
 * users, credentials, or package content.
 */
export function createArchitectureDiagramArtifact(
  input: ArchitectureSpecV1 | CompiledArchitecture,
  options: ArchitectureDiagramArtifactOptions = {},
): ArchitectureDiagramArtifactV1 {
  const compiled = "architectureId" in input;
  const spec = compiled ? undefined : assertValidArchitectureSpec(input);
  const accessibleText = architectureDiagramProjectionText(input, options);
  const mermaid = mermaidArchitecture(input, {
    includeDisabled: options.includeDisabled,
    accessible: {
      title: accessibleText.title,
      description: accessibleText.description,
    },
  });
  const outline = compiled
    ? compiledArchitectureOutline(input, accessibleText.title, options.includeDisabled === true)
    : createAccessibleArchitectureOutlineFromGraph(
      accessibleText.title,
      (spec as ArchitectureSpecV1).nodes,
      (spec as ArchitectureSpecV1).edges,
      (spec as ArchitectureSpecV1).entryNodeIds,
    );
  const semantic: ArchitectureDiagramArtifactInput = {
    schemaVersion: architectureDiagramArtifactSchemaVersion,
    architectureId: compiled ? input.architectureId : (spec as ArchitectureSpecV1).id,
    revisionDigest: architectureDiagramSourceDigest(input),
    ...(compiled ? { profileId: input.profileId, environmentId: input.environmentId } : {}),
    accessibleTitle: accessibleText.title,
    accessibleDescription: accessibleText.description,
    mermaid,
    mermaidSha256: sha256Hex(mermaid),
    accessibleOutline: outline.text,
  };
  return {
    ...semantic,
    artifactDigest: architectureDiagramArtifactDigest(semantic),
  };
}

/** Verify the Mermaid content hash and the artifact's semantic self-digest. */
export function verifyArchitectureDiagramArtifact(input: ArchitectureDiagramArtifactV1): boolean {
  if (!isRecord(input)) return false;
  if (input.schemaVersion !== architectureDiagramArtifactSchemaVersion || typeof input.architectureId !== "string" || input.architectureId.length === 0) return false;
  if (typeof input.revisionDigest !== "string" || !digestPattern.test(input.revisionDigest)) return false;
  if (typeof input.accessibleTitle !== "string" || typeof input.accessibleDescription !== "string" || typeof input.accessibleOutline !== "string") return false;
  if (typeof input.mermaid !== "string" || typeof input.mermaidSha256 !== "string" || !digestPattern.test(input.mermaidSha256)) return false;
  if (typeof input.artifactDigest !== "string" || !digestPattern.test(input.artifactDigest)) return false;
  if (input.profileId !== undefined && typeof input.profileId !== "string") return false;
  if (input.environmentId !== undefined && typeof input.environmentId !== "string") return false;
  return input.mermaidSha256 === sha256Hex(input.mermaid)
    && input.artifactDigest === architectureDiagramArtifactDigest(input);
}

export const digestArchitectureDiagramArtifact = architectureDiagramArtifactDigest;
export const architectureDiagramArtifact = createArchitectureDiagramArtifact;
export const architectureDiagramArtifactSourceDigest = architectureDiagramSourceDigest;
export const verifyArchitectureDiagramArtifactDigest = verifyArchitectureDiagramArtifact;
export const validateArchitectureDiagramArtifactDigest = verifyArchitectureDiagramArtifact;
export const buildArchitectureDiagramArtifact = createArchitectureDiagramArtifact;

export function accessibleArchitectureOutline(spec: ArchitectureSpecV1): string {
  return createAccessibleArchitectureOutline(spec).text;
}

export const architectureOutline = accessibleArchitectureOutline;
export const renderAccessibleArchitectureOutline = (spec: ArchitectureSpecV1): string => createAccessibleArchitectureOutline(spec).html;
export const architectureToAccessibleOutline = createAccessibleArchitectureOutline;
