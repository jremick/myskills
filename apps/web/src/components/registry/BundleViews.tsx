import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { BundleMember, BundleSummary, PublicSkill, RegistryCatalogRow } from "@myskills-app/core";
import { Button } from "@/components/ui/button";
import type { MemberPage } from "./BundleData.js";
import { AlsoIn, Attribution, BundleCluster, KindBadge, SkillLink, Highlight } from "./BundleParts.js";
import { PARTIAL_NOTICE, bundleKey, countLabel, domId, inAppClick, plural, revealsMembers, type Selection } from "./BundleUtils.js";

export interface CatalogViewProps {
  rows: RegistryCatalogRow[];
  query: string;
  members: Record<string, MemberPage>;
  selection: Selection;
  isOpen: (key: string, reveal: boolean, fallback: boolean) => boolean;
  onToggle: (key: string, current: boolean) => void;
  onMoreMembers: (bundleId: string, cursor: string) => void;
  onRetryMembers: (bundleId: string) => void;
  /** Reload the catalog, re-checking which bundles this reader can see. */
  onRefreshCatalog: () => void;
  skillHref: (slug: string) => string;
  bundleHref: (id: string) => string;
  onOpenSkill: (slug: string, from: HTMLElement) => void;
  onOpenBundle: (id: string, from: HTMLElement) => void;
}

function split(rows: RegistryCatalogRow[]) {
  const bundles: BundleSummary[] = [];
  const loose: Array<{ skill: PublicSkill }> = [];
  for (const row of rows) {
    if (row.kind === "bundle") bundles.push(row.bundle);
    else loose.push(row);
  }
  return { bundles, loose };
}

function Chevron() {
  return <ChevronRight aria-hidden="true" className="bundle-chevron" size={16} />;
}

function MemberLine({ member, context, props }: { member: { skill: PublicSkill; memberships?: BundleMember["memberships"] }; context: string; props: CatalogViewProps }) {
  const { skill } = member;
  return (
    <div className="bundle-member">
      <SkillLink
        current={props.selection?.kind === "skill" && props.selection.slug === skill.slug}
        href={props.skillHref(skill.slug)}
        id={domId("skill", context, skill.slug)}
        onOpen={(from) => props.onOpenSkill(skill.slug, from)}
        query={props.query}
        skill={skill}
      />
      <span className="bundle-member-summary">
        <Highlight text={skill.summary} query={props.query} />
        {member.memberships && <AlsoIn memberships={member.memberships} exclude={context} />}
      </span>
      <span className="bundle-version">{skill.latestVersion ?? "No release"}</span>
    </div>
  );
}

function MemberPageState({ bundle, page, props, children }: { bundle: BundleSummary; page: MemberPage | undefined; props: CatalogViewProps; children: (members: BundleMember[]) => ReactNode }) {
  if (!page || page.status === "loading") return <p className="bundle-rail-state" role="status">Loading skills…</p>;
  if (page.status === "error") {
    // Loaded names were dropped: after lost access, only a fresh catalog read
    // can say whether this bundle is still visible.
    return (
      <div className="bundle-rail-state" role="alert">
        <span>{page.error}</span>
        {page.problem === "access" ? (
          <Button size="sm" type="button" variant="outline" onClick={props.onRefreshCatalog}>Refresh results</Button>
        ) : (
          <Button size="sm" type="button" variant="outline" onClick={() => props.onRetryMembers(bundle.id)}>
            {page.problem === "changed" ? "Refresh skills" : "Retry"}<span className="bundle-sr"> {page.problem === "changed" ? "in" : "skills in"} {bundle.name}</span>
          </Button>
        )}
      </div>
    );
  }
  return (
    <>
      {children(page.skills)}
      {page.nextCursor && (
        <div className="bundle-rail-more">
          <span>Showing {page.skills.length} of {page.total}</span>
          <Button disabled={page.loadingMore} size="sm" type="button" variant="outline" onClick={() => props.onMoreMembers(bundle.id, page.nextCursor!)}>
            {page.loadingMore ? "Loading…" : "Show more members"}<span className="bundle-sr"> in {bundle.name}</span>
          </Button>
        </div>
      )}
      {page.error && <p className="bundle-inline-error" role="alert">{page.error}</p>}
    </>
  );
}

function matchLabel(bundle: BundleSummary, page: MemberPage | undefined) {
  if (bundle.match !== "members") return "Bundle name or purpose matches · all skills shown";
  return page?.status === "ready" ? `${page.total} of ${plural(bundle.memberCount, "skill")} match` : "Some skills in this bundle match";
}

