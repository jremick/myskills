import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import {
  Archive,
  ArrowLeft,
  Check,
  GitBranch,
  Mail,
  Plus,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { humanize } from "@/components/registry/status-display";
import { useSplitLayout } from "@/components/registry/useSplitLayout";
import {
  safeOrganizationErrorMessage,
  type OrganizationDetail,
  type OrganizationInvitationRecord,
  type OrganizationListItem,
  type OrganizationMembershipRecord,
  type OrganizationPolicyRevisionRecord,
  type OrganizationRole,
  type RegistryClient,
  type TeamRecord,
} from "../../api.js";
import type { OrganizationPolicyV1 } from "@myskills-app/core";

interface OrganizationSession {
  user: {
    id: string;
    email: string;
    name?: string;
  };
}

type LoadState = "loading" | "ready" | "error";
type FocusTarget = { kind: "title" } | { kind: "row"; id: string } | { kind: "new" } | { kind: "create-name" };

const ORGANIZATION_POLICY_DEFAULTS: OrganizationPolicyV1 = {
  schemaVersion: 1,
  sharing: {
    organizationSkillSharingEnabled: true,
    organizationArchitectureSharingEnabled: true,
    membersCanShareOwnedSkillsToOrganization: false,
    teamOwnersCanShareArchitecturesToParentOrganization: false,
  },
  teams: {
    membersCanCreateTeams: false,
    requireOrganizationMembershipForTeamMembers: true,
    allowStandaloneTeamAdoption: true,
  },
  limits: {
    teamsPerOrganization: 100,
    membersPerOrganization: 1000,
    organizationGrantsPerSkill: 25,
    organizationGrantsPerArchitecture: 25,
  },
};

// Organizations use the Registry list and detail layout (people.css). The list
// comes first; the selected organization's detail sits beside it when the
// surface is wide, and replaces it (with Back) when the surface is narrow.
export function OrganizationsDashboard({ client }: { client: RegistryClient; session: OrganizationSession }) {
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [organizations, setOrganizations] = useState<OrganizationListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrganizationDetail | null>(null);
  const [members, setMembers] = useState<OrganizationMembershipRecord[]>([]);
  const [invitations, setInvitations] = useState<OrganizationInvitationRecord[]>([]);
  const [pendingInvitations, setPendingInvitations] = useState<OrganizationInvitationRecord[]>([]);
  const [policies, setPolicies] = useState<OrganizationPolicyRevisionRecord[]>([]);
  const [teams, setTeams] = useState<TeamRecord[]>([]);
  const [detailState, setDetailState] = useState<LoadState>("ready");
  const [detailMessage, setDetailMessage] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const listEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const selectedRef = useRef<string | null>(null);
  const listRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const focusTarget = useRef<FocusTarget | null>(null);
  const { layout, ref: surfaceRef } = useSplitLayout();
  const baseId = useId();
  const stacked = layout === "stack";
  const selected = organizations.find((item) => item.id === selectedId) ?? null;
  const showDetail = Boolean(selected) && (!stacked || detailOpen);
  const listHidden = stacked && showDetail;

  const listOrganizations = client.listOrganizations;
  const getOrganization = client.getOrganization;

  const refreshOrganizations = useCallback(async () => {
    const requestEpoch = listEpoch.current + 1;
    listEpoch.current = requestEpoch;
    // A list refresh can change the selected organization. Invalidate any
    // detail request already in flight before replacing the list so an older
    // response cannot resurrect a detail panel for a stale selection.
    detailEpoch.current += 1;
    setDetail(null);
    setState("loading");
    setDetailState("loading");
    setMessage(null);
    if (!listOrganizations || !client.listOrganizationPendingInvitations) {
      setState("error");
      setMessage("Organization management is not available in this workspace yet.");
      return;
    }
    try {
      const [nextOrganizations, nextInvitations] = await Promise.all([
        listOrganizations(),
        client.listOrganizationPendingInvitations(),
      ]);
      if (requestEpoch !== listEpoch.current) return;
      const current = selectedRef.current;
      const kept = current && nextOrganizations.some((item) => item.id === current) ? current : null;
      // Auto-selection never opens the stacked detail; only a tap does.
      if (!kept) setDetailOpen(false);
      selectedRef.current = kept ?? nextOrganizations[0]?.id ?? null;
      setOrganizations(nextOrganizations);
      setPendingInvitations(nextInvitations);
      setSelectedId(selectedRef.current);
      setState("ready");
    } catch (error) {
      if (requestEpoch !== listEpoch.current) return;
      setState("error");
      setMessage(safeOrganizationErrorMessage(error));
    }
  }, [client, listOrganizations]);

  useEffect(() => {
    void refreshOrganizations();
  }, [refreshOrganizations, refreshKey]);

  const refreshDetail = useCallback(async (organizationId: string) => {
    const requestEpoch = detailEpoch.current + 1;
    detailEpoch.current = requestEpoch;
    setDetailState("loading");
    setDetailMessage(null);
    if (
      !getOrganization
      || !client.listOrganizationMembers
      || !client.listOrganizationPolicies
      || !client.listOrganizationTeams
    ) {
      setDetailState("error");
      setDetailMessage("Organization detail is not available in this workspace yet.");
      return;
    }
    try {
      const detailRequest = getOrganization(organizationId);
      const [nextDetail, nextMembers, nextInvitations, nextPolicies, nextTeams] = await Promise.all([
        detailRequest,
        client.listOrganizationMembers(organizationId),
        detailRequest.then((organization) => {
          if (organization.role !== "owner" && organization.role !== "admin") return [];
          if (!client.listOrganizationInvitations) throw new Error("Organization invitations are unavailable.");
          return client.listOrganizationInvitations(organizationId);
        }),
        client.listOrganizationPolicies(organizationId),
        client.listOrganizationTeams(organizationId),
      ]);
      if (requestEpoch !== detailEpoch.current) return;
      setDetail(nextDetail);
      setMembers(nextMembers);
      setInvitations(nextInvitations);
      setPolicies(nextPolicies);
      setTeams(nextTeams);
      setDetailState("ready");
    } catch (error) {
      if (requestEpoch !== detailEpoch.current) return;
      setDetail(null);
      setMembers([]);
      setInvitations([]);
      setPolicies([]);
      setTeams([]);
      setDetailState("error");
      setDetailMessage(safeOrganizationErrorMessage(error));
    }
  }, [client, getOrganization]);

  useEffect(() => {
    if (!selectedId || state !== "ready") {
      setDetail(null);
      setMembers([]);
      setInvitations([]);
      setPolicies([]);
      setTeams([]);
      setDetailState("ready");
      return;
    }
    void refreshDetail(selectedId);
  }, [refreshDetail, selectedId, state]);

  // Focus follows the reader: into the opened detail, back to the row that
  // opened it, and between New organization and its form.
  useEffect(() => {
    const target = focusTarget.current;
    if (!target) return;
    const element = target.kind === "title" ? titleRef.current
      : target.kind === "row" ? findRow(listRef.current, target.id)
        : target.kind === "new" ? newButtonRef.current
          : document.getElementById("new-organization-name");
    if (!element) return;
    focusTarget.current = null;
    element.focus();
  });

  function openOrganization(id: string) {
    if (id !== selectedRef.current) {
      detailEpoch.current += 1;
      setDetail(null);
      selectedRef.current = id;
      setSelectedId(id);
    }
    setDetailOpen(true);
    focusTarget.current = { kind: "title" };
  }

  function backToOrganizations() {
    setDetailOpen(false);
    if (selectedRef.current) focusTarget.current = { kind: "row", id: selectedRef.current };
  }

  function openCreate() {
    setCreateOpen(true);
    if (stacked) setDetailOpen(false);
    focusTarget.current = { kind: "create-name" };
  }

  function closeCreate() {
    setCreateOpen(false);
    focusTarget.current = { kind: "new" };
  }

  return (
    <main className="registry-workspace people-workspace organization-workspace" aria-label="Organizations">
      <header className="app-page-header people-page-head">
        <h1>Organizations</h1>
        <div className="people-page-actions">
          <Button aria-expanded={createOpen} ref={newButtonRef} size="sm" type="button" onClick={openCreate}>
            <Plus size={16} aria-hidden="true" />
            New organization
          </Button>
          <Button size="sm" type="button" variant="outline" onClick={() => setRefreshKey((value) => value + 1)}>
            <RefreshCw size={16} aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </header>

      <PendingOrganizationInvitations
        invitations={pendingInvitations}
        client={client}
        onAccepted={() => setRefreshKey((value) => value + 1)}
      />

      <div className="registry-surface" data-layout={layout} ref={surfaceRef}>
        <div className="registry-body" data-columns={showDetail && !listHidden ? undefined : "1"}>
          <section aria-busy={state === "loading"} aria-labelledby={`${baseId}-list`} className="registry-list" hidden={listHidden} ref={listRef}>
            {createOpen && (
              <CreateOrganizationForm
                client={client}
                onCancel={closeCreate}
                onCreated={(created) => {
                  setCreateOpen(false);
                  selectedRef.current = created.id;
                  setSelectedId(created.id);
                  setDetailOpen(true);
                  focusTarget.current = { kind: "title" };
                  setRefreshKey((value) => value + 1);
                }}
              />
            )}
            <div className="registry-list-label">
              <h2 id={`${baseId}-list`}>Organizations</h2>
              <span aria-live="polite">{state === "ready" ? organizations.length : ""}</span>
            </div>
            {state === "loading" && organizations.length === 0 && <PeopleSkeleton label="Loading organizations…" />}
            {state === "error" && message && (
              <div className="registry-list-state">
                <p role="alert">{message}</p>
                <Button size="sm" type="button" variant="outline" onClick={() => setRefreshKey((value) => value + 1)}>
                  <RefreshCw size={15} aria-hidden="true" />
                  Retry
                </Button>
              </div>
            )}
            {state === "ready" && organizations.length === 0 && (
              <div className="registry-list-state">
                <strong>No organizations yet.</strong>
                <p>Create an organization to manage shared skills, teams, and policy.</p>
              </div>
            )}
            {organizations.length > 0 && (
              <div className="registry-rows">
                {organizations.map((organization) => (
                  <button
                    aria-current={!stacked && organization.id === selectedId ? "true" : undefined}
                    className="registry-row people-row"
                    data-row-id={organization.id}
                    key={organization.id}
                    type="button"
                    onClick={() => openOrganization(organization.id)}
                  >
                    <span className="people-row-icon" aria-hidden="true"><GitBranch size={16} /></span>
                    <span className="registry-row-text">
                      <span className="registry-row-title">{organization.name}</span>
                      <span className="registry-row-meta">
                        <code>{organization.slug}</code>
                        <span>{humanize(organization.role)}</span>
                        {organization.status !== "active" && <span>{humanize(organization.status)}</span>}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {showDetail && (
            <OrganizationDetailPanel
              client={client}
              detail={detail}
              detailState={detailState}
              message={detailMessage}
              members={members}
              invitations={invitations}
              policies={policies}
              teams={teams}
              stacked={stacked}
              titleRef={titleRef}
              onBack={backToOrganizations}
              onRefresh={() => selectedId && void refreshDetail(selectedId)}
              onArchived={() => setRefreshKey((value) => value + 1)}
            />
          )}
        </div>
      </div>
    </main>
  );
}

function CreateOrganizationForm({ client, onCancel, onCreated }: { client: RegistryClient; onCancel: () => void; onCreated: (organization: OrganizationDetail) => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [reason, setReason] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function create() {
    if (!client.createOrganization) {
      setState("error");
      setMessage("Organization creation is not available in this workspace yet.");
      return;
    }
    if (!name.trim()) {
      setState("error");
      setMessage("Give the organization a name before creating it.");
      return;
    }
    setState("saving");
    setMessage(null);
    try {
      const created = await client.createOrganization({
        name: name.trim(),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setName("");
      setSlug("");
      setReason("");
      setState("idle");
      onCreated(created);
    } catch (error) {
      setState("error");
      setMessage(safeOrganizationErrorMessage(error));
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void create();
  }

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key !== "Escape" || state === "saving") return;
    event.preventDefault();
    onCancel();
  }

  return (
    <form aria-label="Create organization" className="control-plane-form people-create" onKeyDown={onKeyDown} onSubmit={(event) => void submit(event)}>
      <p className="people-create-intro"><strong>New organization</strong> <span>Create a governed sharing boundary. Organization creation requires an MFA-verified owner session.</span></p>
      <label htmlFor="new-organization-name"><span>Name</span><Input id="new-organization-name" aria-describedby={state === "error" && !name.trim() ? "new-organization-name-error" : undefined} aria-invalid={state === "error" && !name.trim()} aria-required="true" disabled={state === "saving"} onChange={(event) => setName(event.target.value)} placeholder="Acme skills" value={name} />{state === "error" && !name.trim() && <small id="new-organization-name-error" role="alert">Give the organization a name before creating it.</small>}</label>
      <label><span>Slug <small>(optional)</small></span><Input aria-label="Organization slug" disabled={state === "saving"} onChange={(event) => setSlug(event.target.value)} placeholder="acme-skills" value={slug} /></label>
      <label><span>Reason <small>(optional audit note)</small></span><Input aria-label="Organization creation reason" disabled={state === "saving"} onChange={(event) => setReason(event.target.value)} placeholder="Why this boundary exists" value={reason} /></label>
      {message && <div className="control-plane-inline-message" role={state === "error" ? "alert" : "status"}><span>{message}</span>{state === "error" && name.trim() && <Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => void create()}>Retry</Button>}</div>}
      <div className="people-form-actions">
        <Button disabled={state === "saving" || !name.trim()} size="sm" type="submit"><Plus size={15} aria-hidden="true" />{state === "saving" ? "Creating…" : "Create organization"}</Button>
        <Button disabled={state === "saving"} size="sm" type="button" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function OrganizationDetailPanel({
  client,
  detail,
  detailState,
  message,
  members,
  invitations,
  policies,
  teams,
  stacked,
  titleRef,
  onBack,
  onRefresh,
  onArchived,
}: {
  client: RegistryClient;
  detail: OrganizationDetail | null;
  detailState: LoadState;
  message: string | null;
  members: OrganizationMembershipRecord[];
  invitations: OrganizationInvitationRecord[];
  policies: OrganizationPolicyRevisionRecord[];
  teams: TeamRecord[];
  stacked: boolean;
  titleRef: RefObject<HTMLHeadingElement | null>;
  onBack: () => void;
  onRefresh: () => void;
  onArchived: () => void;
}) {
  const titleId = useId();
  const canAdmin = detail?.role === "owner" || detail?.role === "admin";
  const canManagePolicy = detail?.role === "owner";
  const retry = <Button size="sm" type="button" variant="outline" onClick={onRefresh}><RefreshCw size={15} aria-hidden="true" /> Retry</Button>;
  return (
    <section aria-label={detail ? undefined : "Organization detail"} aria-labelledby={detail ? titleId : undefined} className="registry-inspector people-detail">
      {stacked && (
        <Button className="registry-back" type="button" variant="ghost" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" />
          Back to organizations
        </Button>
      )}
      {!detail ? (
        detailState === "error" && message
          ? <div className="people-status" data-tone="danger" role="alert"><span>{message}</span>{retry}</div>
          : <PeopleSkeleton detail label="Loading organization detail…" />
      ) : (
        <>
          <header className="people-detail-head">
            <div className="registry-inspector-title">
              <h2 id={titleId} ref={titleRef} tabIndex={-1}>{detail.name}</h2>
              <p className="registry-inspector-meta">
                <code>{detail.slug}</code>
                <span aria-hidden="true">·</span>
                <span>{humanize(detail.status)}</span>
                <span aria-hidden="true">·</span>
                <span>Your role: {humanize(detail.role)}</span>
              </p>
              <p className="people-note">Organization is a sharing boundary. Personal, work, and team labels do not grant access.</p>
            </div>
            {canManagePolicy && detail.status === "active" && <ArchiveOrganizationButton key={detail.id} client={client} organizationId={detail.id} organizationName={detail.name} onArchived={onArchived} />}
          </header>
          {detailState === "error" && message && <div className="people-status" data-tone="danger" role="alert"><span>{message}</span>{retry}</div>}
          <OrganizationMembersPanel client={client} detail={detail} members={members} invitations={invitations} canAdmin={canAdmin} onChanged={onRefresh} />
          <OrganizationTeamsPanel client={client} detail={detail} teams={teams} canAdmin={canAdmin} onChanged={onRefresh} />
          <OrganizationPolicyPanel client={client} detail={detail} policies={policies} canManage={canManagePolicy} onChanged={onRefresh} />
        </>
      )}
    </section>
  );
}

function OrganizationMembersPanel({ client, detail, members, invitations, canAdmin, onChanged }: {
  client: RegistryClient;
  detail: OrganizationDetail;
  members: OrganizationMembershipRecord[];
  invitations: OrganizationInvitationRecord[];
  canAdmin: boolean;
  onChanged: () => void;
}) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrganizationRole>("member");
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState<{ scope: "invite" | "role" | "members"; text: string; tone: "danger" | "teal" } | null>(null);
  const [pendingRoleChange, setPendingRoleChange] = useState<{ member: OrganizationMembershipRecord; nextRole: OrganizationRole } | null>(null);
  const [removal, setRemoval] = useState<OrganizationMembershipRecord | null>(null);
  const removed = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const focusTarget = useRef<{ kind: "email" | "trigger" | "heading" } | { kind: "role"; userId: string } | null>(null);
  const baseId = useId();

  useEffect(() => {
    const target = focusTarget.current;
    if (!target) return;
    const element = target.kind === "email" ? document.getElementById(`${baseId}-email`)
      : target.kind === "trigger" ? triggerRef.current
        : target.kind === "heading" ? headingRef.current
          : target.kind === "role" ? findRole(listRef.current, target.userId) : null;
    if (!element) return;
    focusTarget.current = null;
    element.focus();
  });

  async function submitInvite() {
    if (!client.inviteOrganizationMember || !email.trim()) return;
    const invited = email.trim();
    setState("saving");
    setMessage(null);
    try {
      await client.inviteOrganizationMember({ organizationId: detail.id, email: invited, role });
      setEmail("");
      setRole("member");
      setState("idle");
      setInviteOpen(false);
      setMessage({ scope: "members", text: `Invitation sent to ${invited}.`, tone: "teal" });
      focusTarget.current = { kind: "trigger" };
      onChanged();
    } catch (error) {
      setState("error");
      setMessage({ scope: "invite", text: safeOrganizationErrorMessage(error), tone: "danger" });
    }
  }

  function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitInvite();
  }

  function openInvite() {
    setInviteOpen(true);
    setMessage(null);
    focusTarget.current = { kind: "email" };
  }

  function closeInvite() {
    if (state === "saving") return;
    setInviteOpen(false);
    setState("idle");
    setMessage(null);
    focusTarget.current = { kind: "trigger" };
  }

  function requestRoleChange(member: OrganizationMembershipRecord, nextRole: OrganizationRole) {
    if (!client.updateOrganizationMemberRole || nextRole === member.role) return;
    setPendingRoleChange({ member, nextRole });
    setMessage(null);
  }

  function cancelRoleChange() {
    const userId = pendingRoleChange?.member.userId;
    setPendingRoleChange(null);
    setState("idle");
    setMessage(null);
    if (userId) focusTarget.current = { kind: "role", userId };
  }

  async function confirmRoleChange() {
    if (!client.updateOrganizationMemberRole || !pendingRoleChange) return;
    setState("saving");
    setMessage(null);
    try {
      await client.updateOrganizationMemberRole({ organizationId: detail.id, memberId: pendingRoleChange.member.userId, role: pendingRoleChange.nextRole });
      focusTarget.current = { kind: "role", userId: pendingRoleChange.member.userId };
      setPendingRoleChange(null);
      setState("idle");
      onChanged();
    } catch (error) {
      setState("error");
      setMessage({ scope: "role", text: safeOrganizationErrorMessage(error), tone: "danger" });
    }
  }

  async function removeMember(member: OrganizationMembershipRecord) {
    if (!client.removeOrganizationMember) throw new Error("Member removal is not available in this workspace yet.");
    try {
      await client.removeOrganizationMember(detail.id, member.userId);
    } catch (error) {
      throw new Error(safeOrganizationErrorMessage(error));
    }
    removed.current = true;
    setPendingRoleChange(null);
    setMessage({ scope: "members", text: `${member.email} was removed from ${detail.name}.`, tone: "teal" });
    onChanged();
  }

  function closeRemoval() {
    // The dialog returns focus to Remove first; after a removal that row is
    // going away, so the Members heading takes focus instead.
    if (removed.current) focusTarget.current = { kind: "heading" };
    removed.current = false;
    setRemoval(null);
  }

  const status = (scope: "invite" | "role" | "members") => message?.scope === scope
    ? <p className="people-status" data-tone={message.tone} role={message.tone === "danger" ? "alert" : "status"}>{message.text}</p>
    : null;

  return (
    <section aria-labelledby={`${baseId}-heading`} className="registry-section">
      <div className="people-section-head">
        <h3 id={`${baseId}-heading`} ref={headingRef} tabIndex={-1}>Members</h3>
        {canAdmin && (
          <Button aria-expanded={inviteOpen} ref={triggerRef} size="sm" type="button" variant="outline" onClick={() => inviteOpen ? closeInvite() : openInvite()}>
            <Mail size={15} aria-hidden="true" />
            Invite member
          </Button>
        )}
      </div>
      {!canAdmin && <p className="registry-muted">Only organization owners and admins can invite or manage members.</p>}
      {canAdmin && inviteOpen && (
        <form aria-label="Invite organization member" className="people-inline-form" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeInvite(); } }} onSubmit={(event) => void invite(event)}>
          <label className="people-field people-field-grow" htmlFor={`${baseId}-email`}>
            <span>Email</span>
            <Input aria-label="Organization member email" autoComplete="email" disabled={state === "saving"} id={`${baseId}-email`} onChange={(event) => setEmail(event.target.value)} placeholder="collaborator@example.com" spellCheck={false} type="email" value={email} />
          </label>
          <label className="people-field people-field-role">
            <span>Role</span>
            <select aria-label="Organization invitation role" disabled={state === "saving"} onChange={(event) => setRole(event.target.value as OrganizationRole)} value={role}><option value="member">Member</option><option value="admin">Admin</option></select>
          </label>
          <div className="people-form-actions">
            <Button disabled={state === "saving" || !email.trim()} size="sm" type="submit"><Mail size={15} aria-hidden="true" />Invite</Button>
            <Button disabled={state === "saving"} size="sm" type="button" variant="outline" onClick={closeInvite}>Cancel</Button>
          </div>
          {message?.scope === "invite" && <div className="people-status" data-tone="danger" role="alert"><span>{message.text}</span><Button size="sm" type="button" variant="outline" onClick={() => void submitInvite()}>Retry</Button></div>}
        </form>
      )}
      {status("members")}
      <ul aria-labelledby={`${baseId}-heading`} className="people-list" ref={listRef}>
        {members.map((member) => {
          const manageable = canAdmin && (detail.role === "owner" || member.role !== "owner");
          const changing = pendingRoleChange?.member.userId === member.userId ? pendingRoleChange : null;
          return (
            <li key={member.id}>
              <span className="people-person">
                <strong>{member.name || member.email}</strong>
                {member.name && <small>{member.email}</small>}
              </span>
              <span className="people-row-actions">
                {manageable
                  ? <select aria-label={`Role for ${member.email}`} data-user-id={member.userId} disabled={state === "saving" || Boolean(pendingRoleChange)} onChange={(event) => requestRoleChange(member, event.target.value as OrganizationRole)} value={member.role}><option value="member">Member</option><option value="admin">Admin</option>{detail.role === "owner" && <option value="owner">Owner</option>}</select>
                  : <span className="registry-chip">{humanize(member.role)}</span>}
                {manageable && <Button className="people-danger" disabled={state === "saving"} size="sm" type="button" variant="outline" onClick={() => setRemoval(member)}>Remove</Button>}
              </span>
              {changing && (
                <div className="people-confirm-strip" role="alert">
                  <span>Change {member.email} from {humanize(member.role)} to {humanize(changing.nextRole)}?</span>
                  {status("role")}
                  <div className="people-form-actions">
                    <Button disabled={state === "saving"} size="sm" type="button" variant="outline" onClick={cancelRoleChange}>Cancel</Button>
                    <Button disabled={state === "saving"} size="sm" type="button" onClick={() => void confirmRoleChange()}>Confirm role change</Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {members.length === 0 && <p className="registry-muted">No active members were returned.</p>}
      {canAdmin && (
        <div className="people-subsection">
          <h4>Pending invitations</h4>
          {invitations.length === 0 ? <p className="registry-muted">No pending invitations.</p> : (
            <ul className="people-list">
              {invitations.map((invitation) => (
                <li key={invitation.id}>
                  <span className="people-person"><strong>{invitation.email}</strong><small>{humanize(invitation.role)} · Sent {formatControlPlaneDate(invitation.createdAt)}</small></span>
                  <span className="registry-chip">{humanize(invitation.status)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {removal && (
        <ConfirmationDialog
          key={`remove-member-${removal.id}`}
          request={{
            key: `remove-member-${removal.id}`,
            title: `Remove ${removal.email}?`,
            description: `${removal.email} will be removed from ${detail.name}. Access that comes from membership in this organization ends.`,
            confirmLabel: "Remove member",
            destructive: true,
            onConfirm: () => removeMember(removal),
          }}
          onClose={closeRemoval}
        />
      )}
    </section>
  );
}

function OrganizationPolicyPanel({ client, detail, policies, canManage, onChanged }: {
  client: RegistryClient;
  detail: OrganizationDetail;
  policies: OrganizationPolicyRevisionRecord[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<OrganizationPolicyV1>(() => clonePolicy(detail.currentPolicy?.policy ?? ORGANIZATION_POLICY_DEFAULTS));
  const [reason, setReason] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [pendingAppend, setPendingAppend] = useState(false);
  const [pendingActivation, setPendingActivation] = useState<OrganizationPolicyRevisionRecord | null>(null);
  const baseId = useId();

  useEffect(() => {
    setDraft(clonePolicy(detail.currentPolicy?.policy ?? ORGANIZATION_POLICY_DEFAULTS));
    setReason("");
    setPendingAppend(false);
    setPendingActivation(null);
    setState("idle");
    setMessage(null);
  }, [detail.currentPolicy?.policy, detail.id]);

  function setFlag(section: "sharing" | "teams", key: keyof OrganizationPolicyV1["sharing"] | keyof OrganizationPolicyV1["teams"], value: boolean) {
    setDraft((current) => ({ ...current, [section]: { ...current[section], [key]: value } } as OrganizationPolicyV1));
  }

  function setLimit(key: keyof OrganizationPolicyV1["limits"], value: string) {
    const numeric = Number.parseInt(value, 10);
    setDraft((current) => ({ ...current, limits: { ...current.limits, [key]: Number.isFinite(numeric) && numeric > 0 ? numeric : 1 } }));
  }

  async function commitAppendPolicy() {
    if (!client.appendOrganizationPolicy) return;
    setState("saving");
    setMessage(null);
    try {
      const result = await client.appendOrganizationPolicy({ organizationId: detail.id, policy: draft, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      setState("idle");
      setPendingAppend(false);
      setEditing(false);
      setMessage(result.activated ? `Policy revision ${result.revision.revisionNumber} was appended and activated.` : `Policy revision ${result.revision.revisionNumber} was appended; the current policy remains unchanged.`);
      setReason("");
      onChanged();
    } catch (error) {
      setState("error");
      setMessage(safeOrganizationErrorMessage(error));
    }
  }

  function appendPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingAppend) {
      setPendingAppend(true);
      setMessage("Review this immutable policy revision before it is appended and activated.");
      return;
    }
    void commitAppendPolicy();
  }

  async function commitActivatePolicy(revision: OrganizationPolicyRevisionRecord) {
    if (!client.activateOrganizationPolicy) return;
    setState("saving");
    setMessage(null);
    try {
      await client.activateOrganizationPolicy(detail.id, revision.id);
      setPendingActivation(null);
      setState("idle");
      setMessage(`Policy revision ${revision.revisionNumber} is now active.`);
      onChanged();
    } catch (error) {
      setState("error");
      setMessage(safeOrganizationErrorMessage(error));
    }
  }

  function requestActivatePolicy(revision: OrganizationPolicyRevisionRecord) {
    setPendingActivation(revision);
    setMessage(null);
  }

  function cancelAppendPolicy() {
    setPendingAppend(false);
    setState("idle");
    setMessage(null);
  }

  function cancelActivatePolicy() {
    setPendingActivation(null);
    setState("idle");
    setMessage(null);
  }

  function toggleEditing() {
    if (editing) {
      // Closing the form discards the unsaved draft.
      setDraft(clonePolicy(detail.currentPolicy?.policy ?? ORGANIZATION_POLICY_DEFAULTS));
      setReason("");
      setPendingAppend(false);
      setState("idle");
      setMessage(null);
    }
    setEditing(!editing);
  }

  const current = policies.find((revision) => revision.id === detail.currentPolicyRevisionId);

  return (
    <section aria-labelledby={`${baseId}-heading`} className="registry-section">
      <div className="people-section-head">
        <h3 id={`${baseId}-heading`}>Policy</h3>
        {canManage && (
          <Button aria-controls={editing ? `${baseId}-form` : undefined} aria-expanded={editing} disabled={state === "saving"} size="sm" type="button" variant="outline" onClick={toggleEditing}>
            Change policy
          </Button>
        )}
      </div>
      <p className="registry-muted">{current ? `Revision ${current.revisionNumber} is the current policy.` : "No current policy revision."} Policy changes create immutable revisions. A new revision activates immediately when the API reports activation; the current pointer controls organization sharing and team boundaries.</p>
      {policies.length > 0 && (
        <ul className="people-list">
          {policies.map((revision) => {
            const isCurrent = revision.id === detail.currentPolicyRevisionId;
            return (
              <li key={revision.id}>
                <span className="people-person"><strong>Revision {revision.revisionNumber}{isCurrent ? " · Current" : ""}</strong><small>{revision.reason || "No audit note"} · {formatControlPlaneDate(revision.createdAt)}</small></span>
                <span className="people-row-actions">
                  {isCurrent
                    ? <span className="registry-chip" data-tone="teal">Active</span>
                    : canManage
                      ? pendingActivation?.id === revision.id ? null : <Button disabled={state === "saving" || Boolean(pendingActivation)} size="sm" type="button" variant="outline" onClick={() => requestActivatePolicy(revision)}><Check size={15} aria-hidden="true" />Activate</Button>
                      : <span className="registry-chip">Inactive</span>}
                </span>
                {canManage && pendingActivation?.id === revision.id && (
                  <div className="control-plane-inline-message people-confirm-strip" role="alert">
                    <span>Activate immutable policy revision {revision.revisionNumber}?</span>
                    <div className="people-form-actions">
                      <Button className="shadcn-action-button" disabled={state === "saving"} size="sm" type="button" variant="outline" onClick={cancelActivatePolicy}>Cancel</Button>
                      <Button className="shadcn-action-button" disabled={state === "saving"} size="sm" type="button" onClick={() => void commitActivatePolicy(revision)}>{state === "saving" ? "Activating…" : "Confirm activate"}</Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {policies.length === 0 && <p className="registry-muted">No policy revisions returned.</p>}
      {canManage && editing && (
        <form className="organization-policy-form" id={`${baseId}-form`} onSubmit={(event) => void appendPolicy(event)}>
          <div className="organization-policy-flags">
            <PolicyCheckbox disabled={state === "saving"} label="Enable organization skill sharing" checked={draft.sharing.organizationSkillSharingEnabled} onChange={(value) => setFlag("sharing", "organizationSkillSharingEnabled", value)} />
            <PolicyCheckbox disabled={state === "saving"} label="Enable organization architecture sharing" checked={draft.sharing.organizationArchitectureSharingEnabled} onChange={(value) => setFlag("sharing", "organizationArchitectureSharingEnabled", value)} />
            <PolicyCheckbox disabled={state === "saving"} label="Let members share owned skills" checked={draft.sharing.membersCanShareOwnedSkillsToOrganization} onChange={(value) => setFlag("sharing", "membersCanShareOwnedSkillsToOrganization", value)} />
            <PolicyCheckbox disabled={state === "saving"} label="Let team owners share architectures" checked={draft.sharing.teamOwnersCanShareArchitecturesToParentOrganization} onChange={(value) => setFlag("sharing", "teamOwnersCanShareArchitecturesToParentOrganization", value)} />
            <PolicyCheckbox disabled={state === "saving"} label="Let members create child teams" checked={draft.teams.membersCanCreateTeams} onChange={(value) => setFlag("teams", "membersCanCreateTeams", value)} />
            <PolicyCheckbox disabled={state === "saving"} label="Require organization membership for team members" checked={draft.teams.requireOrganizationMembershipForTeamMembers} onChange={(value) => setFlag("teams", "requireOrganizationMembershipForTeamMembers", value)} />
            <PolicyCheckbox disabled={state === "saving"} label="Allow standalone team adoption" checked={draft.teams.allowStandaloneTeamAdoption} onChange={(value) => setFlag("teams", "allowStandaloneTeamAdoption", value)} />
          </div>
          <div className="organization-policy-limits">
            <PolicyLimit disabled={state === "saving"} label="Teams per organization" value={draft.limits.teamsPerOrganization} onChange={(value) => setLimit("teamsPerOrganization", value)} />
            <PolicyLimit disabled={state === "saving"} label="Members per organization" value={draft.limits.membersPerOrganization} onChange={(value) => setLimit("membersPerOrganization", value)} />
            <PolicyLimit disabled={state === "saving"} label="Skill grants" value={draft.limits.organizationGrantsPerSkill} onChange={(value) => setLimit("organizationGrantsPerSkill", value)} />
            <PolicyLimit disabled={state === "saving"} label="Architecture grants" value={draft.limits.organizationGrantsPerArchitecture} onChange={(value) => setLimit("organizationGrantsPerArchitecture", value)} />
          </div>
          <label><span>Revision reason</span><Textarea aria-label="Policy revision reason" disabled={state === "saving"} onChange={(event) => setReason(event.target.value)} placeholder="Why this policy change is needed" value={reason} /></label>
          {!pendingAppend ? <Button className="shadcn-action-button people-start" disabled={state === "saving"} size="sm" type="submit"><Plus size={15} aria-hidden="true" />Review append and activate</Button> : <div className="control-plane-inline-message people-confirm-strip" role="alert"><span>Confirm this immutable revision. The API will report whether it becomes the current policy immediately.</span><div className="people-form-actions"><Button className="shadcn-action-button" disabled={state === "saving"} size="sm" type="button" variant="outline" onClick={cancelAppendPolicy}>Cancel</Button><Button className="shadcn-action-button" disabled={state === "saving"} size="sm" type="button" onClick={() => void commitAppendPolicy()}>{state === "saving" ? "Saving…" : "Confirm append and activate"}</Button></div></div>}
        </form>
      )}
      {!canManage && <p className="registry-muted">Only the organization owner can append or activate policy revisions.</p>}
      {message && <div className="people-status" data-tone={state === "error" ? "danger" : undefined} role={state === "error" ? "alert" : "status"}><span>{message}</span>{state === "error" && <Button size="sm" type="button" variant="outline" onClick={() => pendingActivation ? void commitActivatePolicy(pendingActivation) : void commitAppendPolicy()}>Retry</Button>}</div>}
    </section>
  );
}

function PolicyCheckbox({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return <label className="control-plane-checkbox"><input checked={checked} disabled={disabled} type="checkbox" onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
}

function PolicyLimit({ label, value, disabled, onChange }: { label: string; value: number; disabled: boolean; onChange: (value: string) => void }) {
  return <label><span>{label}</span><Input aria-label={label} disabled={disabled} min={1} onChange={(event) => onChange(event.target.value)} type="number" value={value} /></label>;
}

function OrganizationTeamsPanel({ client, detail, teams, canAdmin, onChanged }: { client: RegistryClient; detail: OrganizationDetail; teams: TeamRecord[]; canAdmin: boolean; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [teamId, setTeamId] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [pendingAdoption, setPendingAdoption] = useState(false);
  const baseId = useId();
  const canCreateTeam = canAdmin || detail.currentPolicy?.policy.teams.membersCanCreateTeams === true;

  async function submitCreateTeam() {
    if (!client.createOrganizationTeam || !name.trim()) return;
    setState("saving");
    setMessage(null);
    try {
      await client.createOrganizationTeam({ organizationId: detail.id, name: name.trim() });
      setName("");
      setState("idle");
      onChanged();
    } catch (error) {
      setState("error");
      setMessage(safeOrganizationErrorMessage(error));
    }
  }

  function createTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitCreateTeam();
  }

  async function submitAdoptTeam() {
    if (!client.adoptTeamToOrganization || !teamId.trim()) return;
    setState("saving");
    setMessage(null);
    try {
      await client.adoptTeamToOrganization(teamId.trim(), detail.id);
      setTeamId("");
      setPendingAdoption(false);
      setState("idle");
      onChanged();
    } catch (error) {
      setState("error");
      setMessage(safeOrganizationErrorMessage(error));
    }
  }

  function adoptTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingAdoption) {
      setPendingAdoption(true);
      setMessage("Review this team adoption before changing the organization boundary.");
      return;
    }
    void submitAdoptTeam();
  }

  function cancelAdoption() {
    setPendingAdoption(false);
    setState("idle");
    setMessage(null);
  }

  return <section aria-labelledby={`${baseId}-heading`} className="registry-section">
    <div className="people-section-head"><h3 id={`${baseId}-heading`}>Child teams</h3></div>
    {teams.length > 0 && <ul className="people-list">{teams.map((team) => <li key={team.id}><span className="people-person"><strong>{team.name}</strong><small><code>{team.slug}</code> · {team.members.length === 1 ? "1 member" : `${team.members.length} members`}</small></span><span className="registry-chip">{humanize(team.role)}</span></li>)}</ul>}
    {teams.length === 0 && <p className="registry-muted">No child teams are visible in this organization.</p>}
    <p className="registry-muted">Child-team membership is resolved against this organization. A standalone team is not an organization member until it is explicitly adopted.</p>
    {(canCreateTeam || canAdmin) && <div className="organization-team-actions">{canCreateTeam && <form className="organization-inline-form" onSubmit={(event) => void createTeam(event)}><Input aria-label="Child team name" disabled={state === "saving"} onChange={(event) => setName(event.target.value)} placeholder="Team name" value={name} /><Button className="shadcn-action-button" disabled={state === "saving" || !name.trim()} size="sm" type="submit"><Plus size={15} aria-hidden="true" />Create child team</Button></form>}{canAdmin && <form className="organization-inline-form" onSubmit={(event) => void adoptTeam(event)}><Input aria-label="Standalone team ID" disabled={state === "saving" || pendingAdoption} onChange={(event) => setTeamId(event.target.value)} placeholder="Standalone team ID" value={teamId} /><Button className="shadcn-action-button" disabled={state === "saving" || !teamId.trim() || pendingAdoption} size="sm" type="submit" variant="outline"><GitBranch size={15} aria-hidden="true" />Adopt team</Button></form>}</div>}
    {!canAdmin && canCreateTeam && <p className="registry-muted">Your current organization policy allows members to create child teams.</p>}
    {message && <div className="control-plane-inline-message" role={state === "error" ? "alert" : "status"}><span>{message}</span>{state === "error" && <Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => pendingAdoption ? void submitAdoptTeam() : void submitCreateTeam()}>Retry</Button>}</div>}
    {pendingAdoption && <div className="control-plane-inline-message people-confirm-strip" role="alert"><span>Adopting this team changes its effective organization membership and policy boundary.</span><div className="people-form-actions"><Button className="shadcn-action-button" disabled={state === "saving"} size="sm" type="button" variant="outline" onClick={cancelAdoption}>Cancel</Button><Button className="shadcn-action-button" disabled={state === "saving"} size="sm" type="button" onClick={() => void submitAdoptTeam()}>Confirm adopt team</Button></div></div>}
  </section>;
}

function PendingOrganizationInvitations({ client, invitations, onAccepted }: { client: RegistryClient; invitations: OrganizationInvitationRecord[]; onAccepted: () => void }) {
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [pendingInvitationId, setPendingInvitationId] = useState<string | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const focusStatus = useRef(false);
  const baseId = useId();
  useEffect(() => {
    if (!focusStatus.current || !statusRef.current) return;
    focusStatus.current = false;
    statusRef.current.focus();
  });
  async function accept(invitation: OrganizationInvitationRecord) {
    if (!client.acceptOrganizationInvitation) return;
    setState("saving");
    setPendingInvitationId(invitation.id);
    setMessage(null);
    try {
      await client.acceptOrganizationInvitation(invitation.id);
      setState("idle");
      setPendingInvitationId(null);
      setMessage(`Invitation from ${invitation.organizationName} accepted.`);
      focusStatus.current = true;
      onAccepted();
    } catch (error) {
      setState("error");
      setMessage(safeOrganizationErrorMessage(error));
    }
  }
  const pendingInvitation = pendingInvitationId ? invitations.find((invitation) => invitation.id === pendingInvitationId) : undefined;
  if (invitations.length === 0 && !message) return null;
  return (
    <section aria-labelledby={`${baseId}-heading`} className="people-invitations">
      <h2 id={`${baseId}-heading`}>Invitations for you</h2>
      {invitations.length > 0 && (
        <ul>
          {invitations.map((invitation) => (
            <li key={invitation.id}>
              <span className="people-person">
                <strong id={`${baseId}-${invitation.id}`}>{invitation.organizationName}</strong>
                <small>{humanize(invitation.role)} · {invitation.email} · Sent {formatControlPlaneDate(invitation.createdAt)}</small>
              </span>
              <Button aria-describedby={`${baseId}-${invitation.id}`} disabled={state === "saving"} size="sm" type="button" onClick={() => void accept(invitation)}>
                <Check size={15} aria-hidden="true" />
                {state === "saving" && pendingInvitationId === invitation.id ? "Accepting…" : "Accept"}
              </Button>
              {state === "error" && message && pendingInvitationId === invitation.id && (
                <div className="people-status" data-tone="danger" role="alert"><span>{message}</span>{pendingInvitation && <Button size="sm" type="button" variant="outline" onClick={() => void accept(pendingInvitation)}><RefreshCw size={15} aria-hidden="true" /> Retry</Button>}</div>
              )}
            </li>
          ))}
        </ul>
      )}
      {state !== "error" && message && <p className="people-status" data-tone="teal" ref={statusRef} role="status" tabIndex={-1}>{message}</p>}
    </section>
  );
}

function ArchiveOrganizationButton({ client, organizationId, organizationName, onArchived }: { client: RegistryClient; organizationId: string; organizationName: string; onArchived: () => void }) {
  const [confirm, setConfirm] = useState(false);
  async function archive() {
    if (!client.archiveOrganization) throw new Error("Organization archiving is unavailable.");
    try {
      await client.archiveOrganization(organizationId);
      onArchived();
    } catch (error) {
      throw new Error(safeOrganizationErrorMessage(error));
    }
  }
  return <>
    <Button className="people-danger" size="sm" type="button" variant="outline" onClick={() => setConfirm(true)}><Archive size={15} aria-hidden="true" />Archive</Button>
    {confirm && <ConfirmationDialog request={{
      key: `archive-${organizationId}`,
      title: `Archive ${organizationName}?`,
      description: `${organizationName} will be marked archived. Access through its child teams stops, and it no longer acts as an active sharing boundary. Member, team and policy records are kept. MySkills has no restore action for archived organizations.`,
      confirmLabel: "Archive organization",
      destructive: true,
      onConfirm: archive,
    }} onClose={() => setConfirm(false)} />}
  </>;
}

function PeopleSkeleton({ detail, label }: { detail?: boolean; label: string }) {
  return (
    <div className={detail ? "registry-skeleton registry-skeleton-detail" : "registry-skeleton"} role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {detail
        ? <><div className="registry-skeleton-head"><span /><span /></div><span className="registry-skeleton-line" /><span className="registry-skeleton-line" /><span className="registry-skeleton-block" /></>
        : [0, 1, 2].map((item) => <div className="registry-skeleton-row" key={item}><span /><span /></div>)}
    </div>
  );
}

function findRow(root: HTMLElement | null, id: string): HTMLElement | null {
  for (const element of root?.querySelectorAll<HTMLElement>("[data-row-id]") ?? []) {
    if (element.dataset.rowId === id) return element;
  }
  return null;
}

function findRole(root: HTMLElement | null, userId: string): HTMLElement | null {
  for (const element of root?.querySelectorAll<HTMLElement>("select[data-user-id]") ?? []) {
    if (element.dataset.userId === userId) return element;
  }
  return null;
}

function clonePolicy(policy: OrganizationPolicyV1): OrganizationPolicyV1 {
  return {
    schemaVersion: policy.schemaVersion,
    sharing: { ...policy.sharing },
    teams: { ...policy.teams },
    limits: { ...policy.limits },
  };
}

function formatControlPlaneDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown date" : parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
