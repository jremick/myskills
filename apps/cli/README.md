# MySkills CLI

Command-line client for MySkills.

Supported runtime: Node.js `>=22.13 <23 || >=24 <25`.

Package:

```text
@jarel/myskills
```

Command:

```text
myskills
```

Responsibilities:

- login/logout/whoami
- create and validate skill packages
- scan packages before submission
- search and inspect authorized skills
- install/export/update/rollback packages
- submit drafts
- support maintainer/admin workflows through role-gated API calls
- enroll a personal Codex workspace and execute approved updates with an explicit companion command
- inspect an explicitly selected local Codex profile with a read-only metadata observation or health report
- enroll global and project Codex and Claude skill directories as separate read-only inventory scopes
- create a dry-run-only work/team bootstrap plan from explicit approved roots and skill selectors

CLI tokens should be stored in the platform secret store where possible.

## Current Slice

This document describes the `0.1.0-beta.17` source candidate, including named
CLI configuration profiles and global/project inventory scopes. Source,
GitHub releases, npm publication, and hosted deployment are separate states;
see [release verification](../../docs/RELEASE.md) for their checks. Historical
[beta.7 delivery evidence](../../docs/BETA7_RELEASE_DELIVERY.md) records that
release only. The API and web expose their deployed version and commit at
`/version.json`.

### Beta.3 breaking security changes

Beta.3 tightens the API boundary for team and sharing mutations. Team
creation, team-owner invitation/member lifecycle changes, and
sharing expansions to team or organization scope require an interactive
MFA-verified session. Privileged sharing reads/writes and the deprecated
`skills edit --visibility` alias use the same session/MFA boundary. API tokens
remain useful for scoped reads, but they cannot perform these mutations.

Migration before upgrading to beta.3: enroll TOTP through the API's
`POST /v1/auth/mfa/totp/enroll` and `POST /v1/auth/mfa/totp/confirm` routes
with password reauthentication, save the one-time recovery codes, then run
`myskills login` and complete the `POST /v1/auth/mfa/verify` challenge. Move
mutation automation to an explicitly managed session; keep API-token
automation read-only. Invitation acceptance remains session-only where the API
route permits it.

For install guidance, use the generated `myskills install ...` or
`myskills export ... --output ...` command. The corresponding MCP tool no longer
returns `apiBundleEndpoint` or a bundle URL, so clients must not construct one;
the CLI's authenticated export/install path remains the replacement flow.
Generated commands do not embed an API URL or bearer token; configure the CLI
with `myskills config set api-url ...` or `MYSKILLS_API_URL`, then authenticate
separately.

Implemented commands:

