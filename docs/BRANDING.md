# Instance branding

An owner or administrator with an MFA-verified session can open **Admin → Branding**
to change the logo and brand text. These settings are visible to everyone, including
visitors on the landing, login, invitation and account-action pages.

- **Brand text:** 1–80 characters on one line. This is also the accessible name when text is hidden.
- **Logo image:** a still PNG, JPEG or WebP image up to 256 KB and 2048 × 2048 pixels. SVG, external URLs and animated images are rejected.
- **Show brand text:** turn this off if the image already includes lettering.
- **Remove custom logo:** restore the MySkills mark while keeping the current text.
- **Save branding:** save the preview and update the current page. Other pages read the latest branding when loaded.
- **Discard:** restore the last saved values.
- **Restore MySkills defaults:** preview the original mark and MySkills text; **Save branding** applies the reset.

Failed saves keep the draft. Switching admin tabs keeps unsaved changes; leaving
Admin discards an unsaved draft. A save already in progress can finish after
navigation and updates the current page when its response arrives. If the public
branding read fails, the interface uses the MySkills defaults and remains usable.
Unreadable custom images fall back to the built-in mark.

Branding does not change the landing-page toggle, permissions, marketing copy,
favicon, browser title, emails, CLI/MCP identity, package names or URLs.

## API and storage

`GET /v1/branding` returns public `{ "branding": { "text": "MySkills", "showText": true, "logoDataUrl": null } }`.
`GET /v1/admin/branding` and `PUT /v1/admin/branding` require an owner/admin session
with MFA; API tokens are rejected. Cookie writes retain origin checks. All three
responses use `Cache-Control: no-store`.

PUT takes the complete three-field branding object. `logoDataUrl` must be null or
a canonical base64 PNG/JPEG/WebP data URL. The API checks bytes, format structure,
file size and dimensions. PNG additionally checks chunk checksums and bounded
decompression; JPEG/WebP validation is structural, not full pixel decoding.
The process caches validation of one exact logo string to avoid repeating binary
work for unchanged settings; every public request still reads current settings.

The existing Postgres `instance_settings` table stores the bounded image and text
under key `branding`. No migration, object-store bucket or external image host is
needed. An absent row uses defaults. Writes serialize and commit atomically with
`admin.branding.update` audit events; the last saved value wins. Audit details
record old/new text and visibility plus image hashes, never image bytes. The
landing-page setting uses its own key and is unaffected.

Serve API and web from the same revision when deploying. Older web code ignores
the branding row; an older API causes the new UI to retain default branding and
report that the admin setting could not load.

## Verification

Use the repo-supported Node version and declared npm version. Build the browser
scenario dependencies before the focused browser test:

```sh
npm run build -w @myskills-app/core -w @myskills-app/auth -w @myskills-app/skill-package -w @myskills-app/api
npm run test:e2e -w @myskills-app/web -- branding.spec.ts
```

The browser test uses real API handlers and auth/storage implementations through
a test proxy. With `TEST_DATABASE_URL` set it resets that disposable test database
and uses Postgres; without it the browser test uses the memory store. The database
name must identify a test or CI database. This does not verify the production
reverse proxy or a deployment. `MYSKILLS_E2E_BROWSER_EXECUTABLE` can select the
approved local browser.

The test saves desktop/mobile screenshots and a verification attachment. It
covers persistence after reload, anonymous pages, live navigation during save,
drafts, save failures, invalid files, wide logos in collapsed navigation, keyboard
save, removal/discard and defaults. API tests cover all accepted formats, denied
roles/sessions/MFA, origin checks and malformed input. The Postgres audit test
covers rollback, fresh-store persistence and concurrent writes.
