import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_OPERATOR_RECEIPT_BYTES, OPERATOR_IMAGE_NAMES, parseOperatorReceipt, snapshotAge, type OperatorImageName, type OperatorStatusReceipt } from "./operator-receipt.js";
import "./operations.css";

const imageLabels: Record<OperatorImageName, string> = { api: "API", web: "Web", mcp: "MCP", ops: "Operations tool", minio: "Object storage", postgres: "Postgres" };
const healthLabels = { healthy: "Healthy", unhealthy: "Unhealthy", unavailable: "Unavailable", disabled: "Disabled", tool: "Local tool" };
const backupLabels = { current: "Current", stale: "Stale", missing: "Missing", error: "Error", "not-configured": "Not configured" };
const statusCommands = "./myskills.sh status --json --config-dir '/absolute/private/config'";
const backupCommands = [
  "./myskills.sh backup config --config-dir '/absolute/private/config'",
  "./myskills.sh backup status --config-dir '/absolute/private/config'",
  "./myskills.sh backup execute --config-dir '/absolute/private/config'",
].join("\n");
const restoreCommands = [
  "./myskills.sh recover plan --config-dir '/absolute/private/config'",
  "./myskills.sh recover execute 'RUN_ID' --target-env-file '/absolute/protected/restore.env' --config-dir '/absolute/private/config'",
].join("\n");

export function RecoveryGuidancePanel({ isAdministrator }: { isAdministrator: boolean }) {
  return isAdministrator ? <RecoveryGuidanceContent /> : null;
}

