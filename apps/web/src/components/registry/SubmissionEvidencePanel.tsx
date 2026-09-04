import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { safeReviewErrorMessage, type RegistryClient, type ReviewSubmissionDetail, type UserSubmissionDetail } from "../../api.js";

export function SubmissionEvidencePanel({ client, submissionId, mode, onCorrect }: {
  client: RegistryClient;
  submissionId: string;
  mode: "author" | "reviewer";
  onCorrect?: () => void;
}) {
  const [detail, setDetail] = useState<UserSubmissionDetail | ReviewSubmissionDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setState("loading");
    setDetail(null);
    setMessage(null);
    const request = mode === "author" ? client.getUserSubmissionDetail?.(submissionId) : client.getReviewSubmissionDetail?.(submissionId);
    if (!request) {
      setState("error");
      setMessage("Submission evidence is unavailable in this workspace.");
      return;
    }
    void request.then((result) => {
      if (!active) return;
      setDetail(result);
      setState("ready");
    }).catch((error: unknown) => {
      if (!active) return;
      setState("error");
      setMessage(safeReviewErrorMessage(error));
    });
    return () => { active = false; };
  }, [client, mode, refresh, submissionId]);

  const correction = detail && "correction" in detail ? detail.correction : null;
  return <section className="control-plane-section submission-evidence" aria-label={mode === "author" ? "Submission feedback" : "Review evidence"}>
    <div className="control-plane-section-heading"><h2>{mode === "author" ? "Submission feedback" : "Review evidence"}</h2><Button type="button" size="sm" variant="outline" onClick={() => setRefresh((value) => value + 1)}>Refresh evidence</Button></div>
    {state === "loading" && <p role="status">Loading review and scan history…</p>}
    {message && <p role="alert">{message}</p>}
    {detail && <>
      <p>{detail.slug}@{detail.version} · {detail.reviewStatus}</p>
      {detail.changeRequestReason && <div className="control-plane-inline-message"><strong>Requested changes</strong><p>{detail.changeRequestReason}</p></div>}
      {correction && ["changes-requested", "rejected"].includes(detail.reviewStatus) && <div className="control-plane-section"><h3>Submit a corrected version</h3><p>Update the package locally, give it a new semantic version in its manifest, and upload the new archive. The previous artifact and review history remain unchanged.</p>{correction.canSubmitNewVersion && onCorrect ? <Button type="button" size="sm" onClick={onCorrect}>Choose corrected package</Button> : <p>Author permission is required to submit the correction. Ask the instance administrator if your access has changed.</p>}</div>}
      <h3>Review history</h3>
      {detail.reviewHistory.length === 0 ? <p>No review decisions have been recorded.</p> : <ol>{detail.reviewHistory.map((event, index) => <li key={`${event.createdAt}:${event.action}:${index}`}><strong>{event.action.replaceAll("-", " ")}</strong> · <time dateTime={event.createdAt}>{displayDate(event.createdAt)}</time><p>{event.reason || "No reason was supplied."}</p></li>)}</ol>}
      <h3>Scan history</h3>
      {detail.scanRuns.length === 0 ? <p>No scan evidence has been recorded.</p> : detail.scanRuns.map((run) => <article className="control-plane-section" key={run.id}><p><Badge variant="outline">{run.status}</Badge> · <time dateTime={run.createdAt}>{displayDate(run.createdAt)}</time></p>{run.findings.length === 0 ? <p>No findings were recorded for this scan.</p> : <ul>{run.findings.map((finding, index) => <li key={`${finding.category}:${finding.path}:${index}`}><strong>{finding.severity}: {finding.category}</strong>{finding.path && <span> · {finding.path}</span>}<p>{finding.message}</p></li>)}</ul>}</article>)}
    </>}
  </section>;
}

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleString();
}
