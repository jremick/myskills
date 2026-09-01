import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, RefreshCw, ShieldCheck, UsersRound, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { safeArchitectureErrorMessage, type ArchitectureOrganizationGrantsResult, type OrganizationListItem, type RegistryClient } from "../../api.js";

type GrantLoadState = "loading" | "ready" | "unavailable" | "error";
type GrantActionState = "idle" | "saving" | "error";

interface ArchitectureOrganizationGrantsCardProps {
  architectureId: string;
  currentRevisionId: string | null;
  client: RegistryClient;
  onSaved?: (result: ArchitectureOrganizationGrantsResult) => void;
}

/**
 * Manager-only organization sharing controls. Organization names and IDs come
 * from the organization endpoint; the browser never accepts a free-form ID.
 */
export function ArchitectureOrganizationGrantsCard({
  architectureId,
  currentRevisionId,
  client,
  onSaved,
}: ArchitectureOrganizationGrantsCardProps) {
  const [organizations, setOrganizations] = useState<OrganizationListItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [serverRevisionId, setServerRevisionId] = useState<string | null>(currentRevisionId);
  const [hiddenGrantCount, setHiddenGrantCount] = useState(0);
  const [loadState, setLoadState] = useState<GrantLoadState>("loading");
  const [actionState, setActionState] = useState<GrantActionState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [retryOrganizationIds, setRetryOrganizationIds] = useState<string[] | null>(null);
  const requestEpoch = useRef(0);

  useEffect(() => {
    const epoch = requestEpoch.current + 1;
    requestEpoch.current = epoch;
    setLoadState("loading");
    setActionState("idle");
    setMessage(null);
    setOrganizations([]);
    setSelectedIds([]);
    setSavedIds([]);
    setServerRevisionId(currentRevisionId);
    setHiddenGrantCount(0);
    setConfirmRevoke(false);
    setRetryOrganizationIds(null);

    if (!client.listOrganizations || !client.listArchitectureOrganizationGrants) {
      setLoadState("unavailable");
      return;
    }

    Promise.all([
      client.listOrganizations(),
      client.listArchitectureOrganizationGrants(architectureId),
    ]).then(([nextOrganizations, grants]) => {
      if (epoch !== requestEpoch.current) return;
      const organizationIds = [...new Set(grants.organizationIds)].sort((left, right) => left.localeCompare(right));
      const visibleIds = new Set(nextOrganizations.map((organization) => organization.id));
      const hidden = organizationIds.filter((id) => !visibleIds.has(id));
      setOrganizations(nextOrganizations.slice().sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)));
      setSelectedIds(organizationIds);
      setSavedIds(organizationIds);
      setServerRevisionId(grants.currentRevisionId ?? currentRevisionId);
      setHiddenGrantCount(hidden.length);
      setLoadState("ready");
    }).catch((error: unknown) => {
      if (epoch !== requestEpoch.current) return;
      setLoadState("error");
      setMessage(safeArchitectureErrorMessage(error));
    });

    return () => {
      requestEpoch.current += 1;
    };
  }, [architectureId, client, currentRevisionId, refreshNonce]);

  function toggleOrganization(organizationId: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = checked
        ? [...new Set([...current, organizationId])]
        : current.filter((id) => id !== organizationId);
      return next.sort((left, right) => left.localeCompare(right));
    });
    setActionState("idle");
    setMessage(null);
    setConfirmRevoke(false);
    setRetryOrganizationIds(null);
  }

  async function save(organizationIds: string[]) {
    if (!client.replaceArchitectureOrganizationGrants || loadState !== "ready") return;
    const normalizedOrganizationIds = [...new Set(organizationIds)].sort((left, right) => left.localeCompare(right));
    setRetryOrganizationIds(normalizedOrganizationIds);
    setActionState("saving");
    setMessage(null);
    try {
      const result = await client.replaceArchitectureOrganizationGrants(architectureId, {
        expectedCurrentRevisionId: serverRevisionId,
        organizationIds: normalizedOrganizationIds,
      });
      const nextIds = [...new Set(result.organizationIds)].sort((left, right) => left.localeCompare(right));
      setSelectedIds(nextIds);
      setSavedIds(nextIds);
      setServerRevisionId(result.currentRevisionId);
      setHiddenGrantCount(0);
      setRetryOrganizationIds(null);
      setConfirmRevoke(false);
      setActionState("idle");
      setMessage(nextIds.length === 0 ? "Organization access revoked for every organization." : "Organization access saved.");
      onSaved?.(result);
    } catch (error) {
      setActionState("error");
      setMessage(safeArchitectureErrorMessage(error));
    }
  }

  function requestRevokeAll() {
    setConfirmRevoke(true);
    setMessage(null);
  }

  function retryLoad() {
    setRefreshNonce((value) => value + 1);
  }

  const blockedByHiddenGrant = hiddenGrantCount > 0;
  const hasChanges = selectedIds.length !== savedIds.length || selectedIds.some((id, index) => id !== savedIds[index]);
  const canSave = loadState === "ready" && actionState !== "saving" && !blockedByHiddenGrant && Boolean(client.replaceArchitectureOrganizationGrants);

  return (
    <Card className="architecture-governance-card" aria-label="Organization architecture sharing">
      <CardHeader className="architecture-card-heading">
        <div className="architecture-card-heading-icon"><UsersRound size={17} aria-hidden="true" /></div>
        <div>
          <CardTitle>Organization sharing</CardTitle>
          <CardDescription>Share this immutable architecture with organizations you can already access. Sharing is read-only for organization members.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <div className="architecture-governance-note"><ShieldCheck size={15} aria-hidden="true" /> The API checks current membership, policy, release visibility, and the revision token before saving.</div>
        {loadState === "loading" && <div className="architecture-governance-status" role="status"><RefreshCw size={15} aria-hidden="true" /> Loading visible organizations…</div>}
        {loadState === "unavailable" && <div className="architecture-governance-status" role="status"><CircleAlert size={15} aria-hidden="true" /> Organization sharing is not available in this workspace yet.</div>}
        {loadState === "error" && message && <div className="architecture-inline-message" role="alert"><span>{message}</span><Button size="sm" type="button" variant="outline" onClick={retryLoad}><RefreshCw size={15} aria-hidden="true" /> Retry</Button></div>}
        {loadState === "ready" && organizations.length === 0 && (
          <div className="architecture-governance-status" role="status"><CircleAlert size={15} aria-hidden="true" /> No visible organizations are available for sharing.</div>
        )}
        {loadState === "ready" && organizations.length > 0 && (
          <fieldset className="architecture-organization-options" disabled={actionState === "saving"}>
            <legend>Visible organizations</legend>
            {organizations.map((organization) => {
              const checked = selectedIds.includes(organization.id);
              const inactive = organization.status !== "active";
              return (
                <label className="architecture-organization-option" key={organization.id}>
                  <input
                    aria-label={`Share with ${organization.name}`}
                    checked={checked}
                    disabled={inactive}
                    onChange={(event) => toggleOrganization(organization.id, event.target.checked)}
                    type="checkbox"
                  />
                  <span><strong>{organization.name}</strong><small>{organization.slug} · {inactive ? organization.status : `${organization.role} member`}</small></span>
                  <Badge variant={inactive ? "outline" : checked ? "secondary" : "outline"}>{inactive ? "Unavailable" : checked ? "Shared" : "Not shared"}</Badge>
                </label>
              );
            })}
          </fieldset>
        )}
        {blockedByHiddenGrant && <div className="architecture-governance-status" role="alert"><CircleAlert size={15} aria-hidden="true" /><span>Some existing grants are not visible through your organization list. Refresh before changing a partial set.</span><Button size="sm" type="button" variant="outline" onClick={retryLoad}><RefreshCw size={15} aria-hidden="true" /> Refresh</Button></div>}
        {message && actionState === "idle" && <div className="architecture-inline-message success" role="status">{message}</div>}
        {message && actionState === "error" && <div className="architecture-inline-message" role="alert"><span>{message}</span>{retryOrganizationIds && <Button size="sm" type="button" variant="outline" onClick={() => void save(retryOrganizationIds)}><RefreshCw size={15} aria-hidden="true" /> Retry</Button>}</div>}
        <div className="architecture-governance-actions">
          <Button disabled={!canSave || !hasChanges} size="sm" type="button" onClick={() => void save(selectedIds)}>
            <Check size={15} aria-hidden="true" /> {actionState === "saving" ? "Saving…" : "Save organization access"}
          </Button>
          {!confirmRevoke ? (
            <Button className="architecture-revoke-button" disabled={loadState !== "ready" || actionState === "saving" || !client.replaceArchitectureOrganizationGrants || selectedIds.length === 0} size="sm" type="button" variant="outline" onClick={requestRevokeAll}>
              <X size={15} aria-hidden="true" /> Revoke all
            </Button>
          ) : (
            <>
              <Button className="architecture-revoke-button" disabled={actionState === "saving"} size="sm" type="button" variant="destructive" onClick={() => void save([])}>
                <X size={15} aria-hidden="true" /> Confirm revoke all
              </Button>
              <Button disabled={actionState === "saving"} size="sm" type="button" variant="outline" onClick={() => setConfirmRevoke(false)}>Cancel</Button>
            </>
          )}
        </div>
        {confirmRevoke && <div className="architecture-governance-status" role="alert"><CircleAlert size={15} aria-hidden="true" /> This removes organization access for every visible organization. Hidden grants remain protected until the list is refreshed.</div>}
        <p className="architecture-governance-footnote">Current revision token: {serverRevisionId ? "present" : "empty architecture"}. Revoke all remains available for an empty shell.</p>
      </CardContent>
    </Card>
  );
}
