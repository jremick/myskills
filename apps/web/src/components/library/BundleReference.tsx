import type { LibraryEntry } from "@myskills-app/core";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * A saved bundle is only a reference: no adoption, install or follow state.
 * When access is lost the server withholds metadata, so nothing cached is shown.
 */
export function BundleReference({ entry }: { entry: LibraryEntry }) {
  const reference = entry.bundle;
  if (!reference || reference.state !== "available") {
    return (
      <div className="bundle-reference">
        <p className="bundle-muted">You no longer have access to this bundle, or it was removed. The reference stays until you remove it, and nothing else in this library changed.</p>
      </div>
    );
  }
  const changed = reference.revision !== null && reference.revision !== reference.revisionSaved;
  return (
    <div className="bundle-reference">
      <p className="bundle-reference-facts">
        <span>Bundle reference</span>
        {reference.memberCount !== null && <span>{plural(reference.memberCount, "skill")}</span>}
        <span>{changed ? `Saved at revision ${reference.revisionSaved} · now revision ${reference.revision}` : `Saved at revision ${reference.revisionSaved}`}</span>
        {changed && <span className="bundle-reference-changed">Updated since you saved</span>}
      </p>
      <p className="bundle-muted">Saving a bundle keeps a reference. It doesn’t adopt, install or follow updates to its skills.</p>
      <a href={`/registry?bundle=${encodeURIComponent(reference.id)}`}>Open in registry</a>
    </div>
  );
}
