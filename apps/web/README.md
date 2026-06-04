# Web App

Browser interface for AI Skills Share.

## Current Slice

Implemented:

- Vite + React browser workspace
- public approved skill search against `GET /v1/skills`
- skill detail and release metadata against `GET /v1/skills/:slug` and `GET /v1/skills/:slug/releases/:version`
- metadata-only detail panel that does not fetch package bundle content during normal render
- CLI export guidance derived from the selected release and platform
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
- review submissions
- administer users, registration, roles, providers, audit, and settings

The web app consumes API decisions. It must not duplicate authorization policy in client code.
