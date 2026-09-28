import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { githubError, type GithubClient, type GithubAccountConnection as Connection } from "../../github-api.js";

export function GithubAccountConnection({ api }: { api: GithubClient }) {
  const headingId = useId();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(() => {
    const result = new URLSearchParams(window.location.search).get("github");
    return result === "error" ? { message: "GitHub connection could not be completed. Try connecting again.", error: true }
      : result === "connected" ? { message: "GitHub account connected.", error: false } : null;
  });
  const epoch = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("github")) { url.searchParams.delete("github"); window.history.replaceState(window.history.state, "", url); }
  }, []);
  useEffect(() => {
    const request = ++epoch.current;
    setConnection(null);
    api.account().then(value => { if (request === epoch.current) setConnection(value); }).catch(error => { if (request === epoch.current) setNotice({ message: githubError(error), error: true }); });
    return () => { epoch.current += 1; };
  }, [api, retry]);

  async function act(action: "connect" | "disconnect") {
    if (pending.current) return;
    const request = epoch.current;
    pending.current = true; setBusy(true); setNotice(null);
    try {
      if (action === "connect") {
        const { authorizationUrl } = await api.connect();
        const url = new URL(authorizationUrl);
        if (url.origin !== "https://github.com" || url.pathname !== "/login/oauth/authorize") throw new Error("Invalid authorization URL");
        if (request === epoch.current) window.location.assign(url.href);
      } else {
        const value = await api.disconnect();
        if (request === epoch.current) { setConnection(value); setNotice({ message: "GitHub disconnected.", error: false }); }
      }
    } catch (error) { if (request === epoch.current) setNotice({ message: githubError(error), error: true }); }
    finally { pending.current = false; if (request === epoch.current) setBusy(false); }
  }

  return <section className="account-row" aria-labelledby={headingId}>
    <div className="account-row-intro"><h2 id={headingId}>GitHub connection</h2><p>Authorize public source checks. Your MySkills sign-in stays the same.</p></div>
    <div className="account-row-body">
      {!connection ? notice?.error ? <Button type="button" variant="outline" onClick={() => { setNotice(null); setRetry(value => value + 1); }}>Retry GitHub connection</Button> : <p role="status">Loading GitHub connection…</p> : <>
        <p><strong>{connection.status === "connected" ? `Connected as ${connection.login}` : connection.status === "reconnect_required" ? `Reconnect ${connection.login ?? "your GitHub account"}` : "No GitHub account connected"}</strong></p>
        <p className="admin-guidance">{connection.credentialSource === "installation" ? "Organization installation: this instance uses its shared GitHub App for source checks." : connection.credentialSource === "user" ? "Your GitHub account authorizes your source checks, including scheduled checks." : "Source checks currently use GitHub’s shared anonymous allowance."}</p>
        {connection.status === "reconnect_required" && <p className="account-notice" data-tone="danger">GitHub access expired or was revoked. Reconnect to resume authenticated checks.</p>}
        {!connection.available && <p className="admin-guidance">Ask your instance administrator to configure the GitHub App to enable connections.</p>}
        <div className="account-actions">
          <Button type="button" size="sm" disabled={busy || !connection.available} onClick={() => void act("connect")}>{busy ? "Working…" : connection.status === "disconnected" ? "Connect through GitHub" : "Reconnect GitHub"}</Button>
          {connection.status !== "disconnected" && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void act("disconnect")}>Disconnect GitHub</Button>}
        </div>
      </>}
      {notice && <p className="account-notice" data-tone={notice.error ? "danger" : "teal"} role={notice.error ? "alert" : "status"}>{notice.message}</p>}
    </div>
  </section>;
}