function DetailsButton({ bundle, props }: { bundle: BundleSummary; props: CatalogViewProps }) {
  return (
    <Button className="bundle-details" id={domId("bundle-details", bundle.id)} size="sm" type="button" variant="outline" onClick={(event) => props.onOpenBundle(bundle.id, event.currentTarget)}>
      Details<span className="bundle-sr"> for {bundle.name}</span>
    </Button>
  );
}

function BundleRow({ bundle, props }: { bundle: BundleSummary; props: CatalogViewProps }) {
  const open = props.isOpen(bundleKey(bundle.id), revealsMembers(bundle, props.query), false);
  const page = props.members[bundle.id];
  const toggleId = domId("bundle-toggle", bundle.id);
  const railId = domId("bundle-members", bundle.id);
  const selected = props.selection?.kind === "bundle" && props.selection.id === bundle.id;
  return (
    <section aria-labelledby={toggleId} className={`bundle-row${selected ? " is-selected" : ""}`}>
      <div className="bundle-row-head">
        <BundleCluster bundle={bundle} memberSlugs={page?.skills.map((member) => member.skill.slug) ?? []} />
        <div className="bundle-row-main">
          <h3 className="bundle-row-title">
            <button aria-controls={railId} aria-expanded={open} className="bundle-disclosure" id={toggleId} type="button" onClick={() => props.onToggle(bundleKey(bundle.id), open)}>
              <Chevron /><span><Highlight text={bundle.name} query={props.query} /></span>
            </button>
          </h3>
          <p className="bundle-purpose"><Highlight text={bundle.purpose} query={props.query} /></p>
          <p className="bundle-meta"><KindBadge kind={bundle.kind} /><Attribution bundle={bundle} /></p>
          {props.query && <p className="bundle-hit">{matchLabel(bundle, page)}</p>}
          {bundle.partial && <p className="bundle-notice">{PARTIAL_NOTICE}</p>}
        </div>
        <div className="bundle-row-side">
          <span className="bundle-count">{countLabel(bundle)}</span>
          <DetailsButton bundle={bundle} props={props} />
        </div>
      </div>
      <div className="bundle-rail-region" hidden={!open} id={railId}>
        {open && (
          <MemberPageState bundle={bundle} page={page} props={props}>
            {(members) => (
              <ul className="bundle-rail">
                {members.map((member) => <li key={member.skill.slug}><MemberLine context={bundle.id} member={member} props={props} /></li>)}
              </ul>
            )}
          </MemberPageState>
        )}
      </div>
    </section>
  );
}

export function GroupedView(props: CatalogViewProps) {
  const { bundles, loose } = split(props.rows);
  return (
    <div className="bundle-grouped">
      {bundles.length > 0 && <h2 className="bundle-section-title">Bundles</h2>}
      {bundles.map((bundle) => <BundleRow bundle={bundle} key={bundle.id} props={props} />)}
      {loose.length > 0 && (
        <>
          <h2 className="bundle-section-title">Not in a bundle</h2>
          <ul className="bundle-loose">
            {loose.map((row) => <li key={row.skill.slug}><MemberLine context="loose" member={row} props={props} /></li>)}
          </ul>
        </>
      )}
    </div>
  );
}

