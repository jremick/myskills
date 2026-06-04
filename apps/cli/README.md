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
ai-skills validate --path <file-or-directory>
ai-skills scan --path <file-or-directory>
ai-skills search [query] [--api-url <url>]
ai-skills info <skill-slug> [--api-url <url>]
ai-skills whoami [--api-url <url>] [--token <token>]
ai-skills submit --path <file-or-directory> [--api-url <url>] [--token <token>]
ai-skills review submissions [--api-url <url>] [--token <token>]
ai-skills review action <submission-id> --action <approve|publish> [--reason <text>]
ai-skills export <skill-slug> --version <version> --platform <platform> --output <dir>
ai-skills token create --name <name> --scope <scope> [--scope <scope>]
ai-skills token list
ai-skills token revoke <token-id>
```

`search`, `info`, `whoami`, `submit`, `review`, `export`, and `token` read `AI_SKILLS_TOKEN` when `--token` is not passed. `submit` validates and scans locally before sending package text entries to the API. `export` downloads server-authorized bundle content, verifies byte size and SHA-256 against release metadata, and writes normalized package paths under the requested output directory. `token create` prints the plaintext API token only once. Durable platform-secret storage, browser login, install/update/rollback, and archive packaging are still planned.

Common scopes:

- `skills:read` for MCP registry discovery.
- `profile:read` for `whoami`.
- `skills:submit` for author submissions.
- `review:read` and `review:write` for maintainer review workflows.