function RecoveryGuidanceContent() {
  const [receipt, setReceipt] = useState<OperatorStatusReceipt | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const requestToken = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const fieldId = useId();

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => { requestToken.current += 1; window.clearInterval(timer); };
  }, []);

  function clearReceipt() {
    requestToken.current += 1;
    setReceipt(null);
    setMessage(null);
    setReading(false);
    if (input.current) input.current.value = "";
  }

  async function chooseReceipt(file: File | undefined) {
    if (!file) return;
    const request = ++requestToken.current;
    setReceipt(null);
    setMessage(null);
    setReading(false);
    if (input.current) input.current.value = "";
    if (file.size > MAX_OPERATOR_RECEIPT_BYTES) {
      setMessage("Receipt rejected. Choose a JSON receipt of 64 KiB or less.");
      return;
    }
    setReading(true);
    try {
      const parsed = parseOperatorReceipt(await file.text());
      if (request !== requestToken.current) return;
      setNow(Date.now());
      if (parsed.ok) setReceipt(parsed.receipt);
      else setMessage(parsed.message);
    } catch {
      if (request === requestToken.current) setMessage("Receipt rejected. The file could not be read. Choose the sanitized JSON from ./myskills.sh status --json.");
    } finally {
      if (request === requestToken.current) setReading(false);
    }
  }

  const age = receipt ? snapshotAge(receipt.capturedAt, now) : null;
  const readyInSnapshot = receipt && (["api", "web", "minio", "postgres"] as const).every(name => receipt.images[name].health === "healthy" && receipt.images[name].actualRef === receipt.images[name].expectedRef)
    && (receipt.images.mcp.health === "disabled" || (receipt.images.mcp.health === "healthy" && receipt.images.mcp.actualRef === receipt.images.mcp.expectedRef));
  const backupAge = receipt?.backup.capturedAt ? snapshotAge(receipt.backup.capturedAt, now) : null;
  const backupClockMismatch = age === "future" || backupAge === "future" || Boolean(receipt?.backup.capturedAt && Date.parse(receipt.backup.capturedAt) > Date.parse(receipt.capturedAt));
  const backupKnown = receipt?.backup.state === "current" || receipt?.backup.state === "stale";
  const backupFreshness = backupClockMismatch ? "Backup freshness unknown"
    : !backupKnown || !backupAge ? "No current backup evidence"
      : age === "stale" || backupAge === "stale" ? "Outside 26-hour backup window" : "Within 26-hour backup window";

  return <div className="recovery-guidance">
    <div className="account-panel-head"><div><h2>Recovery guidance</h2><p>Review a local operator snapshot, then perform backups and isolated restore checks on the host.</p></div></div>
    <p className="account-callout">The browser cannot inspect or control the host. Imported receipts are offline snapshots, kept in this panel only. They do not prove a live deployment or a completed recovery.</p>
    <section className="recovery-section" aria-label="Import operator status">
      <h3>Import a sanitized status receipt</h3>
      <p>From the versioned release bundle on the host, replace the quoted directory placeholder with your private configuration directory. Save only the JSON status output to a local file.</p>
      <pre aria-label="Status receipt command"><code>{statusCommands}</code></pre>
      <label className="account-field"><span id={`${fieldId}-label`}>Operator status receipt</span><Input ref={input} type="file" accept="application/json,.json" aria-labelledby={`${fieldId}-label`} aria-describedby={`${fieldId}-help`} onChange={event => void chooseReceipt(event.target.files?.[0])} />
        <small id={`${fieldId}-help`}>JSON · 64 KiB maximum · documented status fields only. Do not select environment files, backup configuration, or credentials. The receipt is never uploaded or saved by this panel.</small>
      </label>
      {(receipt || reading || message) ? <Button type="button" variant="outline" size="sm" onClick={clearReceipt}>Clear imported receipt</Button> : <p className="recovery-muted">No receipt imported.</p>}
      {reading ? <p role="status">Reading receipt…</p> : null}
      {message ? <p className="account-notice" data-tone="danger" role="alert">{message}</p> : null}
    </section>
    {receipt ? <section className="recovery-section" aria-label="Imported operator snapshot">
      <div className="account-panel-head"><h3>Offline snapshot</h3><span className="recovery-status" data-tone={age === "recent" ? "neutral" : "amber"}>{age === "future" ? "Clock mismatch" : age === "stale" ? "Stale snapshot" : "Recent snapshot"}</span></div>
      <p>Captured at <time dateTime={receipt.capturedAt}>{receipt.capturedAt}</time>. Refresh the host status and import a new receipt before making operational decisions.</p>
      {age === "future" ? <p className="account-notice" data-tone="amber">This capture time is in the future. Check the host and browser clocks. Current readiness and backup freshness are unknown.</p>
        : age === "stale" ? <p className="account-notice" data-tone="amber">This snapshot is more than 26 hours old. Current readiness and backup freshness cannot be confirmed from it.</p> : null}
      <section aria-label="Source snapshot" className="recovery-snapshot-block"><h4>Source</h4><dl className="recovery-facts"><div><dt>Version</dt><dd><code>{receipt.source.version}</code></dd></div><div><dt>Commit</dt><dd><code>{receipt.source.commit}</code></dd></div></dl><p className="recovery-muted">Reported bundle source; this import does not verify image provenance.</p></section>
      <section aria-label="Readiness snapshot" className="recovery-snapshot-block"><h4>Readiness</h4><p><strong>{age !== "recent" ? "Current readiness unknown" : readyInSnapshot ? "Services matched and reported healthy in this snapshot" : "Needs attention in this snapshot"}</strong></p><p className="recovery-muted">Expected and observed image references and health are host observations at the capture time. The operations image is a local tool; a disabled MCP service is optional.</p></section>
      <div className="recovery-image-scroll" tabIndex={0} role="region" aria-label="Image references, scroll horizontally if needed"><table className="recovery-images" aria-label="Image snapshot"><thead><tr><th scope="col">Service</th><th scope="col">Expected image</th><th scope="col">Observed image</th><th scope="col">Reported health</th></tr></thead><tbody>{OPERATOR_IMAGE_NAMES.map(name => <tr key={name}><th scope="row">{imageLabels[name]}</th><td><code>{receipt.images[name].expectedRef}</code></td><td>{receipt.images[name].actualRef ? <code>{receipt.images[name].actualRef}</code> : <span className="recovery-muted">Not observed</span>}{receipt.images[name].actualRef && receipt.images[name].actualRef !== receipt.images[name].expectedRef ? <span className="recovery-mismatch">Image mismatch</span> : null}</td><td>{healthLabels[receipt.images[name].health]}</td></tr>)}</tbody></table></div>
      <section aria-label="Backup snapshot" className="recovery-snapshot-block"><h4>Backup freshness</h4><p><strong>{backupFreshness}</strong></p><p>Helper reported: {backupLabels[receipt.backup.state]}</p><dl className="recovery-facts"><div><dt>Backup captured at</dt><dd>{receipt.backup.capturedAt ? <time dateTime={receipt.backup.capturedAt}>{receipt.backup.capturedAt}</time> : "No timestamp"}</dd></div><div><dt>Run ID</dt><dd>{receipt.backup.runId ? <code>{receipt.backup.runId}</code> : "No run"}</dd></div></dl><p className="recovery-muted">The 26-hour window is calculated from the timestamps and this browser's clock. A current backup report does not prove a successful restore.</p></section>
    </section> : null}
    <section className="recovery-section" aria-label="Backup handoff"><h3>Prepare and run a backup on the host</h3><ol><li>Prepare the protected <code>backup.env</code> on the host. Verify its namespace against the database's actual instance ID. Keep database and object-storage credentials in that protected file.</li><li>Validate the existing configuration with <code>backup config</code>, then check backup status. The configuration check does not prove durable storage or a completed backup. Execute a backup when the configured destination is ready.</li><li>Check status again, save the sanitized status receipt, and import it here. Keep the full backup artifacts and manifests in the protected backup destination.</li></ol><pre aria-label="Backup commands"><code>{backupCommands}</code></pre></section>
    <section className="recovery-section" aria-label="Isolated restore handoff"><h3>Rehearse an isolated restore</h3><ol><li>Run the recovery plan on the Linux host for its local safety guidance. Review the backup run ID and manifest separately in the protected backup destination.</li><li>Prepare a protected target environment file for a new empty loopback Postgres database and a new empty object-storage bucket. Use an isolated target with its own credentials.</li><li>Replace <code>RUN_ID</code> with the exact reviewed run ID from the backup manifest and use the protected target file. Review the helper's checks before executing.</li><li>Verify the restored instance separately: Owner sign-in, MFA, revoked access, and artifact delivery. Record the result before treating recovery as complete.</li></ol><pre aria-label="Isolated restore commands"><code>{restoreCommands}</code></pre><p className="account-notice" data-tone="amber">These are local helper handoffs. The browser does not run a restore, downgrade images, or confirm recovery completion.</p></section>
  </div>;
}
