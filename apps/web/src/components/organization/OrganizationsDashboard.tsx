import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Archive,
  Check,
  CircleAlert,
  GitBranch,
  Mail,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserRound,
  UsersRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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

export function OrganizationsDashboard({ client, session }: { client: RegistryClient; session: OrganizationSession }) {
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
  const listEpoch = useRef(0);
  const detailEpoch = useRef(0);

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
      setOrganizations(nextOrganizations);
      setPendingInvitations(nextInvitations);
      setSelectedId((current) => current && nextOrganizations.some((item) => item.id === current)
        ? current
        : nextOrganizations[0]?.id ?? null);
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
      || !client.listOrganizationInvitations
      || !client.listOrganizationPolicies
      || !client.listOrganizationTeams
    ) {
      setDetailState("error");
      setDetailMessage("Organization detail is not available in this workspace yet.");
      return;
    }
    try {
      const [nextDetail, nextMembers, nextInvitations, nextPolicies, nextTeams] = await Promise.all([
        getOrganization(organizationId),
        client.listOrganizationMembers(organizationId),
        client.listOrganizationInvitations(organizationId),
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

  const selectOrganization = useCallback((id: string) => {
    if (id === selectedId) return;
    detailEpoch.current += 1;
    setDetail(null);
    setSelectedId(id);
  }, [selectedId]);

  return (
    <main className="control-plane-workspace organization-workspace" aria-label="Organizations">
      <section className="control-plane-hero" aria-labelledby="organizations-heading">
        <div>
          <p className="control-plane-kicker">Sharing boundaries</p>
          <h1 id="organizations-heading">Organizations</h1>
          <p>{session.user.email} · {state === "loading" ? "Refreshing organization access…" : `${organizations.length} organizations`}</p>
        </div>
        <Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => setRefreshKey((value) => value + 1)}>
          <RefreshCw size={16} aria-hidden="true" />
          Refresh
        </Button>
      </section>

      {message && <div className="safe-message control-plane-message" role={state === "error" ? "alert" : "status"}><span>{message}</span>{state === "error" && <Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw size={15} aria-hidden="true" /> Retry</Button>}</div>}

      <section className="organization-layout">
        <div className="organization-sidebar">
          <CreateOrganizationCard client={client} onCreated={(created) => {
            setSelectedId(created.id);
            setRefreshKey((value) => value + 1);
          }} />
          <Card className="control-plane-card" aria-label="Organization list">
            <CardHeader className="control-plane-card-heading">
              <div className="control-plane-card-icon"><UsersRound size={17} aria-hidden="true" /></div>
              <div>
                <CardTitle>Your organizations</CardTitle>
                <CardDescription>{organizations.length} visible sharing {organizations.length === 1 ? "boundary" : "boundaries"}</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="organization-list-content">
              {state === "loading" && <ControlPlaneLoadingRows label="Loading organizations…" />}
              {state === "error" && <OrganizationEmptyState icon={<CircleAlert size={22} aria-hidden="true" />} title="Organizations unavailable" copy="Retry when the organization service is ready." />}
              {state === "ready" && organizations.length === 0 && <OrganizationEmptyState icon={<UsersRound size={22} aria-hidden="true" />} title="No organizations yet" copy="Create an organization to manage shared skills, teams, and policy." />}
              {state === "ready" && organizations.length > 0 && (
                <div className="organization-list" role="list">
                  {organizations.map((organization) => (
                    <div key={organization.id} role="listitem">
                      <button
                        aria-current={organization.id === selectedId ? "true" : undefined}
                        aria-pressed={organization.id === selectedId}
                        className={organization.id === selectedId ? "organization-list-row selected" : "organization-list-row"}
                        type="button"
                        onClick={() => selectOrganization(organization.id)}
                      >
                        <span className="organization-list-icon"><GitBranch size={15} aria-hidden="true" /></span>
                        <span className="organization-list-main">
                          <strong>{organization.name}</strong>
                          <small>{organization.slug} · {organization.role}</small>
                        </span>
                        <Badge variant={organization.status === "active" ? "secondary" : "outline"}>{organization.status}</Badge>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <PendingOrganizationInvitations
            invitations={pendingInvitations}
            client={client}
            onAccepted={() => setRefreshKey((value) => value + 1)}
          />
        </div>

        <OrganizationDetailPanel
          client={client}
          detail={detail}
          detailState={detailState}
          message={detailMessage}
          members={members}
          invitations={invitations}
          policies={policies}
          teams={teams}
          onRefresh={() => selectedId && void refreshDetail(selectedId)}
        />
      </section>
    </main>
  );
}

function CreateOrganizationCard({ client, onCreated }: { client: RegistryClient; onCreated: (organization: OrganizationDetail) => void }) {
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

  return (
    <Card className="control-plane-card" aria-label="Create organization">
      <CardHeader className="control-plane-card-heading">
        <div className="control-plane-card-icon"><Plus size={17} aria-hidden="true" /></div>
        <div>
          <CardTitle>New organization</CardTitle>
          <CardDescription>Create a governed sharing boundary. Organization creation requires an MFA-verified owner session.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <form className="control-plane-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="new-organization-name"><span>Name</span><Input id="new-organization-name" aria-describedby={state === "error" && !name.trim() ? "new-organization-name-error" : undefined} aria-invalid={state === "error" && !name.trim()} aria-required="true" disabled={state === "saving"} onChange={(event) => setName(event.target.value)} placeholder="Acme skills" value={name} />{state === "error" && !name.trim() && <small id="new-organization-name-error" role="alert">Give the organization a name before creating it.</small>}</label>
          <label><span>Slug <small>(optional)</small></span><Input aria-label="Organization slug" disabled={state === "saving"} onChange={(event) => setSlug(event.target.value)} placeholder="acme-skills" value={slug} /></label>
          <label><span>Reason <small>(optional audit note)</small></span><Input aria-label="Organization creation reason" disabled={state === "saving"} onChange={(event) => setReason(event.target.value)} placeholder="Why this boundary exists" value={reason} /></label>
          {message && <div className="control-plane-inline-message" role={state === "error" ? "alert" : "status"}><span>{message}</span>{state === "error" && name.trim() && <Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => void create()}>Retry</Button>}</div>}
          <Button className="shadcn-action-button" disabled={state === "saving" || !name.trim()} size="sm" type="submit"><Plus size={15} aria-hidden="true" />{state === "saving" ? "Creating…" : "Create organization"}</Button>
        </form>
      </CardContent>
    </Card>
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
  onRefresh,
}: {
  client: RegistryClient;
  detail: OrganizationDetail | null;
  detailState: LoadState;
  message: string | null;
  members: OrganizationMembershipRecord[];
  invitations: OrganizationInvitationRecord[];
  policies: OrganizationPolicyRevisionRecord[];
  teams: TeamRecord[];
  onRefresh: () => void;
}) {
  if (!detail) {
    return (
      <Card className="control-plane-card organization-detail-card empty" aria-label="Organization detail">
        <CardContent className="control-plane-empty-detail">{detailState === "loading" ? <ControlPlaneLoadingRows label="Loading organization detail…" /> : detailState === "error" && message ? <div className="safe-message control-plane-message" role="alert"><span>{message}</span><Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={onRefresh}><RefreshCw size={15} aria-hidden="true" /> Retry</Button></div> : <><UsersRound size={42} aria-hidden="true" /><h2>Select an organization</h2><p>Choose a sharing boundary to manage members, policy revisions, and child teams.</p></>}</CardContent>
      </Card>
    );
  }

  const canAdmin = detail.role === "owner" || detail.role === "admin";
  const canManagePolicy = detail.role === "owner";
  return (
    <Card className="control-plane-card organization-detail-card" aria-label={`Organization detail: ${detail.name}`}>
      <CardHeader className="control-plane-detail-header">
        <div>
          <p className="control-plane-kicker">Organization detail</p>
          <CardTitle>{detail.name}</CardTitle>
          <CardDescription>{detail.slug} · {detail.status}</CardDescription>
          <p className="control-plane-context-note"><ShieldCheck size={15} aria-hidden="true" /> Organization is a sharing boundary. Personal, work, and team labels do not grant access.</p>
        </div>
        <div className="control-plane-detail-actions">
          <Badge variant={detail.status === "active" ? "secondary" : "outline"}>{detail.status}</Badge>
          <Badge variant="outline">{detail.role}</Badge>
          {canManagePolicy && <ArchiveOrganizationButton client={client} organizationId={detail.id} onArchived={onRefresh} />}
        </div>
      </CardHeader>
      <CardContent className="control-plane-detail-content">
        {detailState === "loading" && <ControlPlaneLoadingRows label="Loading organization detail…" />}
        {detailState === "error" && message && <div className="safe-message control-plane-message" role="alert">{message}<Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={onRefresh}><RefreshCw size={15} aria-hidden="true" /> Retry</Button></div>}
        {detailState === "ready" && (
          <>
            <OrganizationMembersPanel client={client} detail={detail} members={members} invitations={invitations} canAdmin={canAdmin} onChanged={onRefresh} />
            <OrganizationPolicyPanel client={client} detail={detail} policies={policies} canManage={canManagePolicy} onChanged={onRefresh} />
            <OrganizationTeamsPanel client={client} detail={detail} teams={teams} canAdmin={canAdmin} onChanged={onRefresh} />
          </>
        )}
      </CardContent>
    </Card>
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
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrganizationRole>("member");
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [pendingRoleChange, setPendingRoleChange] = useState<{ member: OrganizationMembershipRecord; nextRole: OrganizationRole } | null>(null);

  async function submitInvite() {
    if (!client.inviteOrganizationMember || !email.trim()) return;
    setState("saving");
    setMessage(null);
    try {
      await client.inviteOrganizationMember({ organizationId: detail.id, email: email.trim(), role });
      setEmail("");
      setRole("member");
      setState("idle");
      onChanged();
    } catch (error) {
      setState("error");
      setMessage(safeOrganizationErrorMessage(error));
    }
  }

  function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitInvite();
  }

  function requestRoleChange(member: OrganizationMembershipRecord, nextRole: OrganizationRole) {
    if (!client.updateOrganizationMemberRole || nextRole === member.role) return;
    setPendingRoleChange({ member, nextRole });
    setMessage(null);
  }

  function cancelRoleChange() {
    setPendingRoleChange(null);
    setState("idle");
    setMessage(null);
  }

  async function confirmRoleChange() {
    if (!client.updateOrganizationMemberRole || !pendingRoleChange) return;
    setState("saving");
    setMessage(null);
    try {
      await client.updateOrganizationMemberRole({ organizationId: detail.id, memberId: pendingRoleChange.member.userId, role: pendingRoleChange.nextRole });
      setPendingRoleChange(null);
      setState("idle");
      onChanged();
    } catch (error) {
      setState("error");
      setMessage(safeOrganizationErrorMessage(error));
    }
  }

  async function confirmRemoveMember(member: OrganizationMembershipRecord) {
    if (!client.removeOrganizationMember) return;
    setState("saving");
    setMessage(null);
    try {
      await client.removeOrganizationMember(detail.id, member.userId);
      setPendingRemoval(null);
      setState("idle");
      onChanged();
    } catch (error) {
      setState("error");
      setMessage(safeOrganizationErrorMessage(error));
    }
  }

  function removeMember(member: OrganizationMembershipRecord) {
    if (pendingRemoval !== member.userId) {
      setPendingRemoval(member.userId);
      setPendingRoleChange(null);
      return;
    }
    void confirmRemoveMember(member);
  }

  const pendingMember = pendingRemoval ? members.find((member) => member.userId === pendingRemoval) : undefined;

  return (
    <section className="control-plane-section" aria-labelledby="organization-members-heading">
      <div className="control-plane-section-heading"><div><p className="control-plane-kicker">Membership</p><h2 id="organization-members-heading">Members and invitations</h2></div><span>{members.length} members · {invitations.length} invitations</span></div>
      {canAdmin && <form className="organization-invite-form" onSubmit={(event) => void invite(event)}>
        <Input aria-label="Organization member email" disabled={state === "saving"} onChange={(event) => setEmail(event.target.value)} placeholder="collaborator@example.com" type="email" value={email} />
        <select aria-label="Organization invitation role" disabled={state === "saving"} onChange={(event) => setRole(event.target.value as OrganizationRole)} value={role}><option value="member">Member</option><option value="admin">Admin</option></select>
        <Button className="shadcn-action-button" disabled={state === "saving" || !email.trim()} size="sm" type="submit"><Mail size={15} aria-hidden="true" />Invite</Button>
      </form>}
      {!canAdmin && <p className="control-plane-muted">Only organization owners and admins can invite or manage members.</p>}
      {message && <div className="control-plane-inline-message" role={state === "error" ? "alert" : "status"}><span>{message}</span>{state === "error" && <Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => { if (pendingRoleChange) void confirmRoleChange(); else if (pendingMember) void confirmRemoveMember(pendingMember); else void submitInvite(); }}>Retry</Button>}</div>}
      <div className="organization-members-list">
        {members.map((member) => (
          <div className="organization-member-row" key={member.id}>
            <UserRound size={16} aria-hidden="true" />
            <span><strong>{member.name || member.email}</strong><small>{member.email}</small></span>
            {canAdmin ? <select aria-label={`Role for ${member.email}`} disabled={state === "saving" || Boolean(pendingRoleChange)} onChange={(event) => requestRoleChange(member, event.target.value as OrganizationRole)} value={member.role}><option value="member">Member</option><option value="admin">Admin</option><option value="owner">Owner</option></select> : <Badge variant="outline">{member.role}</Badge>}
            {canAdmin && <Button className="shadcn-action-button" disabled={state === "saving"} size="sm" type="button" variant={pendingRemoval === member.userId ? "destructive" : "outline"} onClick={() => void removeMember(member)}>{pendingRemoval === member.userId ? "Confirm remove" : "Remove"}</Button>}
            {pendingRoleChange?.member.userId === member.userId && <div className="control-plane-inline-message" role="alert"><span>Change {member.email} from {member.role} to {pendingRoleChange.nextRole}?</span><Button className="shadcn-action-button" disabled={state === "saving"} size="sm" type="button" onClick={() => void confirmRoleChange()}>Confirm role change</Button><Button className="shadcn-action-button" disabled={state === "saving"} size="sm" type="button" variant="outline" onClick={cancelRoleChange}>Cancel</Button></div>}
          </div>
        ))}
        {members.length === 0 && <p className="control-plane-muted">No active members were returned.</p>}
      </div>
      <div className="organization-invitations-list">
        {invitations.map((invitation) => <div className="organization-invitation-row" key={invitation.id}><Mail size={15} aria-hidden="true" /><span><strong>{invitation.email}</strong><small>{invitation.role} · {invitation.status}</small></span><Badge variant="outline">{invitation.status}</Badge></div>)}
        {invitations.length === 0 && <p className="control-plane-muted">No organization invitations.</p>}
      </div>
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
  const [pendingAppend, setPendingAppend] = useState(false);
  const [pendingActivation, setPendingActivation] = useState<OrganizationPolicyRevisionRecord | null>(null);

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

  return (
    <section className="control-plane-section" aria-labelledby="organization-policy-heading">
      <div className="control-plane-section-heading"><div><p className="control-plane-kicker">Immutable policy</p><h2 id="organization-policy-heading">Policy revisions</h2></div><span>{policies.length} revisions</span></div>
      <p className="control-plane-muted">Policy changes create immutable revisions. A new revision activates immediately when the API reports activation; the current pointer controls organization sharing and team boundaries.</p>
      <div className="organization-policy-history">
        {policies.map((revision) => {
          const current = revision.id === detail.currentPolicyRevisionId;
          return <div className="organization-policy-row" key={revision.id}><span><strong>Revision {revision.revisionNumber}{current ? " · Current" : ""}</strong><small>{revision.reason || "No audit note"} · {formatControlPlaneDate(revision.createdAt)}</small></span>{current ? <Badge variant="secondary">Active</Badge> : canManage ? pendingActivation?.id === revision.id ? <div className="control-plane-inline-message" role="alert"><span>Activate immutable policy revision {revision.revisionNumber}?</span><Button className="shadcn-action-button" disabled={state === "saving"} size="sm" type="button" onClick={() => void commitActivatePolicy(revision)}>{state === "saving" ? "Activating…" : "Confirm activate"}</Button><Button className="shadcn-action-button" disabled={state === "saving"} size="sm" type="button" variant="outline" onClick={cancelActivatePolicy}>Cancel</Button></div> : <Button className="shadcn-action-button" disabled={state === "saving" || Boolean(pendingActivation)} size="sm" type="button" variant="outline" onClick={() => requestActivatePolicy(revision)}><Check size={15} aria-hidden="true" />Activate</Button> : <Badge variant="outline">Inactive</Badge>}</div>;
        })}
        {policies.length === 0 && <p className="control-plane-muted">No policy revisions returned.</p>}
      </div>
      {canManage ? <form className="organization-policy-form" onSubmit={(event) => void appendPolicy(event)}>
        <div className="organization-policy-flags">
          <PolicyCheckbox label="Enable organization skill sharing" checked={draft.sharing.organizationSkillSharingEnabled} onChange={(value) => setFlag("sharing", "organizationSkillSharingEnabled", value)} />
          <PolicyCheckbox label="Enable organization architecture sharing" checked={draft.sharing.organizationArchitectureSharingEnabled} onChange={(value) => setFlag("sharing", "organizationArchitectureSharingEnabled", value)} />
          <PolicyCheckbox label="Let members share owned skills" checked={draft.sharing.membersCanShareOwnedSkillsToOrganization} onChange={(value) => setFlag("sharing", "membersCanShareOwnedSkillsToOrganization", value)} />
          <PolicyCheckbox label="Let team owners share architectures" checked={draft.sharing.teamOwnersCanShareArchitecturesToParentOrganization} onChange={(value) => setFlag("sharing", "teamOwnersCanShareArchitecturesToParentOrganization", value)} />
          <PolicyCheckbox label="Let members create child teams" checked={draft.teams.membersCanCreateTeams} onChange={(value) => setFlag("teams", "membersCanCreateTeams", value)} />
          <PolicyCheckbox label="Require organization membership for team members" checked={draft.teams.requireOrganizationMembershipForTeamMembers} onChange={(value) => setFlag("teams", "requireOrganizationMembershipForTeamMembers", value)} />
          <PolicyCheckbox label="Allow standalone team adoption" checked={draft.teams.allowStandaloneTeamAdoption} onChange={(value) => setFlag("teams", "allowStandaloneTeamAdoption", value)} />
        </div>
        <div className="organization-policy-limits">
          <PolicyLimit label="Teams per organization" value={draft.limits.teamsPerOrganization} onChange={(value) => setLimit("teamsPerOrganization", value)} />
          <PolicyLimit label="Members per organization" value={draft.limits.membersPerOrganization} onChange={(value) => setLimit("membersPerOrganization", value)} />
          <PolicyLimit label="Skill grants" value={draft.limits.organizationGrantsPerSkill} onChange={(value) => setLimit("organizationGrantsPerSkill", value)} />
          <PolicyLimit label="Architecture grants" value={draft.limits.organizationGrantsPerArchitecture} onChange={(value) => setLimit("organizationGrantsPerArchitecture", value)} />
        </div>
        <label><span>Revision reason</span><Textarea aria-label="Policy revision reason" disabled={state === "saving"} onChange={(event) => setReason(event.target.value)} placeholder="Why this policy change is needed" value={reason} /></label>
        {message && <div className="control-plane-inline-message" role={state === "error" ? "alert" : "status"}><span>{message}</span>{state === "error" && <Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => pendingActivation ? void commitActivatePolicy(pendingActivation) : void commitAppendPolicy()}>Retry</Button>}</div>}
        {!pendingAppend ? <Button className="shadcn-action-button" disabled={state === "saving"} size="sm" type="submit"><Plus size={15} aria-hidden="true" />Review append and activate</Button> : <div className="control-plane-inline-message" role="alert"><span>Confirm this immutable revision. The API will report whether it becomes the current policy immediately.</span><Button className="shadcn-action-button" disabled={state === "saving"} size="sm" type="button" onClick={() => void commitAppendPolicy()}>{state === "saving" ? "Saving…" : "Confirm append and activate"}</Button><Button className="shadcn-action-button" disabled={state === "saving"} size="sm" type="button" variant="outline" onClick={cancelAppendPolicy}>Cancel</Button></div>}
      </form> : <p className="control-plane-muted">Only the organization owner can append or activate policy revisions.</p>}
    </section>
  );
}

function PolicyCheckbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="control-plane-checkbox"><input checked={checked} type="checkbox" onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
}

function PolicyLimit({ label, value, onChange }: { label: string; value: number; onChange: (value: string) => void }) {
  return <label><span>{label}</span><Input aria-label={label} min={1} onChange={(event) => onChange(event.target.value)} type="number" value={value} /></label>;
}

function OrganizationTeamsPanel({ client, detail, teams, canAdmin, onChanged }: { client: RegistryClient; detail: OrganizationDetail; teams: TeamRecord[]; canAdmin: boolean; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [teamId, setTeamId] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [pendingAdoption, setPendingAdoption] = useState(false);
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

  return <section className="control-plane-section" aria-labelledby="organization-teams-heading">
    <div className="control-plane-section-heading"><div><p className="control-plane-kicker">Scoped teams</p><h2 id="organization-teams-heading">Child teams</h2></div><span>{teams.length} visible</span></div>
    <p className="control-plane-muted">Child-team membership is resolved against this organization. A standalone team is not an organization member until it is explicitly adopted.</p>
    {(canCreateTeam || canAdmin) && <div className="organization-team-actions">{canCreateTeam && <form className="organization-inline-form" onSubmit={(event) => void createTeam(event)}><Input aria-label="Child team name" disabled={state === "saving"} onChange={(event) => setName(event.target.value)} placeholder="Team name" value={name} /><Button className="shadcn-action-button" disabled={state === "saving" || !name.trim()} size="sm" type="submit"><Plus size={15} aria-hidden="true" />Create child team</Button></form>}{canAdmin && <form className="organization-inline-form" onSubmit={(event) => void adoptTeam(event)}><Input aria-label="Standalone team ID" disabled={state === "saving" || pendingAdoption} onChange={(event) => setTeamId(event.target.value)} placeholder="Standalone team ID" value={teamId} /><Button className="shadcn-action-button" disabled={state === "saving" || !teamId.trim() || pendingAdoption} size="sm" type="submit" variant="outline"><GitBranch size={15} aria-hidden="true" />Adopt team</Button></form>}</div>}
    {!canAdmin && canCreateTeam && <p className="control-plane-muted">Your current organization policy allows members to create child teams.</p>}
    {message && <div className="control-plane-inline-message" role={state === "error" ? "alert" : "status"}><span>{message}</span>{state === "error" && <Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => pendingAdoption ? void submitAdoptTeam() : void submitCreateTeam()}>Retry</Button>}</div>}
    {pendingAdoption && <div className="control-plane-inline-message" role="alert"><span>Adopting this team changes its effective organization membership and policy boundary.</span><Button className="shadcn-action-button" disabled={state === "saving"} size="sm" type="button" onClick={() => void submitAdoptTeam()}>Confirm adopt team</Button><Button className="shadcn-action-button" disabled={state === "saving"} size="sm" type="button" variant="outline" onClick={cancelAdoption}>Cancel</Button></div>}
    <div className="organization-team-list">{teams.map((team) => <div className="organization-team-row" key={team.id}><GitBranch size={16} aria-hidden="true" /><span><strong>{team.name}</strong><small>{team.slug} · {team.members.length} members</small></span><Badge variant="outline">{team.role}</Badge></div>)}{teams.length === 0 && <p className="control-plane-muted">No child teams are visible in this organization.</p>}</div>
  </section>;
}

function PendingOrganizationInvitations({ client, invitations, onAccepted }: { client: RegistryClient; invitations: OrganizationInvitationRecord[]; onAccepted: () => void }) {
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [pendingInvitationId, setPendingInvitationId] = useState<string | null>(null);
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
      onAccepted();
    } catch (error) {
      setState("error");
      setMessage(safeOrganizationErrorMessage(error));
    }
  }
  const pendingInvitation = pendingInvitationId ? invitations.find((invitation) => invitation.id === pendingInvitationId) : undefined;
  return <Card className="control-plane-card" aria-label="Pending organization invitations"><CardHeader className="control-plane-card-heading"><div className="control-plane-card-icon"><Mail size={17} aria-hidden="true" /></div><div><CardTitle>Pending invitations</CardTitle><CardDescription>Accept invitations addressed to this account.</CardDescription></div></CardHeader><CardContent><div className="organization-pending-list">{invitations.map((invitation) => <div className="organization-pending-row" key={invitation.id}><span><strong>{invitation.organizationName}</strong><small>{invitation.role} · {invitation.email}</small></span><Button className="shadcn-action-button" disabled={state === "saving"} size="sm" type="button" onClick={() => void accept(invitation)}><Check size={15} aria-hidden="true" />{state === "saving" && pendingInvitationId === invitation.id ? "Accepting…" : "Accept"}</Button></div>)}{invitations.length === 0 && <p className="control-plane-muted">No pending organization invitations.</p>}</div>{message && <div className="control-plane-inline-message" role={state === "error" ? "alert" : "status"}><span>{message}</span>{state === "error" && pendingInvitation && <Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => void accept(pendingInvitation)}><RefreshCw size={15} aria-hidden="true" /> Retry</Button>}</div>}</CardContent></Card>;
}

