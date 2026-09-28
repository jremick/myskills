import { CircleAlert } from "lucide-react";
import type { ArchitectureEnvironment, ArchitectureProfile } from "../../api.js";
import type { OrganizationChoice } from "./architecture-dashboard-types.js";

/**
 * Preview context for the saved overview and the Workbench draft preview.
 * Only the visible surface renders it, so each labelled control is unique.
 */
export function ArchitectureContextSelectors({
  profiles,
  environments,
  selectedProfileId,
  selectedEnvironmentId,
  allowedOrganizationIds,
  organizationChoices,
  organizationOnly,
  selectedOrganizationId,
  onProfileChange,
  onEnvironmentChange,
  onOrganizationChange,
}: {
  profiles: ArchitectureProfile[];
  environments: ArchitectureEnvironment[];
  selectedProfileId: string;
  selectedEnvironmentId: string;
  allowedOrganizationIds: string[];
  organizationChoices: OrganizationChoice[];
  organizationOnly: boolean;
  selectedOrganizationId: string;
  onProfileChange: (value: string) => void;
  onEnvironmentChange: (value: string) => void;
  onOrganizationChange: (value: string) => void;
}) {
  if (!(profiles.length > 0 && environments.length > 0) && !(organizationOnly && allowedOrganizationIds.length > 0)) return null;
  return (
    <div className="architecture-context-bar" role="group" aria-label="Preview context">
      <span className="architecture-context-label" aria-hidden="true">Preview as</span>
      {profiles.length > 0 && (
        <select aria-label="Preview profile" onChange={(event) => onProfileChange(event.target.value)} value={selectedProfileId}>
          {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.scope}</option>)}
        </select>
      )}
      {environments.length > 0 && (
        <select aria-label="Preview environment" onChange={(event) => onEnvironmentChange(event.target.value)} value={selectedEnvironmentId}>
          {environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name}</option>)}
        </select>
      )}
      {allowedOrganizationIds.length > 0 && (
        <select aria-label="Preview organization" onChange={(event) => onOrganizationChange(event.target.value)} value={selectedOrganizationId}>
          {!organizationOnly && <option value="">Owner/team context</option>}
          {organizationOnly && <option value="">Choose an organization…</option>}
          {organizationChoices.map((organization) => <option key={organization.id} value={organization.id}>{organization.name} · {organization.slug}</option>)}
        </select>
      )}
      {organizationOnly && !selectedOrganizationId && (
        <span className="architecture-context-note" role="status"><CircleAlert size={15} aria-hidden="true" /> Select one authorized organization to preview this shared architecture.</span>
      )}
    </div>
  );
}
