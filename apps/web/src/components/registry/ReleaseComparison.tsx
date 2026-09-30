import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { safeErrorMessage, type RegistryClient, type SkillPackageBundle, type SkillReleaseSummary } from "../../api.js";
import { isPublishedRelease } from "./skill-workspace.js";
import { releaseVersionLabel } from "./status-display.js";
import "./ReleaseComparison.css";

const MAX_FILES = 500;
const MAX_PACKAGE_CHARACTERS = 1_048_576;
const MAX_PREVIEW_CHARACTERS = 128_000;
const MANIFEST_NAMES = ["skill.json", "skill-manifest.json", "ai-skill.json"];
type Release = SkillReleaseSummary & { artifact: NonNullable<SkillReleaseSummary["artifact"]> };
type FileChange = { path: string; kind: "Added" | "Removed" | "Modified" | "Unchanged"; base: string | undefined; target: string | undefined };
type Comparison = { base: Release; target: Release; files: FileChange[] };
type Props = {
  client: Pick<RegistryClient, "getReleaseBundle">;
  slug: string;
  releases: SkillReleaseSummary[];
  historyState: "idle" | "loading" | "ready" | "error";
  /** Include current exact selection and session identity; never include secrets. */
  contextKey: string;
  /** The parent readable-skill check, rather than management authority, owns this reason. */
  unavailableReason?: string;
};

/** A scope change remounts the workspace so held content cannot cross identities. */
export function ReleaseComparison(props: Props) {
  const identity = JSON.stringify([props.contextKey, props.slug, props.historyState, props.unavailableReason,
    props.releases.map(release => [release.slug, release.version, release.lifecycleStatus, release.reviewStatus, release.securityStatus, release.publishedAt, release.artifact?.sha256])]);
  return <ComparisonWorkspace key={identity} {...props} />;
}

function ComparisonWorkspace({ client, slug, releases, historyState, unavailableReason }: Props) {
  const rows = releases.filter(release => release.slug === slug);
  const eligible = rows.filter(comparableRelease);
  const [baseVersion, setBaseVersion] = useState("");
  const [targetVersion, setTargetVersion] = useState("");
  const [result, setResult] = useState<Comparison | null>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const epoch = useRef(0);
  const baseId = useId();
  const [resultClient, setResultClient] = useState<typeof client | null>(null);

  useEffect(() => {
    epoch.current += 1;
    setResult(null);
    setSelectedPath("");
    setBaseVersion("");
    setTargetVersion("");
    setState("idle");
    setMessage(null);
    return () => { epoch.current += 1; };
  }, [client]);

  function clear() {
    epoch.current += 1;
    setResult(null);
    setSelectedPath("");
    setState("idle");
    setMessage(null);
  }

  const base = eligible.find(release => release.version === baseVersion);
  const target = eligible.find(release => release.version === targetVersion);
  const unavailable = unavailableReason ?? (!client.getReleaseBundle ? "This connection cannot read exact release packages."
    : historyState === "error" ? "Release history is unavailable. Retry release history before comparing packages."
      : historyState !== "ready" ? "Loading release history…"
        : eligible.length < 2 ? "Two readable published releases with SHA-256 digests are required to compare packages." : null);
  const canCompare = !unavailable && base && target && base.version !== target.version;

  async function compare() {
    if (!canCompare || !base || !target || !client.getReleaseBundle) return;
    const requestEpoch = ++epoch.current;
    setResult(null);
    setSelectedPath("");
    setMessage(null);
    setState("loading");
    try {
      // Every attempt rechecks current read authority for BOTH exact versions.
      // No owner export or review API is used to bypass an unavailable release.
      const [baseBundle, targetBundle] = await Promise.all([base, target].map(async release => {
        const bundle = await client.getReleaseBundle!(slug, release.version);
        await verifyBundle(bundle, release);
        return bundle;
      }));
      if (requestEpoch !== epoch.current) return;
      const files = compareFiles(baseBundle, targetBundle);
      setResult({ base, target, files });
      setResultClient(client);
      setSelectedPath(files.find(file => file.kind !== "Unchanged")?.path ?? files[0]?.path ?? "");
      setState("ready");
    } catch (error) {
      if (requestEpoch !== epoch.current) return;
      setResult(null);
      setState("error");
      setMessage(error instanceof ComparisonValidationError ? error.message
        : `Comparison is unavailable. The exact packages may no longer be readable. ${safeErrorMessage(error)}`);
    }
  }

  const visibleResult = resultClient === client ? result : null;
  const selected = visibleResult?.files.find(file => file.path === selectedPath);
  const counts = (kind: FileChange["kind"]) => visibleResult?.files.filter(file => file.kind === kind).length ?? 0;
  return <section aria-label="Release comparison" aria-busy={state === "loading"} className="release-comparison">
    <h3>Compare release packages</h3>
    <p className="registry-muted">Choose two exact versions. Files are compared in full and shown as text; nothing is executed.</p>
    <div className="release-comparison-controls">
      {(["Base", "Target"] as const).map(side => <label key={side} htmlFor={`${baseId}-${side}`}>
        <span>{side} version</span>
        <select id={`${baseId}-${side}`} value={side === "Base" ? baseVersion : targetVersion} disabled={Boolean(unavailable)} onChange={event => {
          clear();
          (side === "Base" ? setBaseVersion : setTargetVersion)(event.target.value);
        }}>
          <option value="">Choose an exact version</option>
          {rows.map(release => <option key={release.version} value={release.version} disabled={!comparableRelease(release)}>
            {releaseVersionLabel(release.version, rows)}{comparableRelease(release) ? "" : " · Unavailable to compare"}
          </option>)}
        </select>
      </label>)}
      <Button type="button" size="sm" variant="outline" disabled={!canCompare || state === "loading"} onClick={() => void compare()}>Compare releases</Button>
    </div>
    {unavailable && <p className="registry-muted" role="status">{unavailable}</p>}
    {rows.some(release => !comparableRelease(release)) && <p className="registry-muted">Unpublished and unavailable releases cannot be compared with the existing package reader.</p>}
    {baseVersion && baseVersion === targetVersion && <p className="registry-muted" role="status">Choose different base and target versions.</p>}
    {state === "loading" && <p className="registry-muted" role="status">Loading exact release packages…</p>}
    {message && <p role="alert">{message}</p>}
    {visibleResult && <>
      <div className="release-comparison-identities">
        {(["base", "target"] as const).map(side => <div key={side}>
          <h4>{side === "base" ? "Base" : "Target"} · {releaseVersionLabel(visibleResult[side].version, rows)}</h4>
          <code>{slug}@{visibleResult[side].version}</code>
          <span>SHA-256 <code>{visibleResult[side].artifact.sha256}</code></span>
        </div>)}
      </div>
      <p className="registry-muted" role="status">{counts("Added")} added · {counts("Removed")} removed · {counts("Modified")} modified · {counts("Unchanged")} unchanged</p>
      <label className="release-comparison-file" htmlFor={`${baseId}-file`}><span>Compared file</span><select id={`${baseId}-file`} value={selectedPath} onChange={event => setSelectedPath(event.target.value)}>
        {visibleResult.files.map(file => <option key={file.path} value={file.path}>{file.path} · {file.kind}</option>)}
      </select></label>
      {selected && <div className="release-comparison-contents">
        <FileContents side="Base" version={visibleResult.base.version} path={selected.path} content={selected.base} />
        <FileContents side="Target" version={visibleResult.target.version} path={selected.path} content={selected.target} />
      </div>}
    </>}
  </section>;
}

