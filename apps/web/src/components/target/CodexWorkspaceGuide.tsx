import { useEffect, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { safeArchitectureErrorMessage, type ArchitectureDetail, type ArchitectureSummary, type RegistryClient } from "../../api.js";

const project = "/absolute/existing/project with spaces";
const workspace = "/absolute/existing/workspace";
const globalSkills = "/absolute/existing/skills";
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
type Connection = "global" | "project" | "managed";

export function CodexWorkspaceGuide({ client, currentUserId, active, headingRef }: {
  client: RegistryClient;
  currentUserId: string;
  active: boolean;
  headingRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const [provider, setProvider] = useState<"codex" | "claude">("codex");
  const [connection, setConnection] = useState<Connection>("global");
  const [configProfile, setConfigProfile] = useState("work");
  const [architectures, setArchitectures] = useState<ArchitectureSummary[]>([]);
  const [architectureId, setArchitectureId] = useState("");
  const [detail, setDetail] = useState<ArchitectureDetail | null>(null);
  const [profileId, setProfileId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const selectedArchitecture = architectures.find((item) => item.id === architectureId) ?? architectures[0];
  const selectedId = selectedArchitecture?.id;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void client.listArchitectures().then((rows) => {
      if (cancelled) return;
      setArchitectures(rows.filter((item) => {
        const owner = item.owner ?? item.access?.owner;
        const personal = owner ? owner.type === "user" && owner.id === currentUserId : item.ownerUserId === currentUserId;
        return personal && item.access?.canManage === true;
      }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)));
      setLoading(false);
    }).catch((cause: unknown) => {
      if (cancelled) return;
      setArchitectures([]);
      setLoading(false);
      setError(safeArchitectureErrorMessage(cause));
    });
    return () => { cancelled = true; };
  }, [active, client, currentUserId, retry]);

  useEffect(() => {
    setDetail(null);
    if (!active || !selectedId) return;
    let cancelled = false;
    void client.getArchitecture(selectedId).then((next) => {
      if (!cancelled) setDetail(next);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(safeArchitectureErrorMessage(cause));
    });
    return () => { cancelled = true; };
  }, [active, client, retry, selectedId]);

  const revision = detail?.id === selectedId && detail?.latestRevision?.id === detail?.currentRevisionId ? detail?.latestRevision : null;
  const profiles = revision?.spec.profiles ?? [];
  const profile = profiles.find((item) => item.id === profileId) ?? profiles[0];
  const environments = (revision?.spec.environments ?? []).filter((item) => item.profileId === profile?.id);
  const environment = environments.find((item) => item.id === environmentId) ?? environments[0];
  const profileValid = configProfile === "" || /^[a-z0-9][a-z0-9_-]{0,63}$/.test(configProfile);
  const config = configProfile ? ` --config-profile ${quote(configProfile)}` : "";
  const command = (value: string) => `myskills ${value}${config}`;
  const ready = !loading && !error && profileValid && !!selectedId && !!profile && !!environment
    && [selectedId, profile.id, environment.id].every((id) => identifier.test(id));
  const binding = ready ? `--architecture-id ${quote(selectedId)} --environment-id ${quote(environment.id)} --profile-id ${quote(profile.id)}` : "";
  const location = connection === "global" ? `--root ${quote(globalSkills)}` : `--project ${quote(project)}`;
  const observe = `scopes observe --provider ${provider} --scope ${connection}${connection === "project" ? ` --project ${quote(project)}` : ""}`;
  const enrollment = ready ? [
    "npm install -g @jarel/myskills@beta",
    command("--version"),
    command(`config set api-url ${quote("https://registry-api.example.com")}`),
    command("login --method password"),
    connection === "managed" ? command(`codex enroll --workspace ${quote(workspace)} ${binding}`)
      : command(`scopes inventory --provider ${provider} --root ${quote(connection === "global" ? globalSkills : `${project}/${provider === "codex" ? ".agents" : ".claude"}/skills`)}`),
    ...(connection === "managed" ? [] : [command(`scopes enroll --provider ${provider} --scope ${connection} ${location} ${binding}`), command(`${observe} --upload`)]),
  ].join("\n") : "";

  async function copyCommands() {
    try {
      await navigator.clipboard.writeText(enrollment);
      setCopied(enrollment);
    } catch {
      setCopied("failed");
    }
  }

  return <section className="codex-workspace-guide control-plane-form" aria-label="Connect your skills">
    <div className="cp-title-block">
      <h2 ref={headingRef} tabIndex={-1}>Connect your skills</h2>
      <p className="cp-meta">Choose Codex or Claude, then connect an existing skills inventory or a managed Codex workspace.</p>
    </div>
    <div className="control-plane-form-grid">
      <label><span>Provider</span><select aria-label="Provider" value={provider} onChange={(event) => { setProvider(event.target.value as "codex" | "claude"); if (event.target.value === "claude" && connection === "managed") setConnection("project"); }}><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
      <label><span>Connection type</span><select aria-label="Connection type" value={connection} onChange={(event) => setConnection(event.target.value as Connection)}><option value="global">Global inventory</option><option value="project">Project inventory</option>{provider === "codex" && <option value="managed">Managed Codex workspace</option>}</select></label>
    </div>
    <p>{connection === "managed" ? "Install reviewed skills in one workspace, report managed files, and run approved updates locally." : connection === "global" ? "Inventory one explicit provider skills directory. MySkills uses this global scope when no project or exclusion matches." : `Inventory this project's ${provider === "codex" ? ".agents/skills" : ".claude/skills"} directory. The deepest matching project or exclusion controls MySkills ownership.`} {connection !== "managed" && "Inventory does not change native skill loading or inheritance and cannot install or update skills."}</p>
    <label><span>CLI configuration profile</span><Input aria-label="CLI configuration profile" aria-invalid={!profileValid} value={configProfile} placeholder="work" onChange={(event) => setConfigProfile(event.target.value)} /></label>
    <p className="cp-muted">A named profile such as <code>work</code> starts separate local registry, sign-in, and scope state. Leave blank to use your existing default state. This is separate from the architecture profile below; use the same <code>--config-profile</code> on every command.</p>
    {!profileValid && <p role="alert">Use 1–64 lowercase letters, digits, hyphens, or underscores, starting with a letter or digit.</p>}
    {loading ? <p role="status">Loading your architectures…</p> : error ? <div role="alert"><p>{error}</p><Button size="sm" type="button" variant="outline" onClick={() => setRetry((value) => value + 1)}>Retry setup</Button></div> : architectures.length === 0 ? <div><p>Create a personal architecture and save a revision before enrollment.</p><p>In the architecture editor, choose at least one reviewed registry skill that your account can read, then add a profile and its logical environment. An empty architecture cannot be enrolled.</p></div> : <>
      <label><span>Architecture</span><select aria-label="Setup architecture" value={selectedId ?? ""} onChange={(event) => { setArchitectureId(event.target.value); setProfileId(""); setEnvironmentId(""); setError(null); }}>{architectures.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <div className="control-plane-form-grid">
        <label><span>Architecture profile</span><select aria-label="Architecture profile" disabled={!revision} value={profile?.id ?? ""} onChange={(event) => { setProfileId(event.target.value); setEnvironmentId(""); }}>{profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label><span>Logical environment</span><select aria-label="Logical environment" disabled={!environment} value={environment?.id ?? ""} onChange={(event) => setEnvironmentId(event.target.value)}>{environments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      </div>
      {!detail ? <p role="status">Loading current revision…</p> : !revision || !profile || !environment ? <p>Save a current revision with a profile and a matching environment before enrollment.</p> : <p className="cp-muted">These IDs come from current revision {revision.revisionNumber}. Enrollment requires a personal, user-owned target; the API checks your access again.</p>}
    </>}
    <p><a href="/architectures">Create or edit an architecture</a> · <a href="/settings">Enable MFA in Settings</a></p>
    <section className="cp-section" aria-label="Local enrollment instructions">
      <h3>Run locally</h3>
      <p>Use Node.js 24. Replace the example API URL with this registry's API URL and the quoted directory placeholders with existing absolute paths. Keep the quotes, including around paths with spaces. Use a specific skills directory or project, never your home directory or filesystem root.</p>
      <p>Sign in with your account and MFA. Review the local inventory before enrollment and upload. Directory paths, exclusions, and instruction contents stay on your machine. The browser only prepares commands.</p>
      {enrollment && <pre aria-label="Enrollment commands"><code>{enrollment}</code></pre>}
      <Button disabled={!enrollment} size="sm" type="button" variant="outline" onClick={() => void copyCommands()}>Copy enrollment commands</Button>
      {copied === enrollment && enrollment && <p role="status">Enrollment commands copied.</p>}
      {copied === "failed" && <p role="status">Clipboard unavailable. Select and copy the commands above.</p>}
    </section>
    {profileValid && connection !== "managed" && <details className="target-advanced-settings"><summary>Observe, resolve, or exclude a project</summary>
      <p>Omit <code>--upload</code> to keep an observation local. Refresh Connected targets after an upload. Exclusion changes MySkills ownership only; it does not change provider discovery.</p>
      <pre><code>{[command(observe), command(`scopes resolve --provider ${provider} --path ${quote(project)}`), command(`scopes exclude --provider ${provider} --project ${quote(project)}`), command(`scopes include --provider ${provider} --project ${quote(project)}`)].join("\n")}</code></pre>
      <p>Include removes the explicit exclusion. A more specific project can still own that directory.</p>
    </details>}
    {profileValid && <details className="target-advanced-settings"><summary>Move an existing project into scope tracking</summary>
      <p>Review the local migration plan, then use its exact digest to apply it. A changed plan must be reviewed again. Existing managed Codex workspaces are adopted without reinstalling skills.</p>
      <pre><code>{[command(`scopes migrate plan --provider ${provider} --project ${quote(project)}`), command(`scopes migrate apply --provider ${provider} --project ${quote(project)} --plan-digest 'REVIEWED_PLAN_DIGEST'`)].join("\n")}</code></pre>
    </details>}
    {profileValid && connection === "managed" && <>
      <details className="target-advanced-settings"><summary>Install, update, and recover managed skills</summary>
        <p>Use the exact registry slug and version. Managed skills go in <code>.agents/skills</code> and records in <code>.myskills-app</code> inside the workspace. Confirm separately that Codex recognizes the skill.</p>
        <pre><code>{[command(`install 'SKILL_SLUG' --version 'VERSION' --workspace ${quote(workspace)}`), command(`codex observe --workspace ${quote(workspace)} --upload`), command(`update 'SKILL_SLUG' --workspace ${quote(workspace)}`), command(`rollback 'SKILL_SLUG' --workspace ${quote(workspace)}`)].join("\n")}</code></pre>
        <p>Review release notes before updating. Rollback restores a verified previous local installation when available.</p>
      </details>
      <details className="target-advanced-settings"><summary>Execute an update queued in the browser</summary><p>Create an API token in Settings with <code>skills:read</code> and <code>targets:execute</code>. Supply it through <code>MYSKILLS_TOKEN</code> locally; keep it out of pasted commands.</p><pre><code>{command(`companion run-once --workspace ${quote(workspace)} --holder 'local-companion'`)}</code></pre><p>This processes one queued operation when consent and policy permit it. It does not start a background service. Refresh Connected targets and Updates to inspect the observation and receipt.</p></details>
    </>}
  </section>;
}
