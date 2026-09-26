import { useEffect, useRef, useState } from "react";
import type { PublicSkill } from "@myskills-app/core";
import type { RegistryClient, ReleaseMetadata, WebAuthUser } from "../../api";
import type { DeclarationRevision, ImprovementCompatibility, ImprovementPlanRecord, ImprovementPolicyRevision, ImprovementPreview, ImprovementReviewerPin, ImprovementScope, OptimizationDeclaration, OptimizationTarget } from "../../improvement-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

type ScopeChoice = ImprovementScope & { name: string; writable: boolean };
const emptyDeclaration: OptimizationDeclaration = { schemaVersion: 1, intent: "unspecified", targets: [], objectives: ["task-success"], limitations: [] };
const messageOf = (error: unknown) => error instanceof Error ? error.message : "The request could not be completed.";

export function SkillImprovementPanel({ client, release, user, canManage, visibility }: { client: RegistryClient; release: ReleaseMetadata; user: WebAuthUser | null; canManage: boolean; visibility: PublicSkill["visibility"] }) {
  const api = client.improvements;
  const [compatibility, setCompatibility] = useState<ImprovementCompatibility | null>(null);
  const [loadError, setLoadError] = useState("");
  const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [declaration, setDeclaration] = useState<OptimizationDeclaration>(emptyDeclaration);
  const [pendingEvidence, setPendingEvidence] = useState<{ id: string; subject: string; sha256: string; provenance: string; summary: unknown } | null>(null);

  useEffect(() => {
    let active = true;
    if (!api) return;
    void api.compatibility(release.slug, release.version).then((result) => {
      if (!active) return;
      setCompatibility(result); setLoadError("");
      setDeclaration(result.attestation.revision?.declaration ?? result.declaration.revision?.declaration ?? emptyDeclaration);
    }).catch((error: unknown) => { if (active) setLoadError(messageOf(error)); });
    return () => { active = false; };
  }, [api, release.slug, release.version, revision]);

  async function action(work: () => Promise<void>, success: string) {
    setBusy(true); setMessage("");
    try { await work(); setMessage(success); setRevision((r) => r + 1); }
    catch (error) { setMessage(messageOf(error)); }
    finally { setBusy(false); }
  }
  function patchTarget(index: number, patch: Partial<OptimizationTarget>) {
    setDeclaration((d) => ({ ...d, targets: d.targets.map((target, i) => i === index ? { ...target, ...patch } : target) }));
  }
  const revisions = [compatibility?.declaration.revision, compatibility?.attestation.revision, ...(compatibility?.manage?.pendingRevisions ?? [])].filter((r): r is DeclarationRevision => Boolean(r));
  const expectedRevisionNumber = Math.max(0, ...revisions.map((r) => r.revisionNumber));
  const canReview = Boolean(user?.mfaVerified && user.roles.some((r) => ["owner", "admin", "maintainer"].includes(r)));
  const current = compatibility?.attestation.revision ?? compatibility?.declaration.revision;
  if (!api) return null;
  return <section className="control-plane-section skill-improvement-panel" aria-label="Skill improvement">
    <div className="control-plane-section-heading"><div><p className="control-plane-kicker">Compatibility and evidence</p><h2>Skill improvement</h2></div><Badge variant="outline">{current?.declaration.intent ?? "unspecified"}</Badge></div>
    {loadError ? <p role="alert">Improvement metadata unavailable: {loadError}</p> : !compatibility ? <p role="status">Loading improvement metadata…</p> : <>
      <h3>Designed for</h3>
      {!current ? <p>No optimisation targets declared.</p> : <>
        <p>{current.declaration.intent === "portable" ? "Designed to be portable. Compatibility still needs testing in your environment." : current.declaration.intent === "unspecified" ? "No optimisation targets declared." : "The author declared these targets. A declaration is not evaluation evidence."}</p>
        {current.declaration.targets.map((target) => <div key={target.id}><strong>{target.id}</strong><p>{target.models?.map((m) => `${m.provider} / ${m.id}`).join(", ") || "Model not declared"} · {target.apps?.map((a) => `${a.id}${a.version ? ` ${a.version}` : ""}`).join(", ") || "App not declared"}</p>{target.environment?.os?.length ? <p>Environments: {target.environment.os.join(", ")}</p> : null}</div>)}
        {current.kind === "attestation" && <p className="control-plane-muted">Added after publication as a reviewed attestation.</p>}
        {current.declaration.limitations.map((text) => <p key={text}>{text}</p>)}
      </>}
      <h3>Tested on</h3>
      {compatibility.evidence.length === 0 ? <p>No accepted evaluation evidence.</p> : compatibility.evidence.map((e) => <div key={e.evidenceId} className="control-plane-inline-message"><strong>{e.profile.target.model.id} · {e.profile.target.app.id}</strong><p>{e.claim.replaceAll("-", " ")} · {e.provenance} · {e.relevance}</p><small>Accepted {new Date(e.acceptedAt).toLocaleDateString()}</small></div>)}
    </>}
    {user ? <Button type="button" variant="outline" onClick={() => setOpen((value) => !value)}>{open ? "Close improvement planner" : "Plan an improvement"}</Button> : <p><a href="/login">Sign in</a> to select reviewers and prepare a local run.</p>}
    {open && user && <ImprovementPlanner key={`${release.slug}:${release.version}`} client={client} release={release} user={user} visibility={visibility} />}
    {canManage && user && <details className="improvement-editor"><summary>Manage optimisation metadata</summary>
      <p>Declarations describe intent. Changes to a published release become separate attestations and require review.</p>
      <label>Optimisation intent<select disabled={busy} value={declaration.intent} onChange={(e) => setDeclaration({ ...declaration, intent: e.target.value as OptimizationDeclaration["intent"], targets: e.target.value === "targeted" && declaration.targets.length === 0 ? [{ id: "primary" }] : declaration.targets })}><option value="unspecified">Unspecified</option><option value="portable">Portable</option><option value="targeted">Specific target</option></select></label>
      {declaration.intent === "targeted" && <>
        {declaration.targets.map((target, index) => <fieldset key={index} disabled={busy} className="improvement-target">
          <legend>Target {index + 1}</legend>
          <div className="improvement-fields">
            <label>Target name<Input value={target.id} onChange={(e) => patchTarget(index, { id: e.target.value })} /></label>
            <label>Designed-for provider<Input value={target.models?.[0]?.provider ?? ""} placeholder="openai, anthropic, or another provider" onChange={(e) => patchTarget(index, { models: [{ provider: e.target.value, id: target.models?.[0]?.id ?? "" }, ...(target.models?.slice(1) ?? [])] })} /></label>
            <label>Designed-for model<Input value={target.models?.[0]?.id ?? ""} placeholder="Optional exact model identifier" onChange={(e) => patchTarget(index, { models: e.target.value ? [{ provider: target.models?.[0]?.provider ?? "", id: e.target.value }, ...(target.models?.slice(1) ?? [])] : target.models?.slice(1) })} /></label>
            <label>Designed-for app<Input value={target.apps?.[0]?.id ?? ""} placeholder="Optional app identifier" onChange={(e) => patchTarget(index, { apps: e.target.value ? [{ ...target.apps?.[0], id: e.target.value }, ...(target.apps?.slice(1) ?? [])] : target.apps?.slice(1) })} /></label>
            <label>App version<Input value={target.apps?.[0]?.version ?? ""} disabled={!target.apps?.[0]?.id} placeholder="Optional exact version" onChange={(e) => patchTarget(index, { apps: [{ id: target.apps![0].id, ...(e.target.value ? { version: e.target.value } : {}) }, ...(target.apps?.slice(1) ?? [])] })} /></label>
            <label>Operating systems<Input value={target.environment?.os?.join(", ") ?? ""} placeholder="macos, linux, windows" onChange={(e) => patchTarget(index, { environment: { ...target.environment, os: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } })} /></label>
            <label>Required capabilities<Input value={target.environment?.requiredCapabilities?.join(", ") ?? ""} placeholder="Optional comma-separated identifiers" onChange={(e) => patchTarget(index, { environment: { ...target.environment, requiredCapabilities: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } })} /></label>
            <label>Network requirement<select value={target.environment?.network ?? ""} onChange={(e) => patchTarget(index, { environment: { ...target.environment, network: e.target.value || undefined } })}><option value="">Not declared</option><option value="optional">Optional</option><option value="required">Required</option><option value="none">None</option></select></label>
          </div>
          <Button type="button" variant="outline" onClick={() => setDeclaration((d) => ({ ...d, targets: d.targets.filter((_, i) => i !== index) }))}>Remove target {index + 1}</Button>
        </fieldset>)}
        <Button type="button" variant="outline" disabled={busy || declaration.targets.length >= 16} onClick={() => setDeclaration((d) => ({ ...d, targets: [...d.targets, { id: `target-${d.targets.length + 1}` }] }))}>Add target</Button>
      </>}
      <label>Limitations<Textarea value={declaration.limitations.join("\n")} onChange={(e) => setDeclaration({ ...declaration, limitations: e.target.value.split("\n").filter(Boolean) })} /></label>
      <Button type="button" disabled={busy || !compatibility || (declaration.intent === "targeted" && declaration.targets.length === 0)} onClick={() => void action(async () => {
        await api.declare(release.slug, release.version, { declaration: { ...declaration, targets: declaration.intent === "unspecified" ? [] : declaration.targets }, expectedRevisionNumber });
      }, "Metadata submitted for review.")}>Submit metadata for review</Button>
      {compatibility?.manage?.pendingRevisions.map((r) => <div key={r.id}><p>Pending {r.kind} revision {r.revisionNumber}: {r.declaration.intent}</p><pre className="improvement-json">{JSON.stringify(r.declaration, null, 2)}</pre>{canReview && <div className="improvement-actions">{(["approve", "reject"] as const).map((decision) => <Button key={decision} variant="outline" type="button" disabled={busy} onClick={() => void action(() => api.reviewDeclaration(release.slug, release.version, r.id, { decision, artifactSha256: release.artifact.sha256, declarationSha256: r.declarationSha256 }), `Metadata ${decision === "approve" ? "approved" : "rejected"}.`)}>{decision === "approve" ? "Approve metadata" : "Reject metadata"}</Button>)}</div>}</div>)}
      {compatibility?.manage?.evidenceProposals.map((proposal) => <Button key={`${proposal.evidenceId}:${proposal.subject}`} variant="outline" disabled={busy} onClick={() => void action(async () => { const e = await api.evidence(proposal.evidenceId); setPendingEvidence({ id: proposal.evidenceId, subject: proposal.subject, sha256: e.evidenceSha256, provenance: e.provenance, summary: e.summary }); }, "Evidence loaded for review.")}>Review {proposal.subject} evidence</Button>)}
      {pendingEvidence && <div><p>Reported provenance: {pendingEvidence.provenance}</p><pre className="improvement-json">{JSON.stringify(pendingEvidence.summary, null, 2)}</pre><p>Acceptance attaches this exact evidence revision. It does not increase its provenance.</p>{user.mfaVerified && <div className="improvement-actions">{(["accept", "reject"] as const).map((decision) => <Button key={decision} type="button" variant="outline" disabled={busy} onClick={() => void action(async () => { await api.acceptEvidence(pendingEvidence.id, { slug: release.slug, version: release.version, subject: pendingEvidence.subject, evidenceSha256: pendingEvidence.sha256, decision }); setPendingEvidence(null); }, `Evidence ${decision === "accept" ? "accepted" : "rejected"}.`)}>{decision === "accept" ? "Accept evidence" : "Reject evidence"}</Button>)}</div>}</div>}
    </details>}
    {message && <p role="status">{message}</p>}
  </section>;
}

