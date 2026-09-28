import { useEffect, useId, useRef, useState } from "react";
import { DEFAULT_BRANDING, MAX_BRAND_LOGO_BYTES, MAX_BRAND_TEXT_LENGTH, type BrandSettings } from "@myskills-app/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RegistryClient } from "../../api.js";
import { BrandIdentity } from "./BrandIdentity.js";
import { useBranding } from "./branding-context.js";

export function BrandingSettings({ client, canEdit, onSaved }: { client: RegistryClient; canEdit: boolean; onSaved: () => void }) {
  const { saveBranding } = useBranding();
  const [saved, setSaved] = useState<BrandSettings | null>(null);
  const [draft, setDraft] = useState<BrandSettings>(DEFAULT_BRANDING);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [retry, setRetry] = useState(0);
  const epoch = useRef(0);
  const fileEpoch = useRef(0);
  const pending = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  const changed = saved !== null && (draft.text !== saved.text || draft.showText !== saved.showText || draft.logoDataUrl !== saved.logoDataUrl);
  function notice(text: string, isError = false) { setMessage(text); setError(isError); }
  useEffect(() => {
    const request = ++epoch.current;
    if (!canEdit) return;
    setSaved(null);
    client.getAdminBranding().then(next => {
      if (request !== epoch.current) return;
      setSaved(next); setDraft(next); setMessage("");
    }).catch(() => { if (request === epoch.current) { setMessage("Couldn’t load branding. Try again."); setError(true); } });
    return () => { epoch.current += 1; fileEpoch.current += 1; };
  }, [client, canEdit, retry]);

  function replaceDraft(next: BrandSettings) {
    fileEpoch.current += 1;
    setReading(false);
    setDraft(next);
    if (fileInput.current) fileInput.current.value = "";
    notice("");
  }

  async function chooseLogo(file: File | undefined) {
    if (!file) return;
    const request = ++fileEpoch.current;
    setReading(false);
    if (fileInput.current) fileInput.current.value = "";
    notice("");
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { notice("Choose a PNG, JPEG or WebP image.", true); return; }
    if (file.size > MAX_BRAND_LOGO_BYTES) { notice("Choose an image of 256 KB or less.", true); return; }
    setReading(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Invalid image"));
        reader.onerror = () => reject(new Error("Unreadable image"));
        reader.readAsDataURL(file);
      });
      const image = new Image();
      image.src = data;
      await image.decode();
      if (request !== fileEpoch.current) return;
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 2048 || image.naturalHeight > 2048) {
        notice("Choose an image no larger than 2048 × 2048 pixels.", true);
        return;
      }
      setDraft(current => ({ ...current, logoDataUrl: data }));
    } catch { if (request === fileEpoch.current) notice("Couldn’t read this image. Choose a valid PNG, JPEG or WebP file.", true); }
    finally { if (request === fileEpoch.current) setReading(false); }
  }

  async function save() {
    if (!changed || !draft.text.trim() || reading || pending.current) return;
    const request = epoch.current;
    pending.current = true; setBusy(true); notice("");
    try {
      const next = await client.updateAdminBranding(draft);
      saveBranding(next);
      if (request !== epoch.current) return;
      setSaved(next); setDraft(next); notice("Branding saved.");
      if (fileInput.current) fileInput.current.value = "";
      onSaved();
    } catch (error) {
      if (request === epoch.current) notice(error instanceof Error && "code" in error && error.code === "INVALID_BRANDING"
        ? error.message : "Couldn’t save branding. Your changes are still here. Try again.", true);
    }
    finally { pending.current = false; if (request === epoch.current) setBusy(false); }
  }

  return <div className="branding-settings">
    {!canEdit ? <p>An MFA-verified session is required to change branding. <a href="/settings">Manage MFA</a></p> : saved === null ? <>
      {message ? <Button type="button" variant="outline" onClick={() => setRetry(value => value + 1)}>Retry branding</Button> : <p role="status">Loading branding…</p>}
    </> : <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy || reading} className="branding-fields">
        <label className="account-field"><span id={`${fieldId}-text-label`}>Brand text</span><Input aria-labelledby={`${fieldId}-text-label`} aria-describedby={`${fieldId}-text-help`} value={draft.text} maxLength={MAX_BRAND_TEXT_LENGTH} required onChange={event => { setDraft({ ...draft, text: event.target.value }); notice(""); }} />
          <small id={`${fieldId}-text-help`}>Up to 80 characters. Also used as the accessible name for your logo.</small>
        </label>
        <label className="account-field"><span id={`${fieldId}-logo-label`}>Logo image</span><Input aria-labelledby={`${fieldId}-logo-label`} aria-describedby={`${fieldId}-logo-help`} ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={event => void chooseLogo(event.target.files?.[0])} />
          <small id={`${fieldId}-logo-help`}>Still PNG, JPEG or WebP · 256 KB maximum · up to 2048 × 2048 pixels. Transparent backgrounds work well.</small>
        </label>
        {draft.logoDataUrl && <Button className="branding-remove" type="button" variant="outline" onClick={() => replaceDraft({ ...draft, logoDataUrl: null })}>Remove custom logo</Button>}
        <label className="branding-checkbox"><input type="checkbox" checked={draft.showText} onChange={event => { setDraft({ ...draft, showText: event.target.checked }); notice(""); }} />Show brand text</label>
        <p className="admin-guidance">Turn off the text if your image already includes lettering. Removing a custom logo restores the MySkills mark.</p>
      </fieldset>
      <section className="branding-preview" aria-label="Brand preview"><span className="branding-preview-label">Preview{changed ? " · Unsaved" : ""}</span><BrandIdentity value={{ ...draft, text: draft.text.trim() || "Brand text" }} /></section>
      <div className="account-actions">
        <Button type="submit" disabled={!changed || !draft.text.trim() || reading} aria-disabled={busy}>{busy ? "Saving…" : "Save branding"}</Button>
        <Button type="button" variant="outline" disabled={busy || (!changed && !reading)} onClick={() => replaceDraft(saved)}>Discard</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => replaceDraft({ ...DEFAULT_BRANDING })}>Restore MySkills defaults</Button>
      </div>
    </form>}
    {reading && <p role="status">Reading image…</p>}
    {message && <p className="safe-message" role={error ? "alert" : "status"}>{message}</p>}
  </div>;
}