export function ListView(props: CatalogViewProps) {
  const rows = props.rows.filter((row): row is Extract<RegistryCatalogRow, { kind: "skill" }> => row.kind === "skill");
  return (
    <div className="bundle-list-view">
      <div aria-hidden="true" className="bundle-list-head"><span>Skill</span><span>What it does</span><span>Bundles</span><span>Version</span></div>
      <ul aria-label="Skills" className="bundle-list">
        {rows.map((row) => (
          <li className="bundle-list-row" key={row.skill.slug}>
            <div className="bundle-list-name">
              <SkillLink
                current={props.selection?.kind === "skill" && props.selection.slug === row.skill.slug}
                href={props.skillHref(row.skill.slug)}
                id={domId("skill", "list", row.skill.slug)}
                onOpen={(from) => props.onOpenSkill(row.skill.slug, from)}
                query={props.query}
                skill={row.skill}
              />
              <span className="bundle-mono bundle-slug"><Highlight text={row.skill.slug} query={props.query} /></span>
            </div>
            <p className="bundle-member-summary">
              <Highlight text={row.skill.summary} query={props.query} />
              {props.query && row.match === "bundle" && <span className="bundle-also">Listed because its bundle matches</span>}
            </p>
            <div className="bundle-chips">
              {row.memberships.length === 0 ? <span className="bundle-chip is-none">No bundle</span> : row.memberships.map((membership) => (
                <a className={`bundle-chip is-${membership.kind}`} href={props.bundleHref(membership.id)} id={domId("chip", row.skill.slug, membership.id)} key={membership.id} onClick={(event) => inAppClick(event, () => props.onOpenBundle(membership.id, event.currentTarget))}>
                  {membership.name}<span className="bundle-sr"> ({membership.kind === "source" ? "source group" : "curated"} bundle)</span>
                </a>
              ))}
            </div>
            <span className="bundle-version">{row.skill.latestVersion ?? "No release"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OutlineNode({ nodeKey, label, count, top = false, props, children, after }: { nodeKey: string; label: ReactNode; count: string; top?: boolean; props: CatalogViewProps; children: ReactNode; after?: ReactNode }) {
  const open = props.isOpen(nodeKey, false, top);
  const id = domId("outline", nodeKey);
  return (
    <li className={top ? "bundle-outline-top" : "bundle-outline-branch"}>
      <div className="bundle-outline-line">
        <button aria-controls={`${id}-group`} aria-expanded={open} className="bundle-outline-node" id={id} type="button" onClick={() => props.onToggle(nodeKey, open)}>
          <Chevron /><span className="bundle-outline-label">{label}</span><span className="bundle-outline-count">{count}</span>
        </button>
        {after}
      </div>
      <ul hidden={!open} id={`${id}-group`}>{open && children}</ul>
    </li>
  );
}

function OutlineLeaf({ skill, context, props }: { skill: PublicSkill; context: string; props: CatalogViewProps }) {
  return (
    <li className="bundle-outline-leaf">
      <SkillLink
        current={props.selection?.kind === "skill" && props.selection.slug === skill.slug}
        href={props.skillHref(skill.slug)}
        id={domId("skill", "outline", context, skill.slug)}
        onOpen={(from) => props.onOpenSkill(skill.slug, from)}
        query={props.query}
        skill={skill}
      />
      <span className="bundle-version">{skill.latestVersion ?? "No release"}</span>
    </li>
  );
}

function OutlineBundle({ bundle, props }: { bundle: BundleSummary; props: CatalogViewProps }) {
  const key = bundleKey(bundle.id);
  const open = props.isOpen(key, revealsMembers(bundle, props.query), false);
  return (
    <OutlineNode
      after={<DetailsButton bundle={bundle} props={props} />}
      count={countLabel(bundle)}
      label={<Highlight text={bundle.name} query={props.query} />}
      nodeKey={key}
      props={props}
    >
      {bundle.partial && <li><p className="bundle-notice">{PARTIAL_NOTICE}</p></li>}
      {open && (
        <li className="bundle-outline-members">
          <MemberPageState bundle={bundle} page={props.members[bundle.id]} props={props}>
            {(members) => <ul>{members.map((member) => <OutlineLeaf context={bundle.id} key={member.skill.slug} props={props} skill={member.skill} />)}</ul>}
          </MemberPageState>
        </li>
      )}
    </OutlineNode>
  );
}

export function OutlineView(props: CatalogViewProps) {
  const { bundles, loose } = split(props.rows);
  const sources = bundles.filter((bundle) => bundle.kind === "source");
  const curated = bundles.filter((bundle) => bundle.kind === "curated");
  return (
    <ul aria-label="Catalog outline" className="bundle-outline">
      {sources.length > 0 && (
        <OutlineNode count={String(sources.length)} label="Source groups" nodeKey="top:source" props={props} top>
          {sources.map((bundle) => <OutlineBundle bundle={bundle} key={bundle.id} props={props} />)}
        </OutlineNode>
      )}
      {curated.length > 0 && (
        <OutlineNode count={String(curated.length)} label="Curated bundles" nodeKey="top:curated" props={props} top>
          {curated.map((bundle) => <OutlineBundle bundle={bundle} key={bundle.id} props={props} />)}
        </OutlineNode>
      )}
      {loose.length > 0 && (
        <OutlineNode count={String(loose.length)} label="Not in a bundle" nodeKey="top:loose" props={props} top>
          {loose.map((row) => <OutlineLeaf context="loose" key={row.skill.slug} props={props} skill={row.skill} />)}
        </OutlineNode>
      )}
    </ul>
  );
}
