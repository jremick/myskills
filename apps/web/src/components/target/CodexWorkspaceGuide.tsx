import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const workspace = '"/absolute/existing/workspace"';

export function CodexWorkspaceGuide() {
  return <Card className="control-plane-card codex-workspace-guide" aria-label="Connect a Codex workspace">
    <CardHeader><CardTitle>Connect a Codex workspace</CardTitle><CardDescription>Enroll one personal workspace, install reviewed skills, and report their local state.</CardDescription></CardHeader>
    <CardContent>
      <p>Use the CLI built from the same release as this registry. The published npm package may be an earlier release. Follow the <a href="https://github.com/jremick/myskills/blob/main/docs/GETTING_STARTED.md" target="_blank" rel="noreferrer">repository build instructions</a> or use the matching package supplied by your operator.</p>
      <details className="target-advanced-settings"><summary>Workspace setup and recovery commands</summary>
        <p>This beta connects personal, user-owned targets. Your account can also install team-shared skills that it can read. Create a personal architecture in <a href="/architectures">Architectures</a>, and enable MFA in <a href="/settings">Settings</a> before enrollment.</p>
        <ol>
          <li><strong>Sign in to this registry.</strong><p>Choose this instance's API URL when prompted. Password login stores a session and asks for your MFA code; enrollment requires that verified session.</p><pre><code>{'myskills --version\nmyskills login --method password'}</code></pre></li>
          <li><strong>Find your architecture context.</strong><p>Use the architecture, environment, and profile IDs from your personal architecture. Replace the capitalized placeholders below.</p><pre><code>{'myskills architectures list\nmyskills architectures show "ARCHITECTURE_ID"'}</code></pre></li>
          <li><strong>Enroll an existing workspace directory.</strong><p>Replace the example directory with its absolute path. Enrollment creates the target, grants consent, and stores the directory binding locally. The directory path stays on your machine.</p><pre><code>{`myskills codex enroll --workspace ${workspace} \\\n  --architecture-id "ARCHITECTURE_ID" --environment-id "ENVIRONMENT_ID" \\\n  --profile-id "PROFILE_ID" --name "My Codex workspace"`}</code></pre></li>
          <li><strong>Inspect a release, then install and observe it.</strong><p>Use the exact slug and version shown in the registry. The CLI writes managed skills to <code>.agents/skills</code> and its records to <code>.myskills-app</code> inside this workspace.</p><pre><code>{`myskills install "SKILL_SLUG" --version "VERSION" --workspace ${workspace}\nmyskills codex observe --workspace ${workspace} --upload`}</code></pre><p>Omit <code>--upload</code> to keep the observation local. An observation verifies managed files; confirm separately that Codex recognizes the skill in this workspace.</p></li>
          <li><strong>Update or recover.</strong><p>Review the release notes before an update. Rollback restores a verified previous local installation when one is available.</p><pre><code>{`myskills update "SKILL_SLUG" --workspace ${workspace}\nmyskills rollback "SKILL_SLUG" --workspace ${workspace}`}</code></pre></li>
        </ol>
        <details className="target-advanced-settings"><summary>Execute an update queued in the browser</summary><p>Create a separate API token in Settings with <code>skills:read</code> and <code>targets:execute</code>. Supply it through <code>MYSKILLS_TOKEN</code> in your local shell or secret manager for the companion command. Keep the token out of pasted commands and package files.</p><pre><code>{`myskills companion run-once --workspace ${workspace} --holder "local-companion"`}</code></pre><p>This processes one queued operation when consent and policy permit it. It does not start a background service. Refresh Connected targets and Updates to inspect the resulting observation and receipt.</p></details>
      </details>
    </CardContent>
  </Card>;
}
