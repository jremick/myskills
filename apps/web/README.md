# Web App

Browser interface for AI Skills Share.

## Current Slice

Implemented:

- Vite + React browser workspace
- public approved skill search against `GET /v1/skills`
- skill detail and release metadata against `GET /v1/skills/:slug` and `GET /v1/skills/:slug/releases/:version`
- metadata-only detail panel that does not fetch package bundle content during normal render
- CLI export guidance derived from the selected release and platform
- email/password login, MFA challenge completion, current-user refresh, and logout
- session-aware API client calls that forward the active bearer token when present
- maintainer review dashboard for metadata-only review queue, approval, and publication actions
- owner/admin admin console for registration mode, safe user status actions, non-secret provider metadata and role mappings, and audit review
- responsive browse/detail layout for desktop and mobile widths

Run locally:

```bash
npm run docker:up
npm run db:migrate
npm run db:seed
npm run dev:api
npm run dev:web
```

The web app defaults to `http://localhost:3000` and reads `VITE_API_BASE_URL` for the API base URL.

## Planned Workflows

- browse/search/filter skills
- view skill details and install/export guidance
- submit packages for review
- manage private drafts
- administer roles and remaining instance settings

The web app consumes API decisions. It must not duplicate authorization policy in client code.