```text
myskills version
myskills --version
myskills init <name> [--output <dir>] [--title <text>] [--summary <text>] [--license <text>] [--json]
myskills validate --path <file-directory-or-zip>
myskills scan --path <file-directory-or-zip>
myskills package --path <directory> --output <file.zip> [--json]
myskills search [query] [--api-url <url>]
myskills info <skill-slug> [--api-url <url>]
myskills login [--api-url <url>] [--method <password|api-key>] [--email <email>]
myskills login --api-key [--api-url <url>]
myskills logout [--api-url <url>] [--token <token>]
myskills whoami [--api-url <url>] [--token <token>]
myskills auth status [--api-url <url>] [--token <token>]
myskills doctor [--api-url <url>] [--json]
myskills config get api-url
myskills config set api-url <url>
myskills config reset api-url
myskills config list
myskills bootstrap codex --dry-run --profile work --context <file> [--work-source-root <dir>] [--shared-source-root <dir>] --live-root <dir> --include-slug <slug> [--include-slug <slug>] --output <report.json>
myskills submit --path <file-directory-or-zip> [--api-url <url>] [--token <token>]
myskills review submissions [--api-url <url>] [--token <token>]
myskills review bundle <submission-id> [--platform <name>] [--output <file>] [--api-url <url>] [--token <token>]
myskills review action <submission-id> --action <approve|request-changes|reject|publish> [--artifact-sha256 <hash>] [--reason <text>] [--api-url <url>] [--token <token>]
myskills submissions list [--api-url <url>] [--token <token>]
myskills submissions withdraw <submission-id> [--reason <text>] [--api-url <url>] [--token <token>]
myskills skills edit <skill-slug> [--title <text>] [--summary <text>] [--tag <tag>] [--visibility <scope>] [--reason <text>] [--api-url <url>] [--token <token>] (deprecated visibility compatibility alias; use sharing set)
myskills skills archive|restore|delete <skill-slug> [--reason <text>] [--api-url <url>] [--token <token>]
myskills releases list <skill-slug> [--api-url <url>] [--token <token>]
myskills releases deprecate|unpublish|revoke|restore|delete <skill-slug>@<version> [--reason <text>] [--replacement <version>] [--api-url <url>] [--token <token>]
myskills teams list|skills [--api-url <url>] [--token <token>]
myskills teams create <team-name> [--name <team-name>] [--api-url <url>] [--token <token>]
myskills teams invite <team-id> --email <email> [--api-url <url>] [--token <token>]
myskills teams accept <invitation-id> [--api-url <url>] [--token <token>]
myskills sharing get <skill-slug> [--api-url <url>] [--token <token>]
myskills sharing set <skill-slug> --visibility <scope> [--team <team-id>] [--user <email>] [--organization <organization-id>] [--organization-id <organization-id>] [--clear-organizations]
myskills architectures patterns [--api-url <url>] [--token <token>]
myskills architectures list [--api-url <url>] [--token <token>]
myskills architectures show <architecture-id> [--revision <revision-id>] [--api-url <url>] [--token <token>]
myskills architectures preview|compile <architecture-id> [--revision <revision-id>] [--profile <profile-id>] [--environment <environment-id>] [--organization-id <organization-id>|--organization <organization-id>] [--api-url <url>] [--token <token>]
myskills architectures plan|dry-run <architecture-id> --observed <fixture.json> [--revision <revision-id>] [--profile <profile-id>] [--environment <environment-id>] [--organization-id <organization-id>|--organization <organization-id>] [--api-url <url>] [--token <token>]
myskills architectures observe --root <absolute-dir> --profile <personal|work|shared> (--context <file> | --target-id <id> --generation <number> --architecture-id <id> --environment-id <id> --profile-id <id> --adapter-digest <sha256> --capabilities-digest <sha256>) [--json]
myskills architectures health --root <absolute-dir> --profile <personal|work|shared> (--context <file> | --target-id <id> --generation <number> --architecture-id <id> --environment-id <id> --profile-id <id> --adapter-digest <sha256> --capabilities-digest <sha256>) [--json]
myskills admin sharing get [--api-url <url>] [--token <token>]
myskills admin sharing set [--public <true|false>] [--authenticated <true|false>] [--teams <true|false>] [--team-visibility <true|false>] [--user-visibility <true|false>] [--organization-visibility <true|false>]
myskills export <skill-slug> --version <version> --platform <platform> --output <dir>
myskills install <skill-slug> [--version <version>] [--platform <platform>] [--dir <install-root>]
myskills list [--dir <install-root>]
myskills update [skill-slug] [--version <version>] [--platform <platform>] [--dir <install-root>]
myskills rollback <skill-slug> [--dir <install-root>]
myskills codex enroll --workspace <absolute-dir> --architecture-id <id> --environment-id <id> --profile-id <id> [--name <name>]
myskills codex observe --workspace <absolute-dir> [--upload] [--json]
myskills scopes inventory --provider codex|claude --root <absolute-skills-dir> [--json]
myskills scopes enroll --provider codex|claude --scope global --root <absolute-skills-dir> --architecture-id <id> --environment-id <id> --profile-id <id> [--name <name>]
myskills scopes enroll --provider codex|claude --scope project --project <absolute-dir> --architecture-id <id> --environment-id <id> --profile-id <id> [--name <name>]
myskills scopes observe --provider codex|claude --scope global|project [--project <absolute-dir>] [--upload] [--json]
myskills scopes list [--provider codex|claude]
myskills scopes resolve --provider codex|claude --path <absolute-dir>
myskills scopes exclude|include --provider codex|claude --project <absolute-dir>
myskills scopes unbind --provider codex|claude --scope global|project [--project <absolute-dir>]
myskills scopes migrate plan|apply --provider codex|claude --project <absolute-dir> [--plan-digest <sha256>]
myskills install <skill-slug> --version <version> --workspace <absolute-dir>
myskills update [skill-slug] [--version <version>] --workspace <absolute-dir>
myskills rollback <skill-slug> --workspace <absolute-dir>
myskills companion run-once --workspace <absolute-dir> --holder <name>
myskills token create --name <name> --scope <scope> [--scope <scope>]
myskills token list
myskills token revoke <token-id>
```

