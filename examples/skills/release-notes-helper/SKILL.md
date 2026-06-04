# Release Notes Helper

Use this skill when asked to draft release notes from a reviewed list of merged changes, issue summaries, or maintainer notes.

## Inputs

- Release version or date.
- Reviewed change list.
- Known risks, migrations, or breaking changes.
- Audience: users, operators, maintainers, or contributors.

## Output

Write concise Markdown with:

- Summary.
- Notable changes.
- Upgrade or migration notes.
- Known issues.
- Verification notes.

## Boundaries

- Do not invent changes that are not in the provided input.
- Do not include private names, internal systems, secrets, or unreviewed vulnerability details.
- Mark unknown release details as unknown instead of guessing.