function FileContents({ side, version, path, content }: { side: "Base" | "Target"; version: string; path: string; content: string | undefined }) {
  const binary = content?.includes("\0") ?? false;
  return <div>
    <h5>{side} · <code>{version}</code></h5>
    {content === undefined ? <p className="registry-muted">Absent in {side.toLowerCase()} release.</p>
      : binary ? <p className="registry-muted">Binary content is not displayed. Export this exact release to inspect it locally.</p>
        : <><pre className="package-file-content" tabIndex={0} aria-label={`${side} contents of ${path}`}><code>{content.slice(0, MAX_PREVIEW_CHARACTERS)}</code></pre>
          {content.length > MAX_PREVIEW_CHARACTERS && <p className="registry-muted">Preview limited to the first {MAX_PREVIEW_CHARACTERS.toLocaleString()} characters. Comparison uses the complete file; export this exact release to inspect all content.</p>}</>}
  </div>;
}

function comparableRelease(release: SkillReleaseSummary): release is Release {
  return isPublishedRelease(release) && /^[a-f0-9]{64}$/.test(release.artifact?.sha256 ?? "");
}

class ComparisonValidationError extends Error {}

async function verifyBundle(bundle: SkillPackageBundle, release: Release): Promise<void> {
  if (!bundle || !Array.isArray(bundle.files) || bundle.files.length === 0 || bundle.files.length > MAX_FILES) {
    throw new ComparisonValidationError("This package cannot be compared safely.");
  }
  const paths = new Set<string>();
  let characters = 0;
  for (const file of bundle.files) {
    if (!file || typeof file.path !== "string" || !file.path || file.path.length > 1_024 || /[\\\u0000-\u001f]/.test(file.path)
      || file.path.split("/").some(part => !part || part === "." || part === "..") || paths.has(file.path) || typeof file.content !== "string") {
      throw new ComparisonValidationError("This package contains invalid or duplicate file paths.");
    }
    paths.add(file.path);
    characters += file.content.length;
    if (characters > MAX_PACKAGE_CHARACTERS) throw new ComparisonValidationError("This package exceeds the text comparison limit.");
  }
  // Hash the received immutable payload BEFORE display sorting. The existing
  // exact bundle API returns parsed JSON; its artifact bytes use JSON.stringify.
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(bundle)));
  const digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== release.artifact.sha256) throw new ComparisonValidationError("Package SHA-256 does not match the selected exact release. Refresh release history and try again.");
  const manifests = bundle.files.filter(file => MANIFEST_NAMES.includes(file.path));
  let manifest: { name?: unknown; version?: unknown } | null = null;
  try { if (manifests.length === 1) manifest = JSON.parse(manifests[0].content); } catch { /* Reject below without exposing package text. */ }
  if (!manifest || manifest.name !== release.slug || manifest.version !== release.version) {
    throw new ComparisonValidationError("Package identity does not match the selected skill and exact version. Refresh release history and try again.");
  }
}

function compareFiles(base: SkillPackageBundle, target: SkillPackageBundle): FileChange[] {
  const before = new Map(base.files.map(file => [file.path, file.content]));
  const after = new Map(target.files.map(file => [file.path, file.content]));
  // Codepoint order is stable across browser locale. Content stays untouched.
  return [...new Set([...before.keys(), ...after.keys()])].sort().map(path => ({ path, base: before.get(path), target: after.get(path),
    kind: !before.has(path) ? "Added" : !after.has(path) ? "Removed" : before.get(path) === after.get(path) ? "Unchanged" : "Modified" }));
}
