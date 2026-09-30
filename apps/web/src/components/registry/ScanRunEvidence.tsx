import type { SubmissionEvidence } from "../../api.js";
import { chipTone, securityStatusLabel, severityLabel } from "./status-display.js";
import "./scan-evidence.css";

const failures: Record<string, string> = {
  lease_expired: "The worker lease expired. A later attempt can retry this scan.",
  artifact_unavailable: "The stored package was unavailable. The worker retries within its attempt limit.",
  artifact_integrity: "The stored package did not match the submitted artifact. Approval is blocked.",
  invalid_package: "The stored package failed validation. Approval is blocked.",
  runner_incompatible: "This scan requires a different runner version.",
  version_inactive: "This version is no longer available for review.",
  scan_error: "The scan could not complete. The worker retries within its attempt limit.",
};

export function ScanRunEvidence({ run }: { run: SubmissionEvidence["scanRuns"][number] }) {
  const scan = securityStatusLabel(run.status);
  const pending = run.status === "queued" || run.status === "running";
  const failure = run.failureCode ? failures[run.failureCode] ?? "The scan could not complete." : null;
  return <article className="control-plane-section submission-scan">
    <p><span className="registry-chip" data-tone={chipTone(scan.tone)}>{scan.label}</span> · <time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString()}</time></p>
    {run.attempt && <p>Attempt {run.attempt}</p>}
    {run.runnerVersion && <p>Runner <code>{run.runnerVersion}</code></p>}
    {run.artifactSha256 && <p>Artifact <code>{run.artifactSha256}</code></p>}
    {failure && <p>{failure}</p>}
    {pending && <p role="status">{run.status === "queued" ? "Scan queued. Approval waits for its result." : "Scan in progress. Refresh evidence to check its result."}</p>}
    {run.findings.length === 0 ? !pending && !failure && <p>No findings were recorded for this completed scan.</p> : <ul>{run.findings.map((finding, index) => <li key={`${finding.category}:${finding.path}:${index}`}><strong>{severityLabel(finding.severity).label}: {finding.category}</strong>{finding.path && <span> · <code>{finding.path}</code></span>}<p>{finding.message}</p></li>)}</ul>}
  </article>;
}