`myskills init <name>` creates a minimal private Codex package in a new
directory. The default output is `./<name>`; use `--output` to select another
destination under an existing parent directory. The command writes `skill.json` and `SKILL.md` with
version `0.1.0`, `UNLICENSED`, and the `codex-skill` platform target. It does
not authenticate, call the network, or overwrite an existing file, directory,
or symlink. Edit the generated `SKILL.md`, then run `myskills validate --path`
and `myskills scan --path` before any separate authenticated submission.

`myskills package --path ./my-skill --output ./my-skill.zip` creates a
deterministic ZIP from one checked snapshot of a local package directory.
It validates the root manifest, portable paths, and bounded UTF-8 text, then
blocks credential and other blocking scan findings before creating output.
Warnings remain visible for review. The output reports the archive SHA-256,
byte size, and a separate `myskills submit --path ...` command. `--json` returns
the manifest, scan findings, output path, checksum, size, and next command.
Packaging does not contact the registry or bypass submission and review.

The output must end in `.zip` and have an existing parent directory outside
the source tree. Existing files, directories, symlinks, and symlink ancestors
are refused. All regular source files are included; there is no ignore file.
Keep credentials and unrelated files outside the source directory. The package
limits are 500 files, 1 MiB of text, 1,000 filesystem entries, and a 10 MiB
archive. Binary files,
symlinks, and special files are rejected. Text bytes, including BOMs and line
endings, are preserved. Entries use ordinal UTF-8 path order, fixed timestamps
and permissions, and uncompressed ZIP storage, so source mtimes and locale do
not change the archive checksum. Empty directories and executable bits are not
preserved. The archive checksum identifies the ZIP bytes, not the registry's
package-content digest.

Local authoring requires macOS or Linux. The archive is created with private
file permissions and exclusive creation; it never overwrites a destination
that appears during the command. A disk or write failure can leave a partial
output, which the error asks you to inspect before removal. Work in directories
owned by your user; this does not isolate writes from a hostile process running
as the same operating-system user.

The API-backed architecture preview includes the compiled graph, escaped
Mermaid, and a versioned diagram artifact with a plain-text accessible outline.
Use `--json` when a caller needs the complete JSON/Mermaid/outline projection;
the human-readable preview prints the bounded topology summary and Mermaid.
The browser workbench additionally offers derived JSON and Mermaid downloads.

### Local Codex observation

`architectures observe` and `architectures health` run the Codex adapter locally
against an explicitly supplied absolute root. The profile must be selected
explicitly as `personal`, `work`, or `shared`. Supply either `--context` with a
JSON object containing exactly `targetId`, `targetGeneration`,
`architectureId`, `environmentId`, `profileId`, `adapterDigest`, and
`capabilitiesDigest`, or pass those seven values through their corresponding
flags.

The command reads only bounded, allowlisted metadata and safe skill
frontmatter. It does not search home directories, follow profile pointers,
read prompt or skill bodies, emit local paths, retain credentials, call the
network, upload observations, or modify a target. Review the JSON output before
any separately authorized/manual upload to an API observation route. No live
apply, rollback, installation, or other target mutation is available through
this command.

### Fixture-only sync and recovery

`architectures plan` and `architectures dry-run` accept a bounded observed
fixture and return a dry-run plan. The fixture is not an implicit target and
the command does not apply changes. General architecture graph execution remains
fixture-only, even though its API persistence and recovery/rollback evidence
can be stored in Postgres. The separate Codex workspace and managed skill
operation commands below support one explicit filesystem installation path.
Each bounded architecture fixture run allows at most 500 steps and 2,004 append-only
receipts: a 1,002-receipt max-step lifecycle, one full apply/verify retry, and
two recovery/terminal receipts. Further retries require a new bounded run.

The API/web control plane also supports manager-only organization architecture
grant save/revoke and owner/team-owner derive-shell migration preview/create.
Those operations require the server's current-revision, organization-policy,
membership, exact-release, limit, idempotency, and MFA checks. This CLI does
not expose a second policy implementation or write command for them.

## Published CLI And Local Builds

The published beta channel is installed with:

```bash
npm install -g @jarel/myskills@beta
myskills --version
myskills login
```

The npm `beta` tag selects the published prerelease. It can differ from this
source candidate and the deployed API/web revision. To test source changes
before npm publication, build and run them locally:

