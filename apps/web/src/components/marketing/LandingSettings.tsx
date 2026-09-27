import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { RegistryClient } from "../../api.js";

export function LandingSettings({ client, canEdit, onSaved }: { client: RegistryClient; canEdit: boolean; onSaved: () => void }) {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [draft, setDraft] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState(0);
  const epoch = useRef(0);
  const pending = useRef(false);
  const switchRef = useRef<HTMLButtonElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!busy && restoreFocus.current) {
      restoreFocus.current = false;
      switchRef.current?.focus();
    }
  }, [busy]);
  useEffect(() => {
    const request = ++epoch.current;
    if (!canEdit) return;
    setSaved(null);
    setMessage("");
    client.getAdminSiteSettings().then((site) => {
      if (request !== epoch.current) return;
      setSaved(site.landingPageEnabled);
      setDraft(site.landingPageEnabled);
    }).catch(() => {
      if (request === epoch.current) setMessage("Couldn’t load the landing setting. Try again.");
    });
    return () => { epoch.current += 1; };
  }, [client, canEdit, retry]);

  async function save() {
    if (saved === null || saved === draft || pending.current) return;
    const request = epoch.current;
    pending.current = true;
    setBusy(true);
    setMessage("");
    try {
      const site = await client.updateAdminSiteSettings({ landingPageEnabled: draft });
      if (request !== epoch.current) return;
      setSaved(site.landingPageEnabled);
      setDraft(site.landingPageEnabled);
      setMessage("Landing setting saved.");
      restoreFocus.current = document.activeElement === saveRef.current;
      onSaved();
    } catch {
      if (request === epoch.current) setMessage("Couldn’t save the landing setting. Try again.");
    } finally {
      pending.current = false;
      if (request === epoch.current) setBusy(false);
    }
  }

  return <div className="landing-setting-content" aria-label="Landing page settings">
      {!canEdit ? <p>An MFA-verified session is required to change this setting. <a href="/settings">Manage MFA</a></p> : saved === null ? <>
        {message ? <Button type="button" variant="outline" onClick={() => setRetry((value) => value + 1)}>Retry setting</Button> : <p role="status">Loading landing setting…</p>}
      </> : <>
        <div className="landing-setting-toggle-row">
          <div><strong id="landing-setting-label">Show landing page</strong><p id="landing-setting-help">Introduce MySkills before people sign in.</p></div>
          <span className="landing-setting-switch-group"><span>{draft ? "On" : "Off"}</span><button ref={switchRef} className="landing-setting-switch" type="button" role="switch" aria-busy={busy} aria-label="Show landing page" aria-describedby="landing-setting-help" aria-checked={draft} disabled={busy} onClick={() => { setDraft(!draft); setMessage(""); }}><span /></button></span>
        </div>
        <p className="landing-setting-destination"><strong>{draft ? "Home → Landing page" : "Home → Login"}</strong>{draft !== saved && <span>Unsaved</span>}</p>
        <p className="admin-guidance">When off, signed-out visitors go straight to login. This applies to the whole instance. Registration, permissions and public skill links stay the same.</p>
        <p className="admin-guidance">Turning this off does not make this instance private. Public skill pages and the API stay reachable.</p>
        <div className="landing-setting-actions">
          <Button ref={saveRef} type="button" disabled={draft === saved} aria-disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save landing setting"}</Button>
          <Button type="button" variant="outline" disabled={busy || draft === saved} onClick={() => { setDraft(saved); setMessage(""); switchRef.current?.focus(); }}>Discard</Button>
        </div>
      </>}
      {message && <p className="safe-message" role={message.startsWith("Couldn’t") ? "alert" : "status"}>{message}</p>}
  </div>;
}
