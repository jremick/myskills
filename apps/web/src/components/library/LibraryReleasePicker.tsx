import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RegistryClient, SafeApiError, SkillReleaseSummary } from "../../api.js";
import { shortDate } from "./library-display.js";

export type AdoptableRelease = SkillReleaseSummary & { artifact: NonNullable<SkillReleaseSummary["artifact"]> };

/**
 * Filters release state after the parent skill passes the readable-skill API.
 * Private self-reviewed and team-readability decisions stay with the adoption
 * endpoint, which also rechecks availability when the user confirms.
 */
function isAdoptable(release: SkillReleaseSummary): release is AdoptableRelease {
  return Boolean(release.publishedAt && release.artifact?.sha256)
    && release.reviewStatus === "approved"
    && release.securityStatus === "passed"
    && (release.lifecycleStatus === "approved" || release.lifecycleStatus === "deprecated");
}

const optionLabel = (release: AdoptableRelease, current: boolean) => {
  const state = release.lifecycleStatus === "deprecated" ? "Deprecated" : shortDate(release.publishedAt) ? `Published ${shortDate(release.publishedAt)}` : "Published";
  return `${release.version} · ${state}${current ? " · Adopted" : ""}`;
};

/** Chooses one released version of the entry's exact skill from the release list. */
export function LibraryReleasePicker({ client, slug, currentVersion, busy, primary, onAdopt }: {
  client: RegistryClient;
  slug: string;
  currentVersion: string | null;
  busy: boolean;
  primary: boolean;
  onAdopt: (release: AdoptableRelease, reason: string) => Promise<boolean>;
}) {
  const [releases, setReleases] = useState<AdoptableRelease[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [reload, setReload] = useState(0);
  const [version, setVersion] = useState("");
  const [note, setNote] = useState("");
  const selectId = useId();

  useEffect(() => {
    let active = true;
    setStatus("loading");
    setReleases([]);
    // Managers can list published releases of an archived parent. Check the
    // reader endpoint first; management history alone cannot grant adoption.
    void client.getSkill(slug).then((skill) => {
      if (!active || !["approved", "deprecated"].includes(skill.lifecycleStatus)) return [];
      // The release list is not paginated; the whole array is read and filtered.
      return client.listSkillReleases(slug);
    }).then((list) => {
      if (!active) return;
      setReleases(list.filter(isAdoptable).filter((release) => release.slug === slug));
      setStatus("ready");
    }).catch((error: unknown) => {
      if (!active) return;
      const status = (error as Partial<SafeApiError> | null)?.status;
      setStatus(status === 403 || status === 404 ? "ready" : "error");
    });
    return () => { active = false; };
  }, [client, slug, reload]);

  const chosen = status === "ready" ? releases.find((release) => release.version === version && release.version !== currentVersion) ?? null : null;
  const submit = useCallback(async () => {
    if (!chosen || busy) return;
    if (await onAdopt(chosen, note.trim())) { setVersion(""); setNote(""); }
  }, [busy, chosen, note, onAdopt]);

  return <form className="library-form library-release-picker" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <div className="library-field">
      <label htmlFor={selectId}>Reviewed release</label>
      <select id={selectId} value={version} disabled={busy || status !== "ready" || releases.length === 0} onChange={(event) => setVersion(event.target.value)}>
        <option value="">Choose a release</option>
        {releases.map((release) => <option key={release.id} value={release.version} disabled={release.version === currentVersion}>{optionLabel(release, release.version === currentVersion)}</option>)}
      </select>
    </div>
    {status === "loading" && <p role="status" className="library-muted">Loading releases…</p>}
    {status === "error" && <div role="alert" className="library-alert library-actions">
      <span>Releases couldn’t load.</span>
      <Button type="button" size="sm" variant="outline" onClick={() => setReload((value) => value + 1)}>Retry releases</Button>
    </div>}
    {status === "ready" && releases.length === 0 && <p className="library-muted">No approved, published release is available to adopt.</p>}
    <label className="library-field"><span>Curator note (optional)</span><Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} /></label>
    <div className="library-form-actions"><Button size="sm" variant={primary ? "default" : "outline"} disabled={busy || !chosen}>Adopt skill release</Button></div>
  </form>;
}
