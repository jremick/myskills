import { useState } from "react";
import type { DeviceConsent, DeviceLoginClient } from "../device-login-api.js";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function DeviceAuthorizePage({ client, signedIn, onSignIn }: { client?: DeviceLoginClient; signedIn: boolean; onSignIn: () => void }) {
  const [code, setCode] = useState("");
  const [consent, setConsent] = useState<DeviceConsent | null>(null);
  const [reviewedCode, setReviewedCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  async function inspect() {
    if (!client || pending) return;
    setPending(true); setError(null);
    try { const details = await client.inspect(code); setConsent(details); setReviewedCode(code); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not review this code."); }
    finally { setPending(false); }
  }
  async function decide(decision: "approve" | "deny") {
    if (!client || !consent || pending) return;
    setPending(true); setError(null);
    try { const result = await client.decide(reviewedCode, decision); setStatus(`CLI access ${result.status}. Return to the terminal.`); setConsent(null); setCode(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save your decision."); }
    finally { setPending(false); }
  }
  return <main className="login-page" id="main-content"><section className="login-panel device-panel" aria-labelledby="device-heading">
    <h1 id="device-heading">Authorize CLI access</h1>
    <p>Only approve a code shown by a CLI login you started. Never enter a code sent by someone else.</p>
    {!signedIn ? <Button onClick={onSignIn}>Sign in</Button> : !client ? <p role="alert">Browser login is unavailable.</p> : <>
      {error && <p role="alert">{error}</p>}
      {status ? <p role="status">{status}</p> : consent ? <>
        <p>Device code: <strong>{reviewedCode}</strong></p>
        <p>The CLI requests these permissions:</p><ul>{consent.scopes.map((scope) => <li key={scope}><code>{scope}</code></li>)}</ul>
        <p>Request expires: {new Date(consent.expiresAt).toLocaleString()}</p>
        {consent.mfaRequired && <p>These permissions require a recent MFA sign-in.</p>}
        <div className="device-actions">
          <Button disabled={pending} onClick={() => void decide("approve")}>Approve CLI access</Button>
          <Button disabled={pending} variant="outline" onClick={() => void decide("deny")}>Deny</Button>
        </div>
      </> : <form className="auth-widget auth-form" onSubmit={(event) => { event.preventDefault(); void inspect(); }}>
        <label className="auth-field" htmlFor="device-code">
          <span>Device code</span>
          <Input className="auth-input" id="device-code" value={code} onChange={(event) => setCode(event.target.value)} maxLength={32} autoComplete="off" autoCapitalize="characters" required />
        </label>
        <Button type="submit" disabled={pending || !code.trim()}>Review permissions</Button>
      </form>}
    </>}
  </section></main>;
}
