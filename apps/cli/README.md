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
```

`search`, `info`, and `whoami` read `AI_SKILLS_TOKEN` when `--token` is not passed. Token storage, browser login, install/export, and submission commands are still planned.
