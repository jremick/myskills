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

CLI tokens should be stored in the platform secret store where possible.

## Current Slice

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
myskills skills edit <skill-slug> [--title <text>] [--summary <text>] [--tag <tag>] [--reason <text>] [--api-url <url>] [--token <token>]
myskills skills archive|restore|delete <skill-slug> [--reason <text>] [--api-url <url>] [--token <token>]
myskills releases list <skill-slug> [--api-url <url>] [--token <token>]
myskills releases deprecate|unpublish|revoke|restore|delete <skill-slug>@<version> [--reason <text>] [--replacement <version>] [--api-url <url>] [--token <token>]
myskills teams list|skills [--api-url <url>] [--token <token>]
myskills teams create <team-name> [--name <team-name>] [--api-url <url>] [--token <token>]
myskills teams invite <team-id> --email <email> [--api-url <url>] [--token <token>]
myskills teams accept <invitation-id> [--api-url <url>] [--token <token>]
myskills sharing get <skill-slug> [--api-url <url>] [--token <token>]
myskills sharing set <skill-slug> --visibility <scope> [--team <team-id>] [--user <email>]
myskills architectures patterns|list
myskills architectures show <architecture-id> [--revision <revision-id>]
myskills architectures preview <architecture-id> [--profile <profile-id>] [--environment <environment-id>]
myskills architectures plan <architecture-id> --observed <fixture.json>
myskills architectures detect [--target codex] [--target-id <id>] [--dir <install-root>] [--json]
myskills architectures configure --auto [--architecture <id>] [--target codex] [--target-id <id>] [--context <personal|work|team>] [--dir <install-root>] [--json]
myskills admin sharing get [--api-url <url>] [--token <token>]
myskills admin sharing set [--public <true|false>] [--authenticated <true|false>] [--teams <true|false>] [--team-visibility <true|false>] [--user-visibility <true|false>]
myskills export <skill-slug> --version <version> --platform <platform> --output <dir>
myskills install <skill-slug> [--version <version>] [--platform <platform>] [--dir <install-root>]
myskills list [--dir <install-root>]
myskills update [skill-slug] [--version <version>] [--platform <platform>] [--dir <install-root>]
myskills rollback <skill-slug> [--dir <install-root>]
myskills token create --name <name> --scope <scope> [--scope <scope>]
myskills token list
myskills token revoke <token-id>
```

## Published And Candidate Channels

The currently published package remains available under npm's `alpha` tag:

```bash
npm install -g @jarel/myskills@alpha
myskills --version
myskills login
```

Update the CLI with:

```bash
npm install -g @jarel/myskills@alpha
```

The `0.1.0-beta.2` source manifest is configured for the `beta` dist-tag, but package publication is a separate maintainer approval step. The release-verification workflow packs and installs the candidate without publishing it.

`validate`, `scan`, and `submit` accept a manifest file, package directory, or local `.zip` package. `login` prompts for the API URL when one is not supplied; the default is the local API at `http://localhost:3001`, and custom hosted URLs can be entered manually. Successful login stores the selected API URL in local CLI config so later commands can omit `--api-url`. API URL resolution is `--api-url`, then `MYSKILLS_API_URL`, then saved config, then `http://localhost:3001`.

`login` supports an email/password session flow and an API-key flow. The email/password flow handles MFA challenges with a TOTP or recovery code prompt and stores only the verified session token. The API-key flow validates the key with `/v1/me` before storing it. Token resolution is `--token`, then `MYSKILLS_TOKEN`, then the stored login token. The default token store uses the platform credential store through `@napi-rs/keyring` and falls back to `tokens.json` with user-only file permissions when keyring storage is unavailable or `MYSKILLS_TOKEN_STORE=file`/`MYSKILLS_TOKEN_FILE` is set. `auth status` validates the current token without printing it. `logout` revokes stored session tokens and clears the local entry; stored API tokens are removed locally and must be revoked with `token revoke`.

`config get api-url`, `config set api-url <url>`, `config reset api-url`, and `config list` manage the saved API URL. `doctor` checks the CLI version, Node version, resolved API URL, `/health`, auth status, token-store backend, install-directory writability, and `/v1/capabilities`. If the CLI is pointed at the web app instead of the API, or a newer command is sent to an older server, command errors include concrete next steps and `--json` returns structured error codes.

`submit` validates and scans locally before sending package directories as normalized text entries or `.zip` packages as base64 archive uploads for server-side extraction. Authors can inspect their submitted versions with `submissions list` and withdraw unreviewed or changes-requested submissions with `submissions withdraw`. Maintainers can fetch the reviewed artifact and approval hash with `review bundle`, then approve, request changes, reject, and publish submitted versions through `review action`.

`architectures detect` inspects only the MySkills-managed install registry under the selected install root. Its target observation contains bounded skill identity, version, artifact digest, and capability metadata; it never contains the install root or skill paths. `architectures configure --auto` sends that observation to the read-scoped architecture resolver, ranks existing owner-visible revisions and environments, and prints the selected dry-run plan. Equal or weak matches fail closed as ambiguous. The command never applies changes, and `--apply` is rejected until consent, conflict handling, audit, and rollback are implemented.

Published artifacts remain immutable. `skills edit` changes mutable skill metadata only, while `releases deprecate`, `releases unpublish`, `releases revoke`, `releases restore`, and `releases delete` update server-owned lifecycle state for a specific version. Deprecated releases remain visible and installable; unpublished, revoked, archived, and deleted releases are hidden from install/export queries. `export` downloads server-authorized bundle content, verifies byte size and SHA-256 against release metadata, and writes normalized package paths under the requested output directory. `install` uses the same verified bundle path, writes into `--dir`, `MYSKILLS_INSTALL_DIR`, or the user data directory, and records local state in `.myskills-app/installed.json`; `update` preserves a rollback snapshot before replacing files, and `rollback` restores the most recent snapshot. `token create` prints the plaintext API token only once and does not overwrite the stored login session. Browser/device login, platform-specific install adapters, and archive creation are still planned.

To change skill visibility, use `myskills sharing set <skill-slug> --visibility <scope>`; organization visibility is not supported.

Common scopes:

- `skills:read` for MCP registry discovery.
- `profile:read` for `whoami`.
- `skills:submit` for author submissions.
- `review:read` and `review:write` for maintainer review workflows.
