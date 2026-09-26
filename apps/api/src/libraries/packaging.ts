import { createHash } from "node:crypto";
import { posix } from "node:path";
import { TextDecoder } from "node:util";
import {
  conservativeImportReleaseNotes,
  isDefaultExcludedSourcePath,
  LIBRARY_LIMITS,
  LIBRARY_ORIGINAL_SKILL_PATH,
  type LibraryCandidateFile,
  type LibraryCandidateMapping,
  type LibraryFinding,
  type LibrarySourceRef,
  type LibraryTransform,
  type VisibilityScope,
} from "@myskills-app/core";
import {
  DEFAULT_MANIFEST_NAMES,
  MAX_PACKAGE_FILES,
  MAX_PACKAGE_TEXT_BYTES,
  parseSkillManifest,
  scanPackageFiles,
  validatePackageFiles,
  type PackageInputFile,
  type SkillManifest,
} from "@myskills-app/skill-package";
import { artifactPayloadSha256 } from "../submissions/artifact-hash.js";
import { canonicalArtifactPayload } from "../submissions/service.js";
import type { SourceTreeEntry } from "./github-source.js";

/**
 * Deterministic packaging for source imports. Support files are copied
 * byte-for-byte; MySkills metadata lives in two generated files. The runtime
 * SKILL.md differs from upstream only in its name value, which is the registry
 * slug, and the exact upstream SKILL.md is kept at LIBRARY_ORIGINAL_SKILL_PATH.
 * Nothing here performs network I/O; callers supply verified blob bytes.
 */

export const IMPORTER_VERSION = "myskills-library-importer/2";
export const IMPORT_MANIFEST_PATH = "myskills-import.json";
const GENERATED_MANIFEST_PATH = "skill.json";
const ORIGINAL_SKILL_PATH = LIBRARY_ORIGINAL_SKILL_PATH;
const RESERVED_PACKAGE_PATHS: readonly string[] = [...DEFAULT_MANIFEST_NAMES, IMPORT_MANIFEST_PATH];
/** skill.json, myskills-import.json and the preserved original SKILL.md. */
const ADDED_PACKAGE_FILES = 3;
const NOTICE_PATTERN = /^(?:licen[cs]e|copying|notice)(?:\.(?:md|txt|rst))?$/i;
const PLUGIN_MARKERS = new Set([".claude-plugin", ".codex-plugin", ".cursor-plugin"]);
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
const MARKDOWN_LINK_PATTERN = /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;
const IMPORT_PLATFORM = { name: "codex", install_target: "codex-skill", status: "supported" as const };
const KNOWN_FRONTMATTER_KEYS = new Set(["name", "description", "license", "metadata"]);

export interface MappingOverrides {
  title?: string;
  summary?: string;
  license?: string;
}

export interface HeldFile {
  path: string;
  content: string;
  origin: "upstream" | "repository-notice" | "generated";
  sourcePath: string | null;
  gitBlobSha: string | null;
}

export interface PackageSourceFile {
  packagePath: string;
  sourcePath: string;
  entry: SourceTreeEntry;
  origin: "upstream" | "repository-notice";
}

export interface SkillRootAnalysis {
  path: string;
  directoryName: string;
  fileCount: number;
  byteCount: number;
  blockers: LibraryFinding[];
}

export interface CandidateSourceContext {
  repositoryId: string;
  fullName: string;
  url: string;
  commit: string;
  treeSha: string;
  ref: LibrarySourceRef;
  upstreamLabel: string | null;
  releaseId: string | null;
}

export interface CandidatePackageInput {
  entries: SourceTreeEntry[];
  rootPath: string;
  fetchBlob: (file: PackageSourceFile) => Promise<Uint8Array>;
  slug: string;
  version: string;
  visibility: VisibilityScope;
  licenseSpdx: string | null;
  overrides: MappingOverrides;
  source: CandidateSourceContext;
}

export interface CandidatePackageResult {
  ready: boolean;
  findings: LibraryFinding[];
  files: HeldFile[] | null;
  fileDigests: LibraryCandidateFile[];
  sourceDigest: string;
  packageDigest: string | null;
  nativeName: string | null;
  mapping: LibraryCandidateMapping;
  headFiles: Array<{ path: string; gitBlobSha: string }>;
  provenanceFiles: Array<{ path: string; sourcePath: string; gitBlobSha: string; sha256: string; bytes: number; origin: "upstream" | "repository-notice" }>;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function inventoryDigest(entries: readonly SourceTreeEntry[]): string {
  return sha256Hex(JSON.stringify(entries.map((entry) => [entry.path, entry.mode, entry.type, entry.sha])));
}

function rootPrefix(rootPath: string): string {
  return rootPath ? `${rootPath}/` : "";
}

function underPath(path: string, base: string): boolean {
  return base === "" || path === base || path.startsWith(`${base}/`);
}

/** Directories containing a SKILL.md, within the selected subtree, sorted. */
export function listSkillRootPaths(entries: readonly SourceTreeEntry[], selectionPath: string): string[] {
  const roots = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "blob" || entry.mode === "120000") continue;
    if (posix.basename(entry.path) !== "SKILL.md" || !underPath(entry.path, selectionPath)) continue;
    const directory = posix.dirname(entry.path);
    roots.add(directory === "." ? "" : directory);
  }
  return [...roots].sort((left, right) => left.localeCompare(right));
}