function ArchiveOrganizationButton({ client, organizationId, onArchived }: { client: RegistryClient; organizationId: string; onArchived: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function archive() {
    if (!client.archiveOrganization) return;
    if (!confirm) {
      setConfirm(true);
      return;
    }
    try {
      await client.archiveOrganization(organizationId);
      setConfirm(false);
      onArchived();
    } catch (error) {
      setMessage(safeOrganizationErrorMessage(error));
    }
  }
  function cancelArchive() {
    setConfirm(false);
    setMessage(null);
  }
  return <span className="control-plane-danger-action">{confirm && <span className="sr-only">Archiving this organization is permanent for active sharing and team membership.</span>}{message && <span className="control-plane-inline-message" role="alert">{message}<Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => void archive()}>Retry</Button></span>}<Button className="shadcn-action-button" size="sm" type="button" variant={confirm ? "destructive" : "outline"} onClick={() => void archive()}><Archive size={15} aria-hidden="true" />{confirm ? "Confirm archive" : "Archive"}</Button>{confirm && <Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={cancelArchive}>Cancel</Button>}</span>;
}

function OrganizationEmptyState({ icon, title, copy }: { icon: ReactNode; title: string; copy: string }) {
  return <div className="control-plane-empty-state">{icon}<strong>{title}</strong><span>{copy}</span></div>;
}

function ControlPlaneLoadingRows({ label }: { label: string }) {
  return <div className="control-plane-loading" role="status" aria-live="polite"><span className="sr-only">{label}</span><span /><span /><span className="short" /></div>;
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
