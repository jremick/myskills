# Work Pilot Onboarding

Use a separate work-hosted MySkills instance for two colleagues using macOS,
Codex, and Claude Code. Each person uses their own account and local bindings.
This guide describes the intended setup; it does not mean the work deployment
is configured or verified.

## 1. Prepare the work instance

The operator must first complete the [self-hosting deployment](DEPLOYMENT.md):
separate work database, artifact storage, secrets, HTTPS ingress, and auth email
delivery. Do not copy personal accounts, tokens, scope state, or production seed
credentials into the work instance.

Apply the release's forward migrations before starting its API. Deploy API and
web from the same immutable commit, then verify readiness, sign-in, and exact
release delivery. Compare the web `/version.json` and API `/api/version.json`
through the work ingress; their version and revision must match the approved
release. See [deployment identity](RAILWAY_DEPLOYMENT.md#deployed-source-identity).
An image rollback does not undo migrations. Rehearse upgrades on an isolated
restore and retain verified database and artifact backups; prefer a tested
forward fix.

Give both colleagues an **author** account if they will submit skills. Assign
review to an operator with **maintainer**, **admin**, or **owner** permissions;
ordinary onboarding does not require giving everyone admin access. Each person
enables MFA in **Settings**.

Before enrollment, publish or share at least one reviewed release that both
accounts are authorized to read. Use the normal submission and review workflow,
then explicit sharing grants or team access. A private self-reviewed import must
complete instance review before sharing. A library recommendation alone does
not grant access; see [Libraries](LIBRARIES.md#private-review-and-sharing).

Each colleague creates a personal, user-owned architecture in **Architectures**,
adds an authorized reviewed skill, and saves a revision with a profile and a
matching logical environment. A blank architecture is insufficient. **Connected
targets → Setup guide** can generate commands using those saved IDs. “Personal”
here describes target ownership, even on the work instance.

## 2. Select the work account locally

Use a supported Node.js 22 or 24 release from [Getting Started](GETTING_STARTED.md).
Replace `RELEASE_VERSION` with the operator's exact CLI release, matched to the
API and web. Do not assume a moving npm tag matches the deployed release.

```bash
npm install -g '@jarel/myskills@RELEASE_VERSION'
myskills --version
myskills config set api-url 'https://work-skills.example/api' --config-profile work
myskills login --method password --config-profile work
myskills whoami --config-profile work
myskills doctor --config-profile work --json
```

Replace the example URL with the operator's work API URL. The `/api` suffix fits
the documented same-origin proxy; use the supplied API base for another topology.
Before login, clear inherited API/token overrides in your dedicated shell:
`MYSKILLS_API_URL` and `MYSKILLS_TOKEN` override saved profile values. Named
profiles reject legacy `MYSKILLS_CONFIG_FILE` and `MYSKILLS_TOKEN_FILE` overrides.

Keep `--config-profile work` on every subsequent work command. It isolates saved
API URL, credentials, and scope state from the existing default configuration.
It does not copy personal state. This selector is separate from the architecture
`--profile-id`. Confirm that `whoami` reports the intended work account.

## 3. Inventory Codex and Claude separately

Replace every quoted path with an existing absolute directory that the provider
actually uses, and replace the capitalized IDs with your saved architecture
binding. Keep paths quoted. MySkills does not find provider homes automatically.
Do not select your home directory or filesystem root.

First inspect both directories locally. These commands make no network calls:

```bash
myskills scopes inventory --provider codex --root '/absolute/existing/codex-skills' --config-profile work
myskills scopes inventory --provider claude --root '/absolute/existing/claude-skills' --config-profile work
```

Review omitted, linked, invalid, or truncated entries before proceeding.
**Enrollment registers a user-owned target and grants observation consent.**
Run it only after agreeing to that target and its metadata uploads. It requires
a password session with MFA; an API token cannot perform enrollment.

```bash
myskills scopes enroll --provider codex --scope global \
  --root '/absolute/existing/codex-skills' --architecture-id 'ARCHITECTURE_ID' \
  --environment-id 'ENVIRONMENT_ID' --profile-id 'PROFILE_ID' --config-profile work
myskills scopes enroll --provider claude --scope global \
  --root '/absolute/existing/claude-skills' --architecture-id 'ARCHITECTURE_ID' \
  --environment-id 'ENVIRONMENT_ID' --profile-id 'PROFILE_ID' --config-profile work
```

Upload an observation when ready, then refresh **Connected targets**:

```bash
myskills scopes observe --provider codex --scope global --upload --config-profile work
myskills scopes observe --provider claude --scope global --upload --config-profile work
myskills scopes list --config-profile work
```

Omit `--upload` for local observation only. Uploads contain bounded skill slugs,
digests, counts, and provider/scope metadata. Paths, exclusions, skill bodies,
and credentials stay local. Check provider, scope, last observed time,
completeness, and finding counts in the browser. An incomplete inventory is not
a failed connection. Linked entries are not followed; see
[Workspace Scopes](WORKSPACE_SCOPES.md#what-is-read-and-what-is-uploaded).

## 4. Give a project separate ownership

Exclude a specific existing project for both providers, then inspect resolution:

```bash
myskills scopes exclude --provider codex --project '/absolute/existing/project' --config-profile work
myskills scopes exclude --provider claude --project '/absolute/existing/project' --config-profile work
myskills scopes resolve --provider codex --path '/absolute/existing/project' --config-profile work
myskills scopes resolve --provider claude --path '/absolute/existing/project' --config-profile work
```

Before enrolling a separate project inventory, inspect its skill directory with
`scopes inventory`: Codex uses `<project>/.agents/skills`; Claude uses
`<project>/.claude/skills`. Select the project's intended architecture binding.
Then enroll and observe the Codex project inventory:

```bash
myskills scopes enroll --provider codex --scope project \
  --project '/absolute/existing/project' --architecture-id 'PROJECT_ARCHITECTURE_ID' \
  --environment-id 'PROJECT_ENVIRONMENT_ID' --profile-id 'PROJECT_PROFILE_ID' --config-profile work
myskills scopes observe --provider codex --scope project \
  --project '/absolute/existing/project' --upload --config-profile work
```

Repeat both commands with `--provider claude`. A project scope wins over an
exclusion at the same directory. Deeper project/exclusion rules take precedence;
`scopes include` removes only the selected provider's exclusion; supply the same
`--provider`, `--project`, and `--config-profile work` values.

These rules affect **MySkills ownership only**. Excluding a project does not
stop Codex or Claude from inheriting their global skills. Inventory uploads do
not synchronize skill files or change provider configuration. Any change to
native provider discovery or inheritance is a separate task.

## 5. Install only through the managed Codex workflow

Inventory targets cannot install or update skills, and there is no managed
Claude installation path in this pilot. For reviewed Codex installations, use
a separate existing workspace that has not been enrolled as an inventory
project. Select an authorized exact release shown in **Skills**:

```bash
myskills codex enroll --workspace '/absolute/existing/managed-workspace' \
  --architecture-id 'ARCHITECTURE_ID' --environment-id 'ENVIRONMENT_ID' \
  --profile-id 'PROFILE_ID' --config-profile work
myskills install 'SKILL_SLUG' --version 'EXACT_VERSION' \
  --workspace '/absolute/existing/managed-workspace' --config-profile work
myskills codex observe --workspace '/absolute/existing/managed-workspace' --upload --config-profile work
```

Installation writes reviewed skill files under `.agents/skills` and local records
under `.myskills-app` within the workspace's install root. Confirm separately
that Codex recognizes the installed skill. Existing managed workspaces can join
scope tracking through `scopes migrate plan`, followed by `scopes migrate apply`
with the reviewed `--plan-digest`; do not create a competing inventory binding.
See [CLI managed workspaces](../apps/cli/README.md#personal-codex-workspace) and
[scope migration](WORKSPACE_SCOPES.md#migration) for exact recovery procedures.

The pilot is ready for use when both accounts can read the intended reviewed
release, each machine reports the intended Codex and Claude inventories, and
project resolution matches the chosen rules. Record incomplete findings and
provider recognition separately from successful API uploads.