export function analyzeSkillRoot(entries: readonly SourceTreeEntry[], rootPath: string, allRoots: readonly string[]): SkillRootAnalysis {
  const prefix = rootPrefix(rootPath);
  const blockers: LibraryFinding[] = [];
  let fileCount = 0;
  let byteCount = 0;
  let skillBytes = 0;
  if (!entries.some((entry) => entry.path === `${prefix}SKILL.md` && entry.type === "blob" && entry.mode !== "120000")) {
    blockers.push({ code: "skill-root-missing", severity: "blocking", message: "The selected path has no SKILL.md in this snapshot.", path: rootPath });
  }
  for (const nested of allRoots) {
    if (nested !== rootPath && underPath(nested, rootPath) && (rootPath !== "" || nested !== "")) {
      blockers.push({ code: "nested-skill-root", severity: "blocking", message: "The selected skill contains another skill root. Select the nested skill instead.", path: nested });
    }
  }
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const relative = entry.path.slice(prefix.length);
    if (entry.type === "commit") {
      blockers.push({ code: "unsupported-submodule", severity: "blocking", message: "Git submodules cannot be packaged.", path: entry.path });
      continue;
    }
    if (entry.mode === "120000") {
      blockers.push({ code: "unsupported-symlink", severity: "blocking", message: "Symbolic links cannot be packaged.", path: entry.path });
      continue;
    }
    fileCount += 1;
    if (entry.size === null) {
      // Without a size the total cannot be bounded before download.
      blockers.push({ code: "inventory-incomplete", severity: "blocking", message: "The provider did not report this file's size, so the package size cannot be checked before download.", path: entry.path });
    }
    byteCount += entry.size ?? 0;
    if (relative === "SKILL.md") skillBytes = entry.size ?? 0;
    if (!relative.includes("/") && RESERVED_PACKAGE_PATHS.includes(relative)) {
      blockers.push({ code: "manifest-path-collision", severity: "blocking", message: "The skill already contains a file name reserved for generated MySkills metadata.", path: entry.path });
    }
    // Reserved as a file or directory in any letter case: install filesystems fold case.
    if (relative.split("/")[0]!.normalize("NFC").toLowerCase() === ORIGINAL_SKILL_PATH) {
      blockers.push({ code: "manifest-path-collision", severity: "blocking", message: `The skill already contains ${ORIGINAL_SKILL_PATH}, which MySkills reserves for the preserved original SKILL.md.`, path: entry.path });
    }
    if (relative.split("/").some((segment) => PLUGIN_MARKERS.has(segment)) || relative === "plugin.json") {
      blockers.push({ code: "plugin-package-unsupported", severity: "blocking", message: "Host plugin packaging is not converted. Keep this source as a reference.", path: entry.path });
    }
  }
  if (fileCount + ADDED_PACKAGE_FILES + repositoryNotices(entries).length > MAX_PACKAGE_FILES) {
    blockers.push({ code: "limit-exceeded", severity: "blocking", message: `The package would exceed ${MAX_PACKAGE_FILES} files, counting the generated metadata and the preserved original SKILL.md.`, path: rootPath });
  }
  if (byteCount + skillBytes > MAX_PACKAGE_TEXT_BYTES) {
    blockers.push({ code: "limit-exceeded", severity: "blocking", message: `The package text would exceed ${MAX_PACKAGE_TEXT_BYTES} bytes, counting the preserved copy of SKILL.md.`, path: rootPath });
  }
  return {
    path: rootPath,
    directoryName: rootPath ? posix.basename(rootPath) : "",
    fileCount,
    byteCount,
    blockers: dedupeFindings(blockers),
  };
}

export function discoverSkillRoots(entries: readonly SourceTreeEntry[], selectionPath: string): {
  skills: SkillRootAnalysis[];
  excluded: SkillRootAnalysis[];
  complete: boolean;
} {
  const roots = listSkillRootPaths(entries, selectionPath);
  const complete = roots.length <= LIBRARY_LIMITS.maxDiscoveredRoots;
  const skills: SkillRootAnalysis[] = [];
  const excluded: SkillRootAnalysis[] = [];
  for (const root of roots.slice(0, LIBRARY_LIMITS.maxDiscoveredRoots)) {
    const relative = selectionPath && root.startsWith(`${selectionPath}/`) ? root.slice(selectionPath.length + 1) : root === selectionPath ? "" : root;
    const analysis = analyzeSkillRoot(entries, root, roots);
    (relative && isDefaultExcludedSourcePath(relative) ? excluded : skills).push(analysis);
  }
  return { skills, excluded, complete };
}

/** Top-level repository licence and notice files. */
export function repositoryNotices(entries: readonly SourceTreeEntry[]): SourceTreeEntry[] {
  return entries.filter((entry) => entry.type === "blob" && entry.mode !== "120000" && !entry.path.includes("/") && NOTICE_PATTERN.test(entry.path));
}

/** Upstream files that form the package for one root, including placed repository notices. */
export function packageSourceFiles(entries: readonly SourceTreeEntry[], rootPath: string): PackageSourceFile[] {
  const prefix = rootPrefix(rootPath);
  const files: PackageSourceFile[] = entries
    .filter((entry) => entry.path.startsWith(prefix) && entry.type === "blob" && entry.mode !== "120000")
    .map((entry) => ({ packagePath: entry.path.slice(prefix.length), sourcePath: entry.path, entry, origin: "upstream" as const }));
  if (rootPath !== "") {
    const taken = new Map(files.map((file) => [file.packagePath.toLowerCase(), file]));
    for (const notice of repositoryNotices(entries)) {
      const existing = taken.get(notice.path.toLowerCase());
      if (existing?.entry.sha === notice.sha) continue;
      const packagePath = existing ? `upstream-notices/${notice.path}` : notice.path;
      files.push({ packagePath, sourcePath: notice.path, entry: notice, origin: "repository-notice" });
    }
  }
  return files.sort((left, right) => left.packagePath.localeCompare(right.packagePath));
}