function ImprovementPlanner({ client, release, user, visibility }: { client: RegistryClient; release: ReleaseMetadata; user: WebAuthUser; visibility: PublicSkill["visibility"] }) {
  const api = client.improvements!;
  const [scopes, setScopes] = useState<ScopeChoice[]>([{ type: "user", id: user.id, name: "Personal", writable: true }]);
  const [scopeKey, setScopeKey] = useState(`user:${user.id}`);
  const [skills, setSkills] = useState<PublicSkill[]>([]);
  const [reviewer, setReviewer] = useState("");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("openai");
  const [appVersion, setAppVersion] = useState("");
  const [goal, setGoal] = useState("");
  const [candidateVersion, setCandidateVersion] = useState("");
  const [maxCalls, setMaxCalls] = useState(21);
  const [policy, setPolicy] = useState<ImprovementPolicyRevision | null>(null);
  const [policyLoaded, setPolicyLoaded] = useState(false);
  const [cloudAllowed, setCloudAllowed] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [preview, setPreview] = useState<ImprovementPreview | null>(null);
  const [request, setRequest] = useState<Record<string, unknown> | null>(null);
  const [plan, setPlan] = useState<ImprovementPlanRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const profileCache = useRef(new Map<string, string>());
  const scope = scopes.find((s) => `${s.type}:${s.id}` === scopeKey)!;

  useEffect(() => {
    let active = true;
    void Promise.allSettled([client.searchSkills(""), client.listTeams(), client.listOrganizations?.() ?? Promise.resolve([])]).then(([found, teams, organizations]) => {
      if (!active) return;
      if (found.status === "fulfilled") setSkills(found.value.filter((s) => s.slug !== release.slug));
      else setMessage("Reviewer skills could not be loaded. Try reopening the planner.");
      setScopes([{ type: "user", id: user.id, name: "Personal", writable: true },
        ...(teams.status === "fulfilled" ? teams.value.teams.map((t): ScopeChoice => ({ type: "team", id: t.id, name: t.name, writable: t.role === "owner" && user.mfaVerified })) : []),
        ...(organizations.status === "fulfilled" ? organizations.value.map((o): ScopeChoice => ({ type: "organization", id: o.id, name: o.name, writable: ["admin", "owner"].includes(o.role) && user.mfaVerified })) : [])]);
    });
    return () => { active = false; };
  }, [client, release.slug, user.id, user.mfaVerified]);
  useEffect(() => {
    let active = true;
    setPolicyLoaded(false); setPreview(null); setRequest(null); setPlan(null);
    void api.policy(scope).then((r) => {
      if (!active) return;
      setPolicy(r); setPolicyLoaded(true); setCloudAllowed(r?.policy.inference?.routes?.includes("cloud") ?? true); setEnabled(r?.policy.enabled ?? true);
    }).catch((error: unknown) => { if (active) setMessage(messageOf(error)); });
    return () => { active = false; };
  }, [api, scopeKey]);
  function invalidate() { setPreview(null); setRequest(null); setPlan(null); }
  async function pin(): Promise<ImprovementReviewerPin> {
    const selected = skills.find((s) => s.slug === reviewer);
    if (!selected?.latestVersion) throw new Error("Choose an accessible reviewer skill.");
    const exact = await client.getRelease(selected.slug, selected.latestVersion);
    return { slug: selected.slug, version: exact.version, artifactSha256: exact.artifact.sha256, roles: ["analyze", "propose"] };
  }
  async function perform(work: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await work(); } catch (error) { setMessage(messageOf(error)); } finally { setBusy(false); }
  }
  async function previewPlan() {
    invalidate();
    const reviewerPin = await pin();
    const key = `${provider}:${model.trim()}:${appVersion.trim()}`;
    let profileRevisionId = profileCache.current.get(key);
    if (!profileRevisionId) {
      const profile = await api.createProfile({ type: "user", id: user.id }, { schemaVersion: 1, name: `${model.trim()} in Codex`, target: { model: { provider, id: model.trim() }, app: { id: "codex", version: appVersion.trim() }, environment: { os: [], requiredCapabilities: [], network: "optional" } }, settings: {}, objectives: ["task-success"], protectedRequirements: [] });
      profileRevisionId = profile.latest.id; profileCache.current.set(key, profileRevisionId);
    }
    const next = { schemaVersion: 1, context: { type: scope.type, id: scope.id }, source: { kind: "release", slug: release.slug, version: release.version, artifactSha256: release.artifact.sha256 }, reviewers: [reviewerPin], profileRevisionId, suiteRevisionId: null,
      goals: { objectives: ["task-success"], protectedRequirements: [goal.trim()] }, guidance: [], candidate: { maxCandidates: 1, identity: { slug: release.slug, version: candidateVersion.trim(), visibility, derivativeOf: null } },
      budget: { maxModelCalls: maxCalls, maxTokens: null, maxWallMinutes: 30 }, dataRoute: { inference: "cloud", provider, model: model.trim(), contextCategories: ["subject-package", "reviewer-packages", "profile"] }, resultSharing: "local-only", expiresInMinutes: 120 };
    setRequest(next); setPreview(await api.preview(next));
  }
  return <div className="improvement-planner">
    <h3>Prepare a local improvement run</h3>
    <p>Select the policy context, reviewer and target. Local execution can use cloud inference. The CLI shows the exact inputs and requires consent before dispatch.</p>
    <fieldset disabled={busy} className="improvement-fields improvement-inputs">
      <label>Policy context<select value={scopeKey} onChange={(e) => { setScopeKey(e.target.value); invalidate(); }}>{scopes.map((s) => <option key={`${s.type}:${s.id}`} value={`${s.type}:${s.id}`}>{s.name} ({s.type})</option>)}</select></label>
      <label>Reviewer skill<select value={reviewer} onChange={(e) => { setReviewer(e.target.value); invalidate(); }}><option value="">Choose a reviewer</option>{skills.map((s) => <option key={s.slug} value={s.slug}>{s.title} · {s.latestVersion}</option>)}</select></label>
      <label>Model provider<select value={provider} onChange={(e) => { setProvider(e.target.value); invalidate(); }}><option value="openai">OpenAI</option></select></label>
      <label>Target model<Input value={model} onChange={(e) => { setModel(e.target.value); invalidate(); }} placeholder="Exact model available in your Codex account" /></label>
      <label>Installed app version<Input value={appVersion} onChange={(e) => { setAppVersion(e.target.value); invalidate(); }} placeholder="Version reported by codex --version" /></label>
      <label>Candidate version<Input value={candidateVersion} onChange={(e) => { setCandidateVersion(e.target.value); invalidate(); }} placeholder="New version" /></label>
      <label>Maximum model calls<Input type="number" min={1} max={101} value={maxCalls} onChange={(e) => { setMaxCalls(Number(e.target.value)); invalidate(); }} /></label>
    </fieldset>
    <label>Improvement goal<Textarea value={goal} onChange={(e) => { setGoal(e.target.value); invalidate(); }} placeholder="State the behavior to improve and requirements to preserve." /></label>
    <p className="control-plane-muted">This browser plan produces a candidate with static findings. To compare performance, bind a local evaluation suite through the CLI. No improvement claim is made without paired evaluation.</p>
    <div className="improvement-actions"><Button type="button" variant="outline" disabled={busy || !policyLoaded || !reviewer || !model.trim() || !appVersion.trim() || !goal.trim() || !candidateVersion.trim()} onClick={() => void perform(previewPlan)}>Preview policy</Button><Button type="button" disabled={busy || preview?.effectivePolicy.status !== "allowed" || !request} onClick={() => void perform(async () => { if (request) setPlan(await api.createPlan(request, crypto.randomUUID())); })}>Prepare local run</Button></div>
    {preview && <div role="status"><p>{preview.effectivePolicy.status === "allowed" ? "The selected route is allowed by the current policy." : "The selected route is blocked."}</p>{[...preview.effectivePolicy.blockers, ...preview.effectivePolicy.warnings].map((b, i) => <p key={`${b.code}:${i}`}>{b.message}</p>)}</div>}
    {plan && <div className="command-panel"><p>Run this on the device where you want to work:</p><code style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>myskills improve fetch --plan {plan.id} --output ./improvement-job</code><p>Then inspect the plan and use its digest with <code>myskills improve run</code>. Expires {new Date(plan.expiresAt).toLocaleString()}.</p></div>}
    <details className="improvement-editor"><summary>Reviewer and execution policy</summary><p>Policy changes create a revision. Resource-owner restrictions still apply when you use personal context.</p>{policy?.policy.reviewers.length ? <ul>{policy.policy.reviewers.map((p) => <li key={`${p.slug}:${p.version}`}>{p.slug}@{p.version} · {p.roles.join(", ")}</li>)}</ul> : <p>No reviewers designated in this context.</p>}
      <label><input type="checkbox" checked={enabled} disabled={!scope.writable} onChange={(e) => setEnabled(e.target.checked)} /> Enable improvement runs</label>
      <label><input type="checkbox" checked={cloudAllowed} disabled={!scope.writable} onChange={(e) => setCloudAllowed(e.target.checked)} /> Allow cloud inference</label>
      <Button type="button" variant="outline" disabled={busy || !scope.writable || !policyLoaded || !reviewer} onClick={() => void perform(async () => {
        const p = await pin();
        const previous = policy?.policy;
        const saved = await api.savePolicy({ type: scope.type, id: scope.id }, { expectedRevisionNumber: policy?.revisionNumber ?? 0, policy: { ...(previous ?? { schemaVersion: 1 }), enabled, reviewers: [...(previous?.reviewers ?? []).filter((r) => r.slug !== p.slug), p], reviewerAllowlist: previous?.reviewerAllowlist ?? "designated", inference: { providers: previous?.inference?.providers ?? null, models: previous?.inference?.models ?? null, routes: cloudAllowed ? [...new Set([...(previous?.inference?.routes ?? ["on-device"]), "cloud"])] : (previous?.inference?.routes ?? ["on-device"]).filter((r) => r !== "cloud") } } });
        setPolicy(saved); invalidate(); setMessage("Reviewer policy saved. Preview the plan again.");
      })}>Designate reviewer and save policy</Button>
      {!scope.writable && <p>Only an owner or organization administrator with verified MFA can change this policy.</p>}
    </details>
    {message && <p role="status">{message}</p>}
  </div>;
}