```bash
npm ci
npm run build
node apps/cli/dist/index.js --version
node apps/cli/dist/index.js login
npm pack -w @jarel/myskills
```

Use the resulting tarball for a fresh isolated installation, or run the bundle
directly. The release gate verifies the packed executable and Apache license.
Public npm publication is a separate release step.

`validate`, `scan`, and `submit` accept a manifest file, package directory, or local `.zip` package. `login` prompts for the API URL when one is not supplied; the default is the local API at `http://localhost:3001`, and custom hosted URLs can be entered manually. Successful login stores the selected API URL in local CLI config so later commands can omit `--api-url`. API URL resolution is `--api-url`, then `MYSKILLS_API_URL`, then saved config, then `http://localhost:3001`.

`login` supports an email/password session flow and an API-key flow. Password
login handles MFA challenges and stores the verified session token. API-key
login validates the key with `/v1/me`. Token resolution is `--token`, then
`MYSKILLS_TOKEN`, then the stored token. The default store uses the platform
credential store through `@napi-rs/keyring`. Credential-store failures are
reported; a failed write does not silently store the credential in a file.
An existing legacy file credential can be read when the keyring entry is
confirmed absent. Explicit `MYSKILLS_TOKEN_STORE=file` or `MYSKILLS_TOKEN_FILE`
selects file storage with user-only permissions. A successful keyring write
clears the obsolete file entry.

`auth status` validates the token without printing it. `logout` revokes stored
sessions and clears local credentials. If a malformed keyring entry prevents
revocation, logout attempts local deletion and reports that remote revocation
is unconfirmed. It reports deletion failures. Stored API tokens are removed
locally and must be revoked with `token revoke`. Malformed file-store JSON
requires repair or removal of that file; other stored accounts are not silently
discarded.

`config get api-url`, `config set api-url <url>`, `config reset api-url`, and `config list` manage the saved API URL. `doctor` checks the CLI version, Node version, resolved API URL, `/health`, auth status, token-store backend, install-directory writability, and `/v1/capabilities`. If the CLI is pointed at the web app instead of the API, or a newer command is sent to an older server, command errors include concrete next steps and `--json` returns structured error codes.

### Older workspace scope identities

