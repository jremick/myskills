import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { safeReviewErrorMessage, type RegistryClient, type ReviewSubmissionDetail, type UserSubmissionDetail } from "../../api.js";
import { reviewEventLabel } from "./status-display.js";
import { ScanRunEvidence } from "./ScanRunEvidence.js";

export function SubmissionEvidencePanel({ client, submissionId, mode, onCorrect, focusOnOpen, onClose }: {
  client: RegistryClient;
  submissionId: string;
  mode: "author" | "reviewer";
  onCorrect?: () => void;
  /** Move focus to the panel heading when it opens. */
  focusOnOpen?: boolean;
  /** Renders "Close feedback"; the caller returns focus to its trigger. */
  onClose?: () => void;
}) {
  const [detail, setDetail] = useState<UserSubmissionDetail | ReviewSubmissionDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (focusOnOpen) headingRef.current?.focus(); }, []);
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
  const teamOwned = detail && "owner" in detail && detail.owner?.type === "team";
  const title = mode === "author" ? "Submission feedback" : "Review evidence";
  return <section className="control-plane-section submission-evidence" aria-label={title}>
    <div className="control-plane-section-heading">
      <h3 ref={headingRef} tabIndex={-1}>{title}</h3>
      <div className="submission-evidence-actions">
        <Button type="button" size="sm" variant="outline" onClick={() => setRefresh((value) => value + 1)}>Refresh evidence</Button>
        {onClose && <Button type="button" size="sm" variant="ghost" onClick={onClose}>Close feedback</Button>}
      </div>
    </div>
    {state === "loading" && <p role="status">Loading review and scan history…</p>}
    {message && <p role="alert">{message}</p>}
    {detail && <>
      {detail.changeRequestReason && <div className="control-plane-inline-message"><strong>Requested changes</strong><p>{detail.changeRequestReason}</p></div>}
      {correction && ["changes-requested", "rejected"].includes(detail.reviewStatus) && <div className="control-plane-section submission-correction"><h4>Submit a corrected version</h4>{teamOwned ? <><p>Review the corrected upstream source in Libraries, then submit a new candidate. Submitting requires an author role. The previous artifact and review history remain unchanged.</p><a href="/libraries">Open Libraries</a></> : <><p>Update the package locally, give it a new semantic version in its manifest, and upload the new archive. The previous artifact and review history remain unchanged.</p>{correction.canSubmitNewVersion && onCorrect ? <Button type="button" size="sm" onClick={onCorrect}>Choose corrected package</Button> : <p>Author permission is required to submit the correction. Ask the instance administrator if your access has changed.</p>}</>}</div>}
      <h4>Review history</h4>
      {detail.reviewHistory.length === 0 ? <p>No review decisions have been recorded.</p> : <ol>{detail.reviewHistory.map((event, index) => <li key={`${event.createdAt}:${event.action}:${index}`}><strong>{reviewEventLabel(event.action)}</strong> · <time dateTime={event.createdAt}>{displayDate(event.createdAt)}</time><p>{event.reason || "No reason was supplied."}</p></li>)}</ol>}
      <h4>Scan history</h4>
      {detail.scanRuns.length === 0 ? <p>No scan evidence has been recorded.</p> : detail.scanRuns.map((run) => <ScanRunEvidence key={run.id} run={run} />)}
    </>}
  </section>;
}

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleString();
}
