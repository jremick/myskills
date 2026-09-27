import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PackageFileViewer } from "../registry/PackageFileViewer.js";
import { libraryError, type LibraryClient, type SelfReviewedRelease } from "../../library-api.js";

export function LibrarySharingReview({ api, mfaVerified }: { api: LibraryClient; mfaVerified: boolean }) {
  const [requests, setRequests] = useState<SelfReviewedRelease[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true); setError(null);
    try { setRequests((await api.reviewRequests()).releases); }
    catch (e) { setError(libraryError(e)); }
    finally { setBusy(false); }
  }
  return <section className="library-admin-panel" aria-labelledby="library-sharing-title">
    <header><h2 id="library-sharing-title">Sharing requests</h2><p className="library-muted">Owners request instance review before sharing a privately approved import.</p></header>
    <div className="library-actions"><Button size="sm" variant="outline" disabled={busy || !mfaVerified} onClick={() => void load()}>Review sharing requests</Button></div>
    {error && <p role="alert" className="library-alert">{error}</p>}
    {requests?.length === 0 && <p className="library-muted">No sharing reviews requested.</p>}
    {requests?.map((request) => <SharingReview key={`${request.submissionId}:${request.artifactSha256}`} api={api} request={request} onDone={load} />)}
  </section>;
}

function SharingReview({ api, request, onDone }: { api: LibraryClient; request: SelfReviewedRelease; onDone: () => Promise<void> }) {
  const [inspected, setInspected] = useState(false);
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <article className="library-candidate">
    <header className="library-candidate-head"><h3>{request.slug}@{request.version}</h3></header>
    <code className="library-digest">{request.artifactSha256}</code>
    <PackageFileViewer resourceKey={request.submissionId} label="Inspect private artifact" loadBundle={async () => {
      const bundle = await api.reviewBundle(request.submissionId, request.artifactSha256);
      setInspected(true); return bundle;
    }} />
    <label className="library-check"><input type="checkbox" checked={attested} disabled={!inspected || busy} onChange={(event) => setAttested(event.target.checked)} />I reviewed this artifact for shared use</label>
    <div className="library-form-actions"><Button size="sm" disabled={!inspected || !attested || busy} onClick={() => {
      setBusy(true); setError(null);
      void api.elevate(request.submissionId, request.artifactSha256).then(onDone).catch((e) => setError(libraryError(e))).finally(() => setBusy(false));
    }}>Approve artifact for sharing</Button></div>
    {error && <p role="alert" className="library-alert">{error}</p>}
  </article>;
}