/** Digest of the selected upstream bytes by Git identity; computable from a tree alone. */
export function computeSourceDigest(entries: readonly SourceTreeEntry[], rootPath: string): string | null {
  if (!entries.some((entry) => entry.path === `${rootPrefix(rootPath)}SKILL.md`)) return null;
  return sha256Hex(JSON.stringify(packageSourceFiles(entries, rootPath).map((file) => [file.packagePath, file.entry.sha])));
}

/** Root-relative file identity used for rename suggestions, excluding notices. */
export function rootFileSignature(entries: readonly SourceTreeEntry[], rootPath: string): string {
  const prefix = rootPrefix(rootPath);
  return sha256Hex(JSON.stringify(entries
    .filter((entry) => entry.path.startsWith(prefix))
    .map((entry) => [entry.path.slice(prefix.length), entry.sha])
    .sort(([left], [right]) => String(left).localeCompare(String(right)))));
}

export function computeChanges(
  previous: ReadonlyArray<{ path: string; gitBlobSha: string }>,
  current: ReadonlyArray<{ path: string; gitBlobSha: string }>,
): { added: string[]; changed: string[]; removed: string[] } {
  const before = new Map(previous.map((file) => [file.path, file.gitBlobSha]));
  const after = new Map(current.map((file) => [file.path, file.gitBlobSha]));
  const sort = (values: string[]) => values.sort((left, right) => left.localeCompare(right));
  return {
    added: sort([...after.keys()].filter((path) => !before.has(path))),
    changed: sort([...after.entries()].filter(([path, sha]) => before.has(path) && before.get(path) !== sha).map(([path]) => path)),
    removed: sort([...before.keys()].filter((path) => !after.has(path))),
  };
}

export function importProfileDigest(input: { overrides: MappingOverrides; visibility: VisibilityScope }): string {
  return sha256Hex(JSON.stringify({
    importer: IMPORTER_VERSION,
    visibility: input.visibility,
    title: input.overrides.title ?? null,
    summary: input.overrides.summary ?? null,
    license: input.overrides.license ?? null,
  }));
}

export interface SkillFrontmatter {
  present: boolean;
  name: string | null;
  description: string | null;
  keys: string[];
}

/** Minimal top-level scalar reader. Block scalars stay unparsed and need a reviewed mapping. */
export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const empty = { present: false, name: null, description: null, keys: [] };
  if (!/^---\r?\n/.test(body)) return empty;
  const lines = body.split(/\r?\n/);
  let end = -1;
  for (let index = 1; index < Math.min(lines.length, 400); index += 1) {
    if (lines[index] === "---" || lines[index] === "...") {
      end = index;
      break;
    }
  }
  if (end < 0) return empty;
  const values = new Map<string, string | null>();
  const keys: string[] = [];
  for (let index = 1; index < end; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim() || /^\s/.test(line) || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    keys.push(key);
    values.set(key, yamlScalar(match[2] ?? ""));
  }
  return { present: true, name: values.get("name") ?? null, description: values.get("description") ?? null, keys };
}

