# MySkills CLI

Command-line client for MySkills.

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
myskills submit --path <file-directory-or-zip> [--api-url <url>] [--token <token>]
myskills review submissions [--api-url <url>] [--token <token>]
myskills review action <submission-id> --action <approve|publish> [--reason <text>]
myskills export <skill-slug> --version <version> --platform <platform> --output <dir>
myskills install <skill-slug> [--version <version>] [--platform <platform>] [--dir <install-root>]
myskills list [--dir <install-root>]
myskills update [skill-slug] [--version <version>] [--platform <platform>] [--dir <install-root>]
myskills rollback <skill-slug> [--dir <install-root>]
myskills token create --name <name> --scope <scope> [--scope <scope>]
myskills token list
myskills token revoke <token-id>
```

## Public Alpha Install

The first public alpha package is distributed through npm under the `alpha` tag:

```bash
npm install -g @jarel/myskills@alpha
myskills --version
myskills login
```

Update the CLI with:

```bash
npm install -g @jarel/myskills@alpha
```

`validate`, `scan`, and `submit` accept a manifest file, package directory, or local `.zip` package. `login` prompts for the API URL when one is not supplied; the default is the local API at `http://localhost:3001`, and custom hosted URLs can be entered manually. Successful login stores the selected API URL in local CLI config so later commands can omit `--api-url`. API URL resolution is `--api-url`, then `MYSKILLS_API_URL`, then saved config, then `http://localhost:3001`.

`login` supports an email/password session flow and an API-key flow. The email/password flow handles MFA challenges with a TOTP or recovery code prompt and stores only the verified session token. The API-key flow validates the key with `/v1/me` before storing it. Token resolution is `--token`, then `MYSKILLS_TOKEN`, then the stored login token. The default token store uses the platform credential store through `@napi-rs/keyring` and falls back to `tokens.json` with user-only file permissions when keyring storage is unavailable or `MYSKILLS_TOKEN_STORE=file`/`MYSKILLS_TOKEN_FILE` is set. `logout` revokes stored session tokens and clears the local entry; stored API tokens are removed locally and must be revoked with `token revoke`.

`submit` validates and scans locally before sending package directories as normalized text entries or `.zip` packages as base64 archive uploads for server-side extraction. `export` downloads server-authorized bundle content, verifies byte size and SHA-256 against release metadata, and writes normalized package paths under the requested output directory. `install` uses the same verified bundle path, writes into `--dir`, `MYSKILLS_INSTALL_DIR`, or the user data directory, and records local state in `.myskills-app/installed.json`; `update` preserves a rollback snapshot before replacing files, and `rollback` restores the most recent snapshot. `token create` prints the plaintext API token only once and does not overwrite the stored login session. Browser/device login, platform-specific install adapters, and archive creation are still planned.

Common scopes:

- `skills:read` for MCP registry discovery.
- `profile:read` for `whoami`.
- `skills:submit` for author submissions.
- `review:read` and `review:write` for maintainer review workflows.
