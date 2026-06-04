# CLI App

Command-line client for AI Skills Share.

Planned command name:

```text
ai-skills
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
ai-skills validate --path <file-directory-or-zip>
ai-skills scan --path <file-directory-or-zip>
ai-skills search [query] [--api-url <url>]
ai-skills info <skill-slug> [--api-url <url>]
ai-skills login [--api-url <url>] [--email <email>]
ai-skills logout [--api-url <url>] [--token <token>]
ai-skills whoami [--api-url <url>] [--token <token>]
ai-skills submit --path <file-directory-or-zip> [--api-url <url>] [--token <token>]
ai-skills review submissions [--api-url <url>] [--token <token>]
ai-skills review action <submission-id> --action <approve|publish> [--reason <text>]
ai-skills export <skill-slug> --version <version> --platform <platform> --output <dir>
ai-skills install <skill-slug> [--version <version>] [--platform <platform>] [--dir <install-root>]
ai-skills list [--dir <install-root>]
ai-skills update [skill-slug] [--version <version>] [--platform <platform>] [--dir <install-root>]
ai-skills rollback <skill-slug> [--dir <install-root>]
ai-skills token create --name <name> --scope <scope> [--scope <scope>]
ai-skills token list
ai-skills token revoke <token-id>
```

`validate`, `scan`, and `submit` accept a manifest file, package directory, or local `.zip` package. `login` prompts for the password, handles MFA challenges with a TOTP or recovery code prompt, and stores the returned session token by normalized API URL. Token resolution is `--token`, then `AI_SKILLS_TOKEN`, then the stored login token. The default token store writes `tokens.json` under `AI_SKILLS_CONFIG_DIR`, `AI_SKILLS_TOKEN_FILE`, or the user config directory with user-only file permissions. `logout` revokes stored session tokens and clears the local entry; stored API tokens are removed locally and must be revoked with `token revoke`.

`submit` validates and scans locally before sending package directories as normalized text entries or `.zip` packages as base64 archive uploads for server-side extraction. `export` downloads server-authorized bundle content, verifies byte size and SHA-256 against release metadata, and writes normalized package paths under the requested output directory. `install` uses the same verified bundle path, writes into `--dir`, `AI_SKILLS_INSTALL_DIR`, or the user data directory, and records local state in `.ai-skills-share/installed.json`; `update` preserves a rollback snapshot before replacing files, and `rollback` restores the most recent snapshot. `token create` prints the plaintext API token only once and does not overwrite the stored login session. Platform keychain storage, browser login, platform-specific install adapters, and archive creation are still planned.

Common scopes:

- `skills:read` for MCP registry discovery.
- `profile:read` for `whoami`.
- `skills:submit` for author submissions.
- `review:read` and `review:write` for maintainer review workflows.
