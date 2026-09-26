import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  return <Card><CardHeader><CardTitle>Sharing reviews</CardTitle></CardHeader><CardContent className="library-stack">
    <p className="control-plane-muted">Owners request instance review before sharing a privately approved import.</p>
    <Button size="sm" variant="outline" disabled={busy || !mfaVerified} onClick={() => void load()}>Review sharing requests</Button>
    {error && <p role="alert">{error}</p>}
    {requests?.length === 0 && <p>No sharing reviews requested.</p>}
    {requests?.map((request) => <SharingReview key={`${request.submissionId}:${request.artifactSha256}`} api={api} request={request} onDone={load} />)}
  </CardContent></Card>;
}

function SharingReview({ api, request, onDone }: { api: LibraryClient; request: SelfReviewedRelease; onDone: () => Promise<void> }) {
  const [inspected, setInspected] = useState(false);
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <article className="library-stack library-inset">
    <h3>{request.slug}@{request.version}</h3>
    <code className="library-digest">{request.artifactSha256}</code>
    <PackageFileViewer resourceKey={request.submissionId} label="Inspect private artifact" loadBundle={async () => {
      const bundle = await api.reviewBundle(request.submissionId, request.artifactSha256);
      setInspected(true); return bundle;
    }} />
    <label className="library-checkbox"><input type="checkbox" checked={attested} disabled={!inspected || busy} onChange={(event) => setAttested(event.target.checked)} />I reviewed this artifact for shared use</label>
    <Button disabled={!inspected || !attested || busy} onClick={() => {
      setBusy(true); setError(null);
      void api.elevate(request.submissionId, request.artifactSha256).then(onDone).catch((e) => setError(libraryError(e))).finally(() => setBusy(false));
    }}>Approve artifact for sharing</Button>
    {error && <p role="alert">{error}</p>}
  </article>;
}
