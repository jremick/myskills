import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { githubError, type GithubAdminSettings, type GithubClient, type GithubSettingsInput } from "../../github-api.js";

const emptyDraft: GithubSettingsInput = { enabled: false, appId: "", clientId: "", installationId: null, installationEnabled: false };
const toDraft = (value: GithubAdminSettings): GithubSettingsInput => ({ enabled: value.enabled, appId: value.appId, clientId: value.clientId, installationId: value.installationId, installationEnabled: value.installationEnabled });
const statusLabel = { not_configured: "Not configured", configured: "Ready to test", connected: "GitHub App verified", error: "Connection needs attention" };

export function GithubSettings({ api, canEdit, onSaved }: { api: GithubClient; canEdit: boolean; onSaved: () => void }) {
  const [saved, setSaved] = useState<GithubAdminSettings | null>(null);
  const [draft, setDraft] = useState<GithubSettingsInput>(emptyDraft);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const epoch = useRef(0);
  const pending = useRef(false);
  const id = useId();
  const changed = saved !== null && JSON.stringify(draft) !== JSON.stringify(toDraft(saved));
  const valid = !draft.enabled || (draft.appId.trim() && draft.clientId.trim() && (draft.clientSecret?.trim() || saved?.hasClientSecret)
    && (!draft.installationEnabled || (draft.installationId?.trim() && (draft.privateKey?.trim() || saved?.hasPrivateKey))));
  useEffect(() => {
    const request = ++epoch.current;
    if (!canEdit) return;
    setSaved(null);
    api.settings().then(value => { if (request === epoch.current) { setSaved(value); setDraft(toDraft(value)); setNotice(null); } }).catch(error => { if (request === epoch.current) setNotice({ message: githubError(error), error: true }); });
    return () => { epoch.current += 1; };
  }, [api, canEdit, retry]);
  function update(value: Partial<GithubSettingsInput>) { setDraft(current => ({ ...current, ...value })); setNotice(null); }
  async function run(test: boolean) {
    if (pending.current || !saved) return;
    const request = epoch.current;
    pending.current = true; setBusy(true); setNotice(null);
    try {
      const value = test ? await api.testConnection() : await api.saveSettings({ ...draft, appId: draft.appId.trim(), clientId: draft.clientId.trim(), installationId: draft.installationId?.trim() || null,
        ...(draft.clientSecret?.trim() ? { clientSecret: draft.clientSecret.trim() } : { clientSecret: undefined }), ...(draft.privateKey?.trim() ? { privateKey: draft.privateKey.trim() } : { privateKey: undefined }) });
      if (request !== epoch.current) return;
      setSaved(value); setDraft(toDraft(value));
      setNotice({ message: test ? value.status === "connected" ? `${value.installationEnabled ? "Installation connection verified" : "GitHub App verified"}. Complete Connect through GitHub in Account settings to verify user authorization.` : value.status === "configured" ? "Configuration is ready. Connect your GitHub account to verify user authorization, or add a private key to verify the app here." : "GitHub connection could not be verified. Check the app credentials and installation." : "GitHub settings saved.", error: test && value.status === "error" });
      onSaved();
    } catch (error) { if (request === epoch.current) setNotice({ message: githubError(error), error: true }); }
    finally { pending.current = false; if (request === epoch.current) setBusy(false); }
  }

  return <div className="github-settings">
    {!canEdit ? <p>An MFA-verified admin session is required to configure GitHub. <a href="/settings">Manage MFA</a></p> : !saved ? notice?.error ? <Button type="button" variant="outline" onClick={() => setRetry(value => value + 1)}>Retry GitHub settings</Button> : <p role="status">Loading GitHub settings…</p> : <form onSubmit={event => { event.preventDefault(); void run(false); }}>
      <p className="admin-guidance">Register one GitHub App for this instance. Users can connect their GitHub accounts; an organization installation can provide shared access for public source checks.</p>
      <label className="account-field"><span id={`${id}-callback-label`}>Authorization callback URL</span><Input aria-labelledby={`${id}-callback-label`} aria-describedby={`${id}-callback-help`} readOnly value={saved.callbackUrl} /><small id={`${id}-callback-help`}>Copy this exact URL to your GitHub App’s user authorization callback setting.</small></label>
      <fieldset disabled={busy} className="github-fields">
        <label className="github-check"><input type="checkbox" checked={draft.enabled} onChange={event => update({ enabled: event.target.checked, ...(!event.target.checked ? { installationEnabled: false } : {}) })} />Enable GitHub connections</label>
        <div className="github-field-pair">
          <label className="account-field"><span>App ID</span><Input value={draft.appId} inputMode="numeric" required={draft.enabled} onChange={event => update({ appId: event.target.value })} /></label>
          <label className="account-field"><span>Client ID</span><Input value={draft.clientId} required={draft.enabled} onChange={event => update({ clientId: event.target.value })} /></label>
        </div>
        <label className="account-field"><span id={`${id}-secret-label`}>Client secret</span><Input aria-labelledby={`${id}-secret-label`} type="password" autoComplete="new-password" value={draft.clientSecret ?? ""} onChange={event => update({ clientSecret: event.target.value || undefined })} aria-describedby={`${id}-secret-help`} /><small id={`${id}-secret-help`}>{saved.hasClientSecret ? "A secret is stored. Leave blank to keep it." : "Create a client secret in your GitHub App settings."} Secrets are stored encrypted and are never displayed again.</small></label>
        <label className="github-check"><input type="checkbox" checked={draft.installationEnabled} onChange={event => update({ installationEnabled: event.target.checked })} />Use installation for shared source checks</label>
        <p className="admin-guidance">When enabled, this installation authorizes all source checks. Otherwise each source owner’s GitHub connection is used, with anonymous access when no account is connected.</p>
        <label className="account-field"><span id={`${id}-installation-label`}>Installation ID</span><Input aria-labelledby={`${id}-installation-label`} aria-describedby={`${id}-installation-help`} inputMode="numeric" value={draft.installationId ?? ""} required={draft.enabled && draft.installationEnabled} onChange={event => update({ installationId: event.target.value || null })} /><small id={`${id}-installation-help`}>Install the app on your organization. The installation ID appears in the installation settings URL.</small></label>
        <label className="account-field"><span id={`${id}-key-label`}>Private key</span><textarea aria-labelledby={`${id}-key-label`} rows={5} autoComplete="off" spellCheck={false} value={draft.privateKey ?? ""} onChange={event => update({ privateKey: event.target.value || undefined })} aria-describedby={`${id}-key-help`} /><small id={`${id}-key-help`}>{saved.hasPrivateKey ? "A key is stored. Leave blank to keep it." : "Paste the PEM private key generated for your GitHub App."} Required for installation checks. It also lets Test connection verify the app without connecting a user.</small></label>
      </fieldset>
      <p className="admin-guidance">Grant repository Contents: read-only and Metadata: read-only. Enable expiring user access tokens. MySkills continues to accept public repositories only.</p>
      <div className="github-health"><strong>{saved.status === "connected" && saved.installationEnabled ? "Installation connection verified" : statusLabel[saved.status]}</strong>{saved.lastCheckedAt && <span>Last tested {new Date(saved.lastCheckedAt).toLocaleString()}</span>}</div>
      <p className="admin-guidance">Saving these settings requires connected users to reconnect to GitHub.</p>
      <div className="account-actions">
        <Button type="submit" disabled={busy || !changed || !valid}>{busy ? "Working…" : "Save GitHub settings"}</Button>
        <Button type="button" variant="outline" disabled={busy || changed || !saved.enabled} onClick={() => void run(true)}>Test connection</Button>
        <Button type="button" variant="ghost" disabled={busy || !changed} onClick={() => { setDraft(toDraft(saved)); setNotice(null); }}>Discard</Button>
      </div>
    </form>}
    {notice && <p className="account-notice" data-tone={notice.error ? "danger" : "teal"} role={notice.error ? "alert" : "status"}>{notice.message}</p>}
  </div>;
}
