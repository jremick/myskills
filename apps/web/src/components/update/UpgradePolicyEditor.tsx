import { useEffect, useRef, useState } from "react";
import type { SkillUpgradePolicyV1 } from "@myskills-app/core";
import { Button } from "@/components/ui/button";
import type { ArchitectureTargetRecord, RegistryClient, SkillUpgradePolicyRevisionRecord, TargetSkillUpdates } from "../../api.js";
import { safeArchitectureTargetErrorMessage } from "../../api.js";

const defaultPolicy: SkillUpgradePolicyV1 = {
  schemaVersion: 1,
  mode: "manual",
  includePrerelease: false,
  allowedChangeKinds: ["breaking", "feature", "fix", "maintenance", "security"],
  pins: {},
};

export function UpgradePolicyEditor({ client, target, resolved, onSaved }: {
  client: RegistryClient;
  target: ArchitectureTargetRecord;
  resolved: TargetSkillUpdates["policy"];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"target" | "organization">("target");
  const [revision, setRevision] = useState<SkillUpgradePolicyRevisionRecord | null>(null);
  const [policy, setPolicy] = useState<SkillUpgradePolicyV1>(defaultPolicy);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "saving" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const inheritedPolicy = useRef(resolved?.policy);
  const epoch = useRef(0);
  inheritedPolicy.current = resolved?.policy;
  const organizationId = target.owner.type === "organization" ? target.owner.id : null;

  useEffect(() => {
    epoch.current += 1;
    if (!open) return;
    let active = true;
    setState("loading");
    setMessage(null);
    setRevision(null);
    const request = scope === "target"
      ? client.getTargetSkillUpgradePolicy?.(target.id)
      : organizationId ? client.getOrganizationSkillUpgradePolicy?.(organizationId) : undefined;
    if (!request) {
      setState("error");
      setMessage("This policy cannot be loaded. Refresh before editing it.");
      return;
    }
    void request.then((record) => {
      if (!active) return;
      setRevision(record);
      // Organization edits must never inherit a single target's override.
      const source = record?.policy ?? (scope === "target" ? inheritedPolicy.current : undefined) ?? defaultPolicy;
      setPolicy(structuredClone(source));
      setState("ready");
    }).catch((error: unknown) => {
      if (!active) return;
      setState("error");
      setMessage(safeArchitectureTargetErrorMessage(error));
    });
    return () => { active = false; };
  }, [client, open, organizationId, scope, target.id]);

  async function save() {
    if (state !== "ready") return;
    const requestEpoch = epoch.current;
    setState("saving");
    setMessage(null);
    try {
      const input = { policy, expectedRevisionNumber: revision?.revisionNumber ?? 0, reason: "Update centre policy change" };
      const result = scope === "target"
        ? await client.updateTargetSkillUpgradePolicy?.(target.id, input)
        : organizationId ? await client.updateOrganizationSkillUpgradePolicy?.(organizationId, input) : undefined;
      if (!result) throw new Error("Policy editing is unavailable.");
      if (requestEpoch !== epoch.current) {
        onSaved();
        return;
      }
      setRevision(result.revision);
      setState("ready");
      setMessage(result.created ? `Saved ${scope} policy revision ${result.revision.revisionNumber}.` : "Policy is unchanged.");
      onSaved();
    } catch (error) {
      if (requestEpoch !== epoch.current) return;
      setState("error");
      setMessage(`${safeArchitectureTargetErrorMessage(error)} Close and reopen this policy to load its current revision.`);
    }
  }

  const editable = state === "ready";
  return <details className="target-advanced-settings" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Upgrade policy</summary>
    <div className="control-plane-form">
      <label><span>Scope</span><select aria-label="Upgrade policy scope" value={scope} disabled={state === "saving"} onChange={(event) => { setState("loading"); setScope(event.target.value as "target" | "organization"); }}><option value="target">This target</option>{organizationId && <option value="organization">Organization</option>}</select></label>
      {state === "loading" && <p role="status">Loading {scope} policy…</p>}
      {editable && <p className="control-plane-muted">Editing {scope === "organization" ? "the organization policy for all targets that inherit it" : "this target only"}. {revision ? `Revision ${revision.revisionNumber}.` : "Saving creates the first override for this scope."}</p>}
      <label className="control-plane-checkbox"><input type="checkbox" disabled={!editable} checked={policy.includePrerelease} onChange={(event) => setPolicy({ ...policy, includePrerelease: event.target.checked })} /><span><strong>Prerelease channel</strong><small>Include compatible prerelease versions.</small></span></label>
      <label><span>Execution mode</span><select disabled={!editable} value={policy.mode} onChange={(event) => setPolicy(event.target.value === "manual" ? { ...policy, mode: "manual", maintenanceWindow: undefined } : { ...policy, mode: "maintenance-window", maintenanceWindow: policy.maintenanceWindow ?? { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, daysOfWeek: [1, 2, 3, 4, 5], startMinute: 120, durationMinutes: 120 } })}><option value="manual">Manual</option><option value="maintenance-window">Maintenance window</option></select></label>
      {policy.mode === "maintenance-window" && policy.maintenanceWindow && <p className="control-plane-muted">Window: days {policy.maintenanceWindow.daysOfWeek.join(", ")} (0 is Sunday), starting {minuteLabel(policy.maintenanceWindow.startMinute)} for {policy.maintenanceWindow.durationMinutes} minutes in {policy.maintenanceWindow.timeZone}. The companion cannot claim queued work outside this window.</p>}
      {editable && <p className="control-plane-muted">Allowed changes: {policy.allowedChangeKinds.join(", ")}. Existing version pins: {Object.entries(policy.pins).map(([slug, version]) => `${slug} ${version}`).join(", ") || "none"}. These settings are preserved when saving.</p>}
      <Button size="sm" type="button" disabled={!editable} onClick={() => void save()}>{state === "saving" ? "Saving…" : "Save immutable policy revision"}</Button>
      {message && <div className="control-plane-inline-message" role={state === "error" ? "alert" : "status"}>{message}</div>}
    </div>
  </details>;
}

function minuteLabel(minute: number): string {
  return `${Math.floor(minute / 60).toString().padStart(2, "0")}:${(minute % 60).toString().padStart(2, "0")}`;
}