Scope state now records both device and inode. Existing inode-only state stays
readable, but observation and ordinary re-enrollment stop with
`SCOPE_ROOT_IDENTITY_LEGACY`. After confirming the same directory, repeat its
original `scopes enroll` command with `--accept-current-root` and the original
configuration profile. The command verifies the account, registry, architecture,
and existing target, then backs up local state and updates only the root identity.
It does not register targets, grant consent, or upload inventory. Pending
enrollments retain their recovery identity and can resume with normal enrollment
after acknowledgment. A repeated acknowledgment is a no-op; it cannot override
a known device/inode mismatch. Device and inode do not detect every same-device
inode reuse. See [scope identity migration](../../docs/WORKSPACE_SCOPES.md#upgrade-an-inode-only-scope-identity)
for the exact upgrade and recovery behavior.

### Separate work and personal configuration

Every command accepts `--config-profile <name>` before or after the command.
It overrides `MYSKILLS_CONFIG_PROFILE`. Names contain 1–64 lowercase letters,
digits, hyphens or underscores and start with a letter or digit. For example:

```bash
myskills config set api-url https://work-registry.example/api --config-profile work
myskills login --config-profile work
myskills whoami --config-profile work
myskills scopes list --config-profile work
myskills config list --config-profile work --json
```

There is no create or persistent select command. Writes create the selected
profile's state as needed; keep the flag on each command or set
`MYSKILLS_CONFIG_PROFILE` in that shell. `help`, `config list`, and `doctor`
show the selected configuration. JSON uses `configProfile: null` for the
legacy default. This selector is separate from architecture `--profile-id`
and provider inspection `--profile`.

Without a selector, existing config, credentials, and scope bindings remain at
their current locations. A named `personal` profile starts empty; it does not
copy or migrate the default. Each named profile has independent saved API URL,
credentials, and scope state, including for different accounts at one API URL.
A missing credential never falls back to another profile or the default.

The base directory is `MYSKILLS_CONFIG_DIR`, then
`$XDG_CONFIG_HOME/myskills-app`, then `~/.config/myskills-app`. Named state lives
under `<base>/profiles/<name>/` (`config.json`, optional `tokens.json`, and
`scopes/`). OS credential keys include the canonical profile directory and API
URL. Aliases for the base directory are supported; linked profile directories
are rejected so they cannot share another profile’s files. Changing the base
directory selects separate credentials. Named profiles
reject `MYSKILLS_CONFIG_FILE` and `MYSKILLS_TOKEN_FILE`; these retain their
existing precedence when no profile is selected. `MYSKILLS_TOKEN_STORE=file`
remains available for profile-local file storage.

Explicit API and token overrides still apply: `--api-url` then
`MYSKILLS_API_URL` override the saved registry, and `--token` then
`MYSKILLS_TOKEN` override the stored credential. Clear inherited overrides when
you want the profile's saved registry/account. `auth status` reports the token
source without printing its value. Selection does not move skill directories,
change native provider profiles, or unbind existing targets.

`bootstrap codex --dry-run` is a work/team-only local planner. It requires an
explicit `work` context, a normalized HTTPS target origin, stable target
instance/workspace/actor identifiers, explicit source and target trust
compartments (`work`, `shared`, or `work+shared` for sources, and `work-team`
for the target), typed `work` and/or `shared` source roots, a target root, and
a positive `--include-slug` allowlist. The context must approve the computed
source-root type/digests and target-root digest. Personal, consumer, public,
and unclassified sources are rejected, and candidates are never selected by
implicit inventory discovery. A plan accepts at most eight selected candidates;
each candidate snapshot accepts at most 1,000 entries and 32 nested directory
levels. A one-skill work-owned canary is supported.

The context JSON must include `profile: "work"`, `targetOrigin`,
`instanceId`, one `tenantId` or `workspaceId`, `actorId`, the canonical trust
compartments, `approvedSourceRoots` entries of `{type, identityDigest}`, and
`approvedTargetRootIdentityDigest`.

The planner reads selected source and target content without network or
registry access. It opens each selected tree through a bootstrap-owned secure
snapshot reader, then hashes, parses, scans, and reports only those held bytes.
It writes only the explicitly requested new private report (`0600`) under a
user-controlled private parent. Reserved package manifests remain strict:
invalid or multiple manifests fail closed, and no metadata is relocated. The
full report contains the work binding, approved root digests, owning package
contract identifiers, candidate content identities, execution identities, the
exact target precondition (`absent` or `present-identical` with its expected
artifact identity), and private snapshots. Terminal output is a redacted DTO
with counts and digests; it does not contain paths, candidate names, inventory,
or private identifiers.
There is no apply, publishing, adoption, or target-write mode in this command.
`ready` means that the held snapshot passed deterministic checks only. It is
not approval to apply. Sensitive configuration and credential paths are
excluded before content enters the report, and heuristic scan-clean never
replaces explicit human content review. Any future executor must repeat the
retained source/target identity check immediately before its first write
(compare-and-swap) and require that review at that boundary.

`validate`, `scan`, and `submit` read one bounded snapshot of the local package.
`submit` sends those same validated and scanned text entries for directory and
ZIP inputs. Authors can inspect and withdraw submissions; maintainers fetch the
reviewed artifact and approval hash before approving, requesting changes,
rejecting, or publishing it. The browser shows review reasons and scan findings.
Corrections create another immutable version.

Published artifacts remain immutable. `skills edit` changes metadata;
`releases deprecate`, `unpublish`, `revoke`, `restore`, and `delete` change
server-owned lifecycle state. Deprecated releases remain installable. Hidden,
revoked, archived, or deleted releases cannot be installed or exported.
`export` verifies artifact size and SHA-256 before writing normalized paths.

`install`, `update`, and `rollback` share an exclusive install-root lock and
verify package bytes and current eligibility before promotion. Updates retain
a verified rollback snapshot. Interrupted transactions preserve unknown or
edited local bytes for investigation. Each installation binds the API origin
and registry instance ID. Legacy records without that identity are not adopted
automatically: keep their files as a backup, review the source, and install into
a new root. A registry change requires a separate root.

New installation and snapshot records declare
`contentDigestAlgorithm: "sha256-json-ordinal-v1"`; transaction journals use
`targetContentDigestAlgorithm` for the candidate. This scheme normalizes paths,
sorts them by JavaScript string ordinal order (UTF-16 code units), then hashes
the UTF-8 JSON array of `{path, content}` entries with SHA-256. It does not
depend on the process locale. Readers reject unknown algorithm identifiers.

A missing algorithm field identifies the legacy `localeCompare` scheme.
The CLI verifies these records with the current process's legacy comparison
rules. It does not retry with a different algorithm. If a locale change makes
legacy bytes unverifiable, return to the original verification locale and
compatible Node/ICU environment before a trusted migration. Preserve the files
and recovery copies if their identity still cannot be proved. Never add an
algorithm field to an old hash by hand. After verification, an install or
update records the held bytes with an ordinal digest in the new journal and
snapshot; rollback does the same for its verified source snapshot. Untouched
legacy history and journals retain their original verification rules.

Local package intake, install, export, and rollback support macOS and Linux.
No-follow payload reads and writes, private staging directories, and drift
checks protect these operations. They do not isolate the workspace from a
hostile process already running as the same OS user. Other operating systems
can use the API's portable buffer upload path; native Windows filesystem
installation is unsupported.

### Personal Codex workspace

Create a personal architecture in the browser and note its architecture,
environment, and profile IDs. Enable MFA and sign in with a password session.
Enroll an existing absolute workspace directory using the command above.
Enrollment creates a user-owned target, grants consent, and stores a local
binding. A fresh workspace cannot attach to an existing target ID; that option
only confirms or resumes its existing local binding.

Use `--workspace` for all managed writes. Skills are installed under
`.agents/skills`, and records stay under `.myskills-app` in that workspace.
The CLI checks Codex compatibility and valid `SKILL.md` YAML frontmatter with a
matching name and text description. `--dir` cannot bypass an enrolled workspace's
binding. Team-shared skills can be installed when your account can read them;
team-owned execution targets are outside this adapter's beta scope.

### Global and project skill inventories (workspace scopes)

`myskills scopes` enrolls a provider's user-level skills directory, or a
project, as a personal read-only inventory target: `codex-inventory` for Codex
and `claude-inventory` for Claude. Pass each directory explicitly; the CLI does
not search your home directory. Run `scopes inventory` first to review locally
what an upload would contain. Uploads carry skill slugs, counts, and
`SKILL.md` digests only. Absolute paths, exclusions, skill bodies, and names of
linked or invalid entries stay local.

Projects resolve to the provider's global scope unless you exclude them or
enroll them separately. Resolution uses real paths and whole path segments, the
deepest rule wins, and an excluded project never falls back to the global
scope. Scopes are MySkills ownership only: they do not change how Codex or
Claude load or inherit skills, and they never write skill files. Existing
managed Codex workspace bindings can be adopted with a previewed
`scopes migrate plan` and `scopes migrate apply`. See
[Workspace Scopes](../../docs/WORKSPACE_SCOPES.md) for the rules, recovery
steps, and local state format.

`codex observe --upload` records verified filesystem state. Confirm separately
that Codex loaded the skill. To process one browser-queued update, supply a
separate token with `skills:read` and `targets:execute` through `MYSKILLS_TOKEN`
and run `companion run-once`. If the workspace has a skill installed with
`--library-entry`, the token also needs `libraries:read`: the companion rechecks
that adoption before it changes files. Without it, the operation fails with
`API_TOKEN_SCOPE_REQUIRED` and a message that names the scope; files are not
changed. The CLI never widens a token's scopes. This command checks current
authorization, consent, policy, lease, and exact release identity. It does not
start a background daemon.
Browser/device login and additional provider install adapters remain planned.

To change skill visibility, use the canonical `myskills sharing set
<skill-slug> --visibility <scope>` command. It accepts either
`--organization <organization-id>` or `--organization-id <organization-id>` for
the complete organization grant set. Omitting both organization options keeps
the beta.2 compatibility behavior and preserves already-issued organization
grants. Pass `--clear-organizations` to send `organizationIds: []` and revoke
the complete organization grant set; this flag is mutually exclusive with both
organization ID options.

`myskills skills edit --visibility <scope>` remains a deprecated beta.2
compatibility alias. It preserves omitted organization grants and does not
provide complete-set organization controls; use the canonical sharing command
to grant or clear organization access. Canonical sharing remains subject to
the API's session and MFA security rules; the beta.2 metadata alias is also
session-only and requires an MFA-verified session before it reads or replaces
grants. API tokens cannot widen a skill through the alias. Neither path
bypasses server policy. Organization policy and membership remain API-owned.
Do not treat a successful CLI command for another scope as evidence of
organization sharing.

The CLI does not provide the separate architecture organization-grant
replacement workflow; architecture grants remain an API/web manager control.
The read-only `architectures preview`, `compile`, `plan`, and `dry-run`
commands already accept `--organization-id <organization-id>` (with
`--organization <organization-id>` retained as an input alias). The server
authorizes that exact organization projection; it is a scope filter, not an
ownership shortcut.

The beta.2 compatibility shims remain available and are planned for removal only
at a later, separately published prerelease boundary that includes migration
guidance and release verification. The source release does not imply a hosted
deployment.

Common scopes:

- `skills:read` for MCP registry discovery.
- `profile:read` for `whoami`.
- `skills:submit` for author submissions.
- `review:read` and `review:write` for maintainer review workflows.
- `architectures:read` for architecture list, detail, preview, and fixture-plan reads.
- `libraries:read` for library reads and for install, update, and companion runs of library-bound skills.
- `libraries:write` for library changes.

## Libraries

`myskills libraries help` lists the source, import, review, tracking, subscription
and adoption commands. Requests use the [Libraries API contract](../../docs/plans/2026-09-26-library-api-contract.md)
and reviewed JSON files supplied with `--input`. The [Libraries guide](../../docs/LIBRARIES.md)
contains a complete workflow and scope requirements.

Bind an installation to an adopted version with
`myskills install <slug> --library-entry <entry-id>`. If the adopted release
requires user action, read its notes and add `--accept-user-action`. Updates
resolve that exact recommendation and recheck it before changing files. A
deleted or inaccessible entry never falls back to the newest registry release.
Local drift still stops replacement. Use
`myskills libraries unbind-local <slug> --dir <root>` to detach that local
binding explicitly while retaining files and rollback history.

`updates` and `update` report each skill separately. If an entry is deleted,
access is lost, the adopted release is revoked, or the entry has no adoption,
that skill shows `curation-unavailable` with the reason (`library.state` and
`library.reason` in `--json`). Its files and binding stay unchanged, other skills
are still evaluated and updated, and `update` exits 1. `install` fails closed
with `LIBRARY_CURATION_UNAVAILABLE`. A malformed or mismatched resolution stops
the command with `LIBRARY_RESOLUTION_INVALID`.

If a library adopts a version older than the installed one, the skill shows
`library-adopts-older` (`adoption-older-than-installed` in `--json`). MySkills
never downgrades automatically. When the last rollback snapshot is exactly the
adopted release, run `myskills rollback <slug>`; otherwise install the adopted
version into a new root with `--dir <new-root>`. `libraries unbind-local` keeps
the installed version instead.

`libraries review-bundle <submission-id>` prints only after the SHA-256 of the
response body matches `x-myskills-artifact-sha256`. The JSON output labels its
`payload` as `parsed-for-inspection`. Use `--output <new-file>` to keep the
exact verified bytes; an existing file is never replaced. Supply
`--artifact-sha256 <digest-from-review-requests>` to also verify the immutable
artifact requested for review. Without it, verification covers the response
header only; `expectedDigestVerified` reports this distinction in JSON output.

## Skill improvement

Prepare local skill reviews with `myskills improve`, inspect the report, export a draft, and submit it through normal review. Registry plans pin source/reviewer versions and apply user, team or organization policy. Execution requires the exact local plan digest and explicit cloud consent. See [the feature guide](../../docs/SKILL_IMPROVEMENT.md) for commands, JSON bodies, evaluation suites and current adapter limits. The first runner is Claude Code 2.1.283 or newer. Use an exact model ID and an existing Claude sign-in. Codex improvement execution remains disabled pending its isolation gate; final release verification is recorded in the feature guide.

### Skill bundles

Browse related skills without installing them:

```bash
myskills bundles list --view grouped --query engineering
myskills bundles show <bundle-id>
myskills bundles members <bundle-id> --limit 25
myskills bundles memberships <skill-slug>
myskills bundles sources
```

Create or edit with `myskills bundles create --input reviewed-bundle.json` or
`myskills bundles edit <bundle-id> --input reviewed-bundle.json`. The request
contains `kind`, `name`, `purpose`, `owner`, `visibility` and `memberSlugs`.
Source groups also require `sourceEntryId`; edits require `expectedRevision`.
The API validates current ownership, author privileges and member access.

Save with `myskills bundles save <bundle-id> --input save-reference.json`, where
the file contains `libraryId` and `expectedRevision`. This saves one reference;
it does not adopt, install or follow any skill. Use `--cursor` with list/member
reads. Refresh from the first page if the authorized catalog changes.
