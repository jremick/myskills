import { useEffect, useRef, type ReactNode } from "react";
import type { BundleKind, BundleMembership, BundleSummary, PublicSkill } from "@myskills-app/core";
import { inAppClick, tileTone } from "./BundleUtils.js";

export function Tile({ slug, size = "sm" }: { slug: string; size?: "sm" | "md" | "lg" }) {
  return <span aria-hidden="true" className={`bundle-tile is-${tileTone(slug)} is-${size}`} />;
}

/**
 * Four-slot cluster built from visible members only: the server's preview when
 * present, otherwise loaded members. Slots stay neutral until slugs are known;
 * empty slots mark bundles with fewer than four.
 */
export function BundleCluster({ bundle, memberSlugs, large = false }: { bundle: BundleSummary; memberSlugs: string[]; large?: boolean }) {
  const filled = Math.min(4, bundle.memberCount);
  const slugs = bundle.preview?.length ? bundle.preview.map((item) => item.slug) : memberSlugs;
  return (
    <span aria-hidden="true" className={`bundle-cluster${bundle.kind === "source" ? " is-source" : ""}${large ? " is-large" : ""}`}>
      {Array.from({ length: 4 }, (_, index) => {
        const slug = slugs[index];
        const state = index >= filled ? "is-empty" : slug ? `is-${tileTone(slug)}` : "is-pending";
        return <span className={`bundle-tile ${state}`} key={index} />;
      })}
    </span>
  );
}

export function KindBadge({ kind }: { kind: BundleKind }) {
  return <span className={`bundle-kind is-${kind}`}>{kind === "source" ? "Source group" : "Curated"}</span>;
}

export function Attribution({ bundle }: { bundle: BundleSummary }) {
  if (bundle.kind === "source" && bundle.source) {
    return <span className="bundle-attribution">From <span className="bundle-mono">{bundle.source.fullName}</span>{bundle.source.path ? ` · ${bundle.source.path}` : ""}</span>;
  }
  return <span className="bundle-attribution">Curated by {bundle.owner.name} · revision {bundle.revision}</span>;
}

export function Highlight({ text, query }: { text: string; query: string }) {
  const index = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (index < 0) return <>{text}</>;
  return <>{text.slice(0, index)}<mark>{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>;
}

export function SkillLink({ skill, id, href, current, query = "", onOpen }: { skill: PublicSkill; id: string; href: string; current: boolean; query?: string; onOpen: (element: HTMLElement) => void }) {
  return (
    <a
      aria-current={current ? "true" : undefined}
      className="bundle-skill-link"
      href={href}
      id={id}
      onClick={(event) => inAppClick(event, () => onOpen(event.currentTarget))}
    >
      <Tile slug={skill.slug} />
      <span className="bundle-skill-name"><Highlight text={skill.title} query={query} /></span>
    </a>
  );
}

export function AlsoIn({ memberships, exclude }: { memberships: BundleMembership[]; exclude?: string }) {
  const others = memberships.filter((item) => item.id !== exclude);
  if (others.length === 0) return null;
  return <span className="bundle-also">Also in {others.map((item) => item.name).join(", ")}</span>;
}

/** Native modal dialog: Escape cancels, the caller restores focus on close. */
export function BundleModal({ labelledBy, describedBy, onCancel, className = "", children }: { labelledBy: string; describedBy?: string; onCancel: () => void; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open && typeof dialog.showModal === "function") dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return (
    <dialog
      aria-describedby={describedBy}
      aria-labelledby={labelledBy}
      className={`bundle-dialog ${className}`}
      onCancel={(event) => { event.preventDefault(); cancel.current(); }}
      ref={ref}
    >
      {children}
    </dialog>
  );
}