function yamlScalar(raw: string): string | null {
  const value = raw.trim();
  if (!value || /^[|>][+-]?\d*$/.test(value) || value.startsWith("[") || value.startsWith("{") || value.startsWith("&") || value.startsWith("*")) return null;
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value.replace(/\s+#.*$/, "");
}

/** Codex installs read at most this many characters between the `---` lines (apps/cli codex-workspace). */
const MAX_NATIVE_FRONTMATTER_LENGTH = 32_768;
const MAX_NATIVE_DESCRIPTION_LENGTH = 1_024;
const RUNTIME_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const FRONTMATTER_KEY = /^([A-Za-z_][A-Za-z0-9_.-]*):(?=[ \t]|$)/;
/** Keys that the YAML core schema would read as null or a boolean. */
const NON_STRING_KEY = /^(?:null|Null|NULL|true|True|TRUE|false|False|FALSE)$/;
/** Plain scalars that the YAML core schema would read as null, a boolean or a number. */
const NON_STRING_PLAIN = /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+|[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
const DOUBLE_QUOTED_ESCAPE = /^(?:[0abt\tnvfre "/\\N_LP]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/;
const SIMPLE_ESCAPES: Record<string, string> = {
  "0": "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b",
  " ": " ", "\"": "\"", "/": "/", "\\": "\\", N: "\u0085", _: "\xa0", L: "\u{2028}", P: "\u{2029}",
};

type NativeFindingCode = "invalid-native-name" | "native-frontmatter-unsupported";

export type RuntimeNameResult =
  | { ok: true; content: string; originalName: string | null; action: "replaced" | "inserted" | "unchanged" }
  | { ok: false; code: NativeFindingCode; message: string };

interface SourceLine { text: string; start: number; eol: string }

/** One top-level value. `start`/`end` index the value token (quotes included) in its line. */
type ScalarToken =
  | { kind: "empty" }
  | { kind: "plain" | "double" | "single"; value: string; start: number; end: number }
  | { kind: "block" }
  | { kind: "unsupported" };

interface FrontmatterEntry { key: string; line: SourceLine; scalar: ScalarToken; body: SourceLine[] }

type NativeFrontmatter =
  | { ok: true; lines: SourceLine[]; entries: Map<string, FrontmatterEntry> }
  | { ok: false; code: NativeFindingCode; message: string };

/**
 * Set the runtime SKILL.md name to the registry slug. Only the name value
 * changes (or one `name:` line is inserted after the opening delimiter).
 * Frontmatter outside a small, checkable subset of YAML fails closed rather
 * than being reinterpreted, so a ready package passes the Codex install check.
 */
export function normalizeRuntimeSkillName(document: string, runtimeName: string): RuntimeNameResult {
  if (!RUNTIME_NAME_PATTERN.test(runtimeName) || runtimeName.length > 64) {
    return { ok: false, code: "invalid-native-name", message: "The registry slug cannot be used as a Codex skill name." };
  }
  const source = analyzeNativeFrontmatter(document);
  if (!source.ok) return source;
  const name = source.entries.get("name");
  const scalar = name?.scalar;
  const token = isTextScalar(scalar) ? scalar : null;
  const originalName = token?.value ?? null;
  let content = document;
  let action: "replaced" | "inserted" | "unchanged" = "unchanged";
  if (!name) {
    const opening = source.lines[0]!;
    const insertAt = opening.text.length + opening.eol.length;
    content = `${document.slice(0, insertAt)}name: ${runtimeName}${opening.eol}${document.slice(insertAt)}`;
    action = "inserted";
  } else if (token && originalName !== runtimeName) {
    const quote = token.kind === "double" ? "\"" : token.kind === "single" ? "'" : "";
    content = `${document.slice(0, name.line.start + token.start)}${quote}${runtimeName}${quote}${document.slice(name.line.start + token.end)}`;
    action = "replaced";
  }
  const result = analyzeNativeFrontmatter(content);
  if (!result.ok) return { ok: false, code: result.code, message: `With the registry slug as its name: ${result.message}` };
  const written = result.entries.get("name")?.scalar;
  if (!isTextScalar(written) || written.value !== runtimeName || result.entries.size !== source.entries.size + (name ? 0 : 1)) {
    return { ok: false, code: "invalid-native-name", message: "The registry slug could not be written as the SKILL.md name." };
  }
  return { ok: true, content, originalName, action };
}

function analyzeNativeFrontmatter(document: string): NativeFrontmatter {
  const unsupported = (message: string): NativeFrontmatter => ({ ok: false, code: "native-frontmatter-unsupported", message });
  if (document.startsWith("\u{FEFF}")) {
    return unsupported("SKILL.md starts with a byte order mark. Codex needs `---` as its first bytes, and MySkills changes only the name value.");
  }
  if (!/^---\r?\n/.test(document)) return unsupported("SKILL.md has no frontmatter. Codex needs `---` frontmatter with a name and a description.");
  // Mirrors the Codex install reader: the frontmatter ends at the first line that is exactly `---`.
  const lines: SourceLine[] = [];
  let closed = false;
  for (let start = 0; ;) {
    const newline = document.indexOf("\n", start);
    const end = newline < 0 ? document.length : newline;
    const crlf = newline >= 0 && end > start && document[end - 1] === "\r";
    const line = { text: document.slice(start, crlf ? end - 1 : end), start, eol: newline < 0 ? "" : crlf ? "\r\n" : "\n" };
    if (lines.length > 0 && line.text === "---") {
      closed = true;
      break;
    }
    lines.push(line);
    if (newline < 0 || start - lines[0]!.eol.length > MAX_NATIVE_FRONTMATTER_LENGTH + 3) break;
    start = newline + 1;
  }
  if (!closed) return unsupported("SKILL.md frontmatter has no closing `---` line within the length Codex reads.");
  const body = lines.slice(1);
  const last = body.at(-1);
  const length = last ? last.start + last.text.length - body[0]!.start : 0;
  if (length < 1 || body.every((line) => line.text.trim() === "")) return unsupported("SKILL.md frontmatter is empty.");
  if (length > MAX_NATIVE_FRONTMATTER_LENGTH) return unsupported(`SKILL.md frontmatter is longer than the ${MAX_NATIVE_FRONTMATTER_LENGTH} characters Codex reads.`);

  const entries = new Map<string, FrontmatterEntry>();
  let current: FrontmatterEntry | null = null;
  for (const [index, line] of body.entries()) {
    const lineNumber = index + 2;
    if (/[\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u{FEFF}\u{FFFE}\u{FFFF}]/u.test(line.text)) {
      return unsupported(`SKILL.md frontmatter line ${lineNumber} contains a control character or a stray carriage return.`);
    }
    if (/^ *\t/.test(line.text)) return unsupported(`SKILL.md frontmatter line ${lineNumber} is indented with a tab.`);
    if (line.text.trim() === "") {
      current?.body.push(line);
      continue;
    }
    // A comment at column 0 ends the value above it; indented text after it has no owner.
    if (line.text.startsWith("#")) {
      current = null;
      continue;
    }
    if (line.text.startsWith(" ")) {
      if (!current) return unsupported(`SKILL.md frontmatter line ${lineNumber} is indented without a key above it.`);
      current.body.push(line);
      continue;
    }
    const key = FRONTMATTER_KEY.exec(line.text)?.[1];
    if (!key || NON_STRING_KEY.test(key)) return unsupported(`SKILL.md frontmatter line ${lineNumber} is not a plain \`key: value\` entry.`);
    if (entries.has(key)) {
      return { ok: false, code: key === "name" ? "invalid-native-name" : "native-frontmatter-unsupported", message: `SKILL.md frontmatter declares \`${key}\` more than once.` };
    }
    current = { key, line, scalar: readFrontmatterScalar(line.text, key.length + 1), body: [] };
    entries.set(key, current);
  }

  for (const entry of entries.values()) {
    const problem = frontmatterValueProblem(entry);
    if (!problem) continue;
    if (entry.key === "name") return { ok: false, code: "invalid-native-name", message: "The SKILL.md name is not a single-line text value, so MySkills cannot replace it safely." };
    return unsupported(`SKILL.md frontmatter \`${entry.key}\` ${problem}.`);
  }
  const name = entries.get("name")?.scalar;
  if (name && !isTextScalar(name)) {
    return { ok: false, code: "invalid-native-name", message: "The SKILL.md name is not a single-line text value, so MySkills cannot replace it safely." };
  }
  if (name && (!name.value || (name.kind === "plain" && NON_STRING_PLAIN.test(name.value)))) {
    return { ok: false, code: "invalid-native-name", message: "The SKILL.md name is empty or is not text." };
  }
  const description = entries.get("description");
  if (!description) return unsupported("SKILL.md frontmatter has no description, which Codex requires. MySkills does not write descriptions.");
  const descriptionProblem = nativeDescriptionProblem(description);
  if (descriptionProblem) return unsupported(`SKILL.md description ${descriptionProblem}.`);
  return { ok: true, lines, entries };
}

/** Reads the value that starts after `from` in one line. Anything outside the checked subset is unsupported. */
function readFrontmatterScalar(text: string, from: number): ScalarToken {
  const start = from + (/^[ \t]*/.exec(text.slice(from))?.[0].length ?? 0);
  const rest = text.slice(start);
  if (rest === "" || rest.startsWith("#")) return { kind: "empty" };
  const closesLine = (after: number) => /^(?:[ \t]*|[ \t]+#.*)$/.test(text.slice(after));
  if (rest.startsWith("\"")) {
    let value = "";
    for (let index = start + 1; index < text.length; index += 1) {
      const character = text[index]!;
      if (character === "\"") return closesLine(index + 1) ? { kind: "double", value, start, end: index + 1 } : { kind: "unsupported" };
      if (character !== "\\") {
        value += character;
        continue;
      }
      const escape = DOUBLE_QUOTED_ESCAPE.exec(text.slice(index + 1))?.[0];
      const decoded = escape === undefined ? undefined : SIMPLE_ESCAPES[escape] ?? codePoint(escape.slice(1));
      if (decoded === undefined) return { kind: "unsupported" };
      value += decoded;
      index += escape!.length;
    }
    return { kind: "unsupported" };
  }
  if (rest.startsWith("'")) {
    let value = "";
    for (let index = start + 1; index < text.length; index += 1) {
      if (text[index] !== "'") {
        value += text[index]!;
        continue;
      }
      if (text[index + 1] === "'") {
        value += "'";
        index += 1;
        continue;
      }
      return closesLine(index + 1) ? { kind: "single", value, start, end: index + 1 } : { kind: "unsupported" };
    }
    return { kind: "unsupported" };
  }
  if (/^[|>][+-]?(?:[ \t]+#.*)?[ \t]*$/.test(rest)) return { kind: "block" };
  // Indicators, flow collections, anchors, aliases and tags are not interpreted.
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(rest)) return { kind: "unsupported" };
  const comment = /[ \t]#/.exec(rest);
  const value = (comment ? rest.slice(0, comment.index) : rest).replace(/[ \t]+$/, "");
  if (/:(?:[ \t]|$)/.test(value)) return { kind: "unsupported" };
  return { kind: "plain", value, start, end: start + value.length };
}

function isTextScalar(scalar: ScalarToken | undefined): scalar is Extract<ScalarToken, { value: string }> {
  return scalar?.kind === "plain" || scalar?.kind === "double" || scalar?.kind === "single";
}

function codePoint(hex: string): string | undefined {
  const value = Number.parseInt(hex, 16);
  return value <= 0x10ffff && (value < 0xd800 || value > 0xdfff) ? String.fromCodePoint(value) : undefined;
}

function frontmatterValueProblem(entry: FrontmatterEntry): string | null {
  const content = entry.body.filter((line) => line.text.trim() !== "");
  switch (entry.scalar.kind) {
    case "unsupported":
      return "has a value MySkills cannot check for Codex (an indicator, flow collection, anchor, alias, tag, unclosed quote or invalid escape)";
    case "plain":
    case "double":
    case "single":
      return content.length > 0 ? "continues on indented lines" : null;
    case "block": {
      const first = entry.body.findIndex((line) => line.text.trim() !== "");
      if (first < 0) return null;
      const indent = leadingSpaces(entry.body[first]!.text);
      if (entry.body.slice(0, first).some((line) => line.text.length > indent)) return "has blank lines indented deeper than its text";
      return entry.body.slice(first).some((line) => line.text.trim() !== "" && leadingSpaces(line.text) < indent) ? "has block text with uneven indentation" : null;
    }
    case "empty":
      return content.length > 0 ? nestedValueProblem(content) : null;
  }
}

/** One level of `key: value` or `- value` lines. Deeper structure is not interpreted. */
function nestedValueProblem(content: SourceLine[]): string | null {
  const lines = content.filter((line) => !line.text.trimStart().startsWith("#"));
  if (lines.length === 0) return null;
  const indent = leadingSpaces(lines[0]!.text);
  let shape: "sequence" | "mapping" | null = null;
  const keys = new Set<string>();
  for (const line of lines) {
    if (leadingSpaces(line.text) !== indent) return "nests values more than one level deep";
    const text = line.text.slice(indent);
    let scalar: ScalarToken;
    if (text === "-" || text.startsWith("- ")) {
      if (shape === "mapping") return "mixes a list and a mapping";
      shape = "sequence";
      scalar = readFrontmatterScalar(text, 1);
    } else {
      const key = FRONTMATTER_KEY.exec(text)?.[1];
      if (!key || NON_STRING_KEY.test(key)) return "has a nested line that is not a plain `key: value` or `- value` entry";
      if (shape === "sequence") return "mixes a list and a mapping";
      shape = "mapping";
      if (keys.has(key)) return `declares \`${key}\` more than once`;
      keys.add(key);
      scalar = readFrontmatterScalar(text, key.length + 1);
    }
    if (scalar.kind === "block" || scalar.kind === "unsupported") return "has a nested value MySkills cannot check for Codex";
  }
  return null;
}

function nativeDescriptionProblem(entry: FrontmatterEntry): string | null {
  const scalar = entry.scalar;
  if (isTextScalar(scalar)) {
    if (scalar.kind === "plain" && NON_STRING_PLAIN.test(scalar.value)) return "is not text";
    if (!scalar.value.trim()) return "is empty";
    return scalar.value.length > MAX_NATIVE_DESCRIPTION_LENGTH ? `is longer than the ${MAX_NATIVE_DESCRIPTION_LENGTH} characters Codex accepts` : null;
  }
  if (scalar.kind !== "block") return "must be one text value";
  if (!entry.body.some((line) => line.text.trim() !== "")) return "is empty";
  // The folded or literal value is never longer than its raw lines.
  const rawLength = entry.body.reduce((total, line) => total + line.text.length + 1, 0);
  return rawLength > MAX_NATIVE_DESCRIPTION_LENGTH ? `may be longer than the ${MAX_NATIVE_DESCRIPTION_LENGTH} characters Codex accepts` : null;
}

function leadingSpaces(text: string): number {
  return /^ */.exec(text)![0].length;
}

/**
 * Build one candidate from verified bytes. Returns a blocked result (no held
 * bytes) whenever any blocking finding exists; files are never dropped.
 */
export async function buildCandidatePackage(input: CandidatePackageInput): Promise<CandidatePackageResult> {
  const allRoots = listSkillRootPaths(input.entries, "");
  const analysis = analyzeSkillRoot(input.entries, input.rootPath, allRoots);
  const sourceFiles = packageSourceFiles(input.entries, input.rootPath);
  const sourceDigest = computeSourceDigest(input.entries, input.rootPath) ?? sha256Hex(`missing:${input.rootPath}`);
  const headFiles = sourceFiles.map((file) => ({ path: file.packagePath, gitBlobSha: file.entry.sha }));
  const placeholderMapping = (nativeName: string | null, transforms: LibraryTransform[] = []): LibraryCandidateMapping => ({
    slug: input.slug,
    title: input.overrides.title ?? nativeName ?? "",
    summary: input.overrides.summary ?? "",
    license: input.overrides.license ?? input.licenseSpdx ?? "",
    visibility: input.visibility,
    platforms: [{ name: IMPORT_PLATFORM.name, installTarget: IMPORT_PLATFORM.install_target, status: "supported" }],
    nativeName,
    transforms,
  });
  const blocked = (findings: LibraryFinding[], nativeName: string | null, fileDigests: LibraryCandidateFile[] = [], transforms: LibraryTransform[] = []): CandidatePackageResult => ({
    ready: false,
    findings: dedupeFindings(findings),
    files: null,
    fileDigests,
    sourceDigest,
    packageDigest: null,
    nativeName,
    mapping: placeholderMapping(nativeName, transforms),
    headFiles,
    provenanceFiles: [],
  });
  if (analysis.blockers.some((finding) => finding.severity === "blocking")) {
    return blocked(analysis.blockers, analysis.directoryName || null);
  }

  const findings: LibraryFinding[] = [...analysis.blockers];
  const fetched: Array<PackageSourceFile & { bytes: Uint8Array; text: string | null }> = [];
  for (const file of sourceFiles) {
    const bytes = await input.fetchBlob(file);
    const text = decodeText(bytes);
    if (text === null) {
      findings.push({ code: "unsupported-binary", severity: "blocking", message: "Binary or non-UTF-8 files are not supported by the text package format.", path: file.sourcePath });
    } else if (text.startsWith(LFS_POINTER_PREFIX)) {
      findings.push({ code: "unsupported-lfs-pointer", severity: "blocking", message: "Git LFS pointers cannot be packaged without their content.", path: file.sourcePath });
    }
    fetched.push({ ...file, bytes, text });
  }
  const upstreamDigests: LibraryCandidateFile[] = fetched.map((file) => ({
    path: file.packagePath,
    sha256: sha256Hex(file.bytes),
    bytes: file.bytes.byteLength,
    origin: file.origin,
    sourcePath: file.sourcePath,
    gitBlobSha: file.entry.sha,
  }));
  const skillFile = fetched.find((file) => file.packagePath === "SKILL.md" && file.origin === "upstream");
  const frontmatter = parseSkillFrontmatter(skillFile?.text ?? "");
  const runtime = skillFile && skillFile.text !== null ? normalizeRuntimeSkillName(skillFile.text, input.slug) : null;
  const nativeName = (runtime?.ok ? runtime.originalName : frontmatter.name) ?? (analysis.directoryName || null);
  if (skillFile && skillFile.text !== null && !Buffer.from(skillFile.text, "utf8").equals(skillFile.bytes)) {
    findings.push({ code: "unsupported-binary", severity: "blocking", message: "SKILL.md does not round-trip exactly through UTF-8 text, so its original bytes cannot be preserved.", path: skillFile.sourcePath });
  }
  // The same bound applies when the directory supplies the name.
  if (nativeName !== null && (nativeName.length > 200 || /[\u0000-\u001f\u007f]/.test(nativeName))) {
    findings.push({ code: "invalid-native-name", severity: "blocking", message: "The native skill name is not a single printable line of at most 200 characters.", path: skillFile?.sourcePath });
  }
  const unknownKeys = frontmatter.keys.filter((key) => !KNOWN_FRONTMATTER_KEYS.has(key));
  if (unknownKeys.length > 0) {
    findings.push({ code: "host-capability-review", severity: "warning", message: `SKILL.md declares host-specific fields: ${unknownKeys.slice(0, 10).join(", ")}.`, path: skillFile?.sourcePath });
  }
  if (findings.some((finding) => finding.severity === "blocking")) {
    return blocked(findings, nativeName, upstreamDigests);
  }
  findings.push(...referenceFindings(fetched));

  const transforms: LibraryTransform[] = [
    { kind: "generated-manifest", path: GENERATED_MANIFEST_PATH },
    { kind: "generated-import-manifest", path: IMPORT_MANIFEST_PATH },
    { kind: "platform-mapping", detail: "codex:codex-skill (existing package contract)" },
    ...(runtime?.ok && skillFile ? [{
      kind: "normalize-runtime-name" as const,
      path: "SKILL.md",
      detail: `name-${runtime.action}`,
      originalPath: ORIGINAL_SKILL_PATH,
      originalSha256: sha256Hex(skillFile.bytes),
      transformedSha256: sha256Hex(runtime.content),
      originalName: runtime.originalName,
      runtimeName: input.slug,
    }] : []),
    ...fetched.filter((file) => file.origin === "repository-notice").map((file) => ({ kind: "include-repository-notice" as const, path: file.packagePath, detail: file.sourcePath })),
  ];
  const overridden = (["title", "summary", "license"] as const).filter((field) => input.overrides[field] !== undefined);
  if (overridden.length > 0) transforms.push({ kind: "reviewed-metadata-mapping", detail: overridden.join(",") });

  const title = (input.overrides.title ?? nativeName ?? "").trim();
  const summary = (input.overrides.summary ?? frontmatter.description ?? "").trim();
  if (title.length < 1 || title.length > 120) {
    findings.push({ code: "metadata-mapping-required", severity: "blocking", message: "The native name does not fit the 1-120 character title. Supply a reviewed title mapping.", path: skillFile?.sourcePath });
  }
  if (summary.length < 1 || summary.length > 500) {
    findings.push({ code: "metadata-mapping-required", severity: "blocking", message: "The description is missing or longer than 500 characters. Supply a reviewed summary; source text is never truncated.", path: skillFile?.sourcePath });
  }
  const hasNotice = fetched.some((file) => NOTICE_PATTERN.test(posix.basename(file.packagePath)));
  const license = (input.overrides.license ?? (hasNotice ? input.licenseSpdx : null) ?? "").trim();
  if (!license || license.length > 80) {
    findings.push({ code: "license-review-required", severity: "blocking", message: "No licence evidence with a known identifier was found. Record an explicit licence decision to import; saving as a reference is still possible." });
  }
  if (runtime && !runtime.ok) {
    findings.push({ code: runtime.code, severity: "blocking", message: runtime.message, path: skillFile?.sourcePath });
  }
  if (findings.some((finding) => finding.severity === "blocking") || !runtime?.ok || !skillFile || skillFile.text === null) {
    return blocked(findings, nativeName, upstreamDigests, transforms);
  }

  const manifestInput = {
    name: input.slug,
    title,
    summary,
    version: input.version,
    license,
    visibility: input.visibility,
    platforms: [IMPORT_PLATFORM],
    tags: [] as string[],
  };
  let manifest: SkillManifest;
  try {
    manifest = parseSkillManifest(manifestInput);
  } catch {
    return blocked([...findings, { code: "metadata-mapping-required", severity: "blocking", message: "The mapped metadata does not satisfy the strict MySkills manifest." }], nativeName, upstreamDigests, transforms);
  }
  // The upstream SKILL.md blob is held at the preserved path; no entry claims the runtime SKILL.md is upstream.
  const provenanceFiles = fetched.map((file) => ({
    path: file === skillFile ? ORIGINAL_SKILL_PATH : file.packagePath,
    sourcePath: file.sourcePath,
    gitBlobSha: file.entry.sha,
    sha256: sha256Hex(file.bytes),
    bytes: file.bytes.byteLength,
    origin: file.origin,
  }));
  const importManifest = {
    schemaVersion: 1,
    importer: IMPORTER_VERSION,
    source: {
      provider: "github",
      repositoryId: input.source.repositoryId,
      repository: input.source.fullName,
      url: input.source.url,
      commit: input.source.commit,
      tree: input.source.treeSha,
      path: input.rootPath,
      ref: input.source.ref.value === undefined ? { kind: input.source.ref.kind } : { kind: input.source.ref.kind, value: input.source.ref.value },
      upstreamLabel: input.source.upstreamLabel,
      releaseId: input.source.releaseId,
    },
    nativeName,
    mapping: { slug: manifest.name, title: manifest.title, summary: manifest.summary, license: manifest.license },
    files: provenanceFiles,
    transforms,
  };
  const files: HeldFile[] = [
    ...fetched.map((file): HeldFile => (file === skillFile
      ? { path: file.packagePath, content: runtime.content, origin: "generated", sourcePath: file.sourcePath, gitBlobSha: null }
      : { path: file.packagePath, content: file.text ?? "", origin: file.origin, sourcePath: file.sourcePath, gitBlobSha: file.entry.sha })),
    { path: ORIGINAL_SKILL_PATH, content: skillFile.text, origin: "upstream", sourcePath: skillFile.sourcePath, gitBlobSha: skillFile.entry.sha },
    { path: GENERATED_MANIFEST_PATH, content: `${JSON.stringify(manifest, null, 2)}\n`, origin: "generated", sourcePath: null, gitBlobSha: null },
    { path: IMPORT_MANIFEST_PATH, content: `${JSON.stringify(importManifest, null, 2)}\n`, origin: "generated", sourcePath: null, gitBlobSha: null },
  ];
  const packageFiles: PackageInputFile[] = files.map((file) => ({ path: file.path, content: file.content }));
  try {
    validatePackageFiles(packageFiles);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Package validation failed.";
    return blocked([...findings, {
      code: /more than|exceeds/i.test(message) ? "limit-exceeded" : "unsupported-path",
      severity: "blocking",
      message,
    }], nativeName, upstreamDigests, transforms);
  }
  for (const finding of scanPackageFiles(packageFiles).findings) {
    findings.push({
      code: finding.severity === "blocking" ? "package-scan-blocking" : "package-scan-warning",
      severity: finding.severity,
      message: `${finding.category}: ${finding.message}`,
      ...(finding.path ? { path: finding.path } : {}),
    });
  }
  const mapping: LibraryCandidateMapping = {
    slug: manifest.name,
    title: manifest.title,
    summary: manifest.summary,
    license: manifest.license,
    visibility: manifest.visibility,
    platforms: [{ name: IMPORT_PLATFORM.name, installTarget: IMPORT_PLATFORM.install_target, status: "supported" }],
    nativeName,
    transforms,
  };
  if (findings.some((finding) => finding.severity === "blocking")) {
    return { ...blocked(findings, nativeName, upstreamDigests, transforms), mapping };
  }
  const sortedFiles = [...files].sort((left, right) => left.path.localeCompare(right.path));
  return {
    ready: true,
    findings: dedupeFindings(findings),
    files: sortedFiles,
    fileDigests: sortedFiles.map((file) => ({
      path: file.path,
      sha256: sha256Hex(file.content),
      bytes: Buffer.byteLength(file.content),
      origin: file.origin,
      sourcePath: file.sourcePath,
      gitBlobSha: file.gitBlobSha,
    })),
    sourceDigest,
    packageDigest: packageDigestFor(sortedFiles),
    nativeName,
    mapping,
    headFiles,
    provenanceFiles,
  };
}

export function packageDigestFor(files: ReadonlyArray<{ path: string; content: string }>): string {
  return artifactPayloadSha256(canonicalArtifactPayload(files.map((file) => ({ path: file.path, content: file.content }))));
}

export function suggestedImportRelease(source: CandidateSourceContext, rootPath: string) {
  return {
    classification: "unclassified" as const,
    changeKind: "breaking" as const,
    requiresUserAction: true as const,
    releaseNotes: conservativeImportReleaseNotes({ repository: source.fullName, commit: source.commit, path: rootPath, upstreamLabel: source.upstreamLabel }),
  };
}

function referenceFindings(files: ReadonlyArray<PackageSourceFile & { text: string | null }>): LibraryFinding[] {
  const findings: LibraryFinding[] = [];
  const paths = new Set(files.map((file) => file.packagePath));
  const directories = new Set<string>();
  for (const path of paths) {
    let directory = posix.dirname(path);
    while (directory && directory !== ".") {
      directories.add(directory);
      directory = posix.dirname(directory);
    }
  }
  let external = 0;
  for (const file of files) {
    if (file.origin !== "upstream" || !file.text || !/\.(?:md|markdown)$/i.test(file.packagePath)) continue;
    for (const match of file.text.matchAll(MARKDOWN_LINK_PATTERN)) {
      let target = (match[1] ?? "").split("#")[0]!.split("?")[0]!;
      if (!target) continue;
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) {
        if (/^https?:/i.test(target)) external += 1;
        continue;
      }
      try {
        target = decodeURIComponent(target);
      } catch {
        continue;
      }
      if (target.startsWith("/")) {
        findings.push({ code: "cross-root-dependency", severity: "blocking", message: "A repository-absolute reference points outside the selected skill.", path: file.sourcePath });
        continue;
      }
      const resolved = posix.normalize(posix.join(posix.dirname(file.packagePath), target));
      if (resolved === ".." || resolved.startsWith("../")) {
        findings.push({ code: "cross-root-dependency", severity: "blocking", message: `A relative reference leaves the selected skill: ${target}`, path: file.sourcePath });
      } else if (resolved !== "." && !paths.has(resolved) && !directories.has(resolved)) {
        findings.push({ code: "unresolved-dependency", severity: "blocking", message: `A referenced file is missing from the selected skill: ${target}`, path: file.sourcePath });
      }
    }
  }
  if (external > 0) {
    findings.push({ code: "external-reference", severity: "info", message: `${external} external link(s) are kept as text and never fetched during import.` });
  }
  return findings;
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

function dedupeFindings(findings: LibraryFinding[]): LibraryFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.code}\u0000${finding.path ?? ""}\u0000${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
