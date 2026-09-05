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

CLI tokens should be stored in the platform secret store where possible.

## Current Slice

This document describes the beta.5 CLI. Use a CLI built from the same
release as the registry for managed updates and Codex workspace commands. The
beta.2 visibility compatibility shims remain available for existing clients.
Source versions and npm publication are separate from hosted deployment; the
API and web expose their deployed version and commit at `/version.json`.

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
myskills validate --path <file-directory-or-zip>
myskills scan --path <file-directory-or-zip>
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
myskills install <skill-slug> --version <version> --workspace <absolute-dir>
myskills update [skill-slug] [--version <version>] --workspace <absolute-dir>
myskills rollback <skill-slug> --workspace <absolute-dir>
myskills companion run-once --workspace <absolute-dir> --holder <name>
myskills token create --name <name> --scope <scope> [--scope <scope>]
myskills token list
myskills token revoke <token-id>
```

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

The expected version is `0.1.0-beta.5`. This published release includes the
managed update and Codex workspace commands described here. To test repository
changes before their next release, build and run them locally:

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

`codex observe --upload` records verified filesystem state. Confirm separately
that Codex loaded the skill. To process one browser-queued update, supply a
separate token with `skills:read` and `targets:execute` through `MYSKILLS_TOKEN`
and run `companion run-once`. This command checks current authorization, consent,
policy, lease, and exact release identity. It does not start a background daemon.
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

The beta.2 compatibility shims remain in beta.3 and are planned for removal only
at a later, separately published prerelease boundary that includes migration
guidance and release verification. The source release does not imply a hosted
deployment.

Common scopes:

- `skills:read` for MCP registry discovery.
- `profile:read` for `whoami`.
- `skills:submit` for author submissions.
- `review:read` and `review:write` for maintainer review workflows.
- `architectures:read` for architecture list, detail, preview, and fixture-plan reads.
