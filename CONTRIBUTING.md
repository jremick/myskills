# Contributing

AI Skills Share is private while the core architecture and security boundaries are being established. The contribution model below is the intended public-ready shape.

## Development Principles

- Keep the product self-hostable and portable.
- Do not add organization-specific assumptions to public code or docs.
- Keep the API, CLI, web app, and MCP tools aligned around the same backend authorization decisions.
- Add verification for behavioral changes.

## Local Checks

```bash
npm run check
```

## Security

Do not include secrets, customer data, private company context, production tokens, or local machine state in issues, commits, test fixtures, examples, docs, or generated artifacts.

