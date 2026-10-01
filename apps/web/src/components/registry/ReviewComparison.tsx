import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { safeReviewErrorMessage, type RegistryClient, type ReviewSubmissionSummary, type SkillReleaseSummary } from "../../api.js";
import { compareFiles, verifyBundle } from "./comparison-package.js";
import { isPublishedRelease } from "./skill-workspace.js";

type Changes = ReturnType<typeof compareFiles>;
export function ReviewComparison({ client, submission }: { client: RegistryClient; submission: ReviewSubmissionSummary }) {
  return <ReviewComparisonWorkspace key={`${submission.id}:${submission.slug}:${submission.version}`} client={client} submission={submission} />;
}
function ReviewComparisonWorkspace({ client, submission }: { client: RegistryClient; submission: ReviewSubmissionSummary }) {
  const [releases, setReleases] = useState<SkillReleaseSummary[]>([]);
  const [loadedClient, setLoadedClient] = useState<RegistryClient | null>(null);
  const [baseVersion, setBaseVersion] = useState("");
  const [result, setResult] = useState<{ client: RegistryClient; changes: Changes; candidateSha256: string; baseSha256: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    const ticket = ++epoch.current;
    setReleases([]); setLoadedClient(null); setResult(null); setBaseVersion(""); setMessage(null); setBusy(false);
    void client.listSkillReleases(submission.slug).then(rows => {
      if (ticket !== epoch.current) return;
      setReleases(rows.filter(row => row.slug === submission.slug && row.version !== submission.version && isPublishedRelease(row) && /^[a-f0-9]{64}$/.test(row.artifact?.sha256 ?? "")));
      setLoadedClient(client);
    }).catch(() => { if (ticket === epoch.current) setMessage("A readable published baseline is unavailable. Candidate inspection remains separate."); });
    return () => { epoch.current += 1; };
  }, [client, submission.slug]);
  const currentRows = loadedClient === client ? releases : [];
  const base = currentRows.find(row => row.version === baseVersion);
  async function compare() {
    if (!base?.artifact || !client.getReleaseBundle || !client.getReviewSubmissionDetail) return;
    const ticket = ++epoch.current;
    setResult(null); setMessage(null); setBusy(true);
    try {
      const exact = await client.getRelease(submission.slug, base.version);
      if (exact.slug !== submission.slug || exact.version !== base.version || exact.artifact.sha256 !== base.artifact.sha256 || !isPublishedRelease(exact)) throw new Error("Baseline changed.");
      const detail = await client.getReviewSubmissionDetail(submission.id);
      if (detail.id !== submission.id || detail.slug !== submission.slug || detail.version !== submission.version) throw new Error("Candidate identity changed.");
      const before = await client.getReleaseBundle(submission.slug, base.version);
      await verifyBundle(before, exact);
      const candidate = await client.getReviewSubmissionBundle(submission.id);
      await verifyBundle(candidate.payload, { slug: submission.slug, version: submission.version, artifact: { sha256: candidate.artifactSha256 } });
      const finalBase = await client.getRelease(submission.slug, base.version);
      if (finalBase.artifact.sha256 !== exact.artifact.sha256 || !isPublishedRelease(finalBase)) throw new Error("Baseline changed.");
      const finalCandidate = await client.getReviewSubmissionBundle(submission.id);
      if (finalCandidate.artifactSha256 !== candidate.artifactSha256) throw new Error("Candidate changed.");
      await verifyBundle(finalCandidate.payload, { slug: submission.slug, version: submission.version, artifact: { sha256: candidate.artifactSha256 } });
      if (ticket === epoch.current) setResult({ client, changes: compareFiles(before, candidate.payload), candidateSha256: candidate.artifactSha256, baseSha256: exact.artifact.sha256 });
    } catch (error) {
      if (ticket === epoch.current) { setResult(null); setMessage(`Review comparison unavailable. ${safeReviewErrorMessage(error)}`); }
    } finally { if (ticket === epoch.current) setBusy(false); }
  }
  const visible = result?.client === client ? result : null;
  return <section className="control-plane-section" aria-label="Review package comparison" aria-busy={busy}>
    <h3>Compare before approval</h3>
    <p>Compare this candidate with a readable published release. Full file contents determine changes; displayed previews are limited to 1,024 characters per side. Nothing executes or approves.</p>
    <label>Published baseline<select aria-label="Published baseline" value={baseVersion} onChange={event => { epoch.current += 1; setBaseVersion(event.target.value); setResult(null); setBusy(false); }}><option value="">Choose an exact release</option>{currentRows.map(row => <option key={row.id} value={row.version}>{row.version}</option>)}</select></label>
    <Button type="button" size="sm" variant="outline" disabled={busy || !base || !client.getReleaseBundle || !client.getReviewSubmissionDetail} onClick={() => void compare()}>Compare candidate</Button>
    {loadedClient === client && !currentRows.length && <p>No published baseline is available for this candidate. Inspect its complete package files before the first approval.</p>}
    {message && <p role="alert">{message}</p>}
    {visible && <>
      <p className="registry-mono">Base SHA-256: {visible.baseSha256}<br />Candidate SHA-256: {visible.candidateSha256}</p>
      <p>{["Added", "Removed", "Modified", "Unchanged"].map(kind => `${kind} ${visible.changes.filter(file => file.kind === kind).length}`).join(" · ")}</p>
      {visible.changes.map(file => <details key={file.path}><summary><code>{file.path}</code> · {file.kind}</summary>{file.kind !== "Unchanged" && <>{(["base", "target"] as const).map(side => <div key={side}><strong>{side === "base" ? baseVersion : submission.version}</strong>{file[side] === undefined ? <p>File absent</p> : file[side].includes("\0") ? <p>Binary preview omitted.</p> : <><pre className="package-file-content"><code>{file[side].slice(0, 1024)}</code></pre>{file[side].length > 1024 && <p>Preview truncated. Comparison used complete content.</p>}</>}</div>)}</>}</details>)}
    </>}
  </section>;
}
