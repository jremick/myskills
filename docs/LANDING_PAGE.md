# Public homepage

MySkills opens with a marketing page for people managing their own AI skills and administrators managing shared skills. The examples use illustrative data; the page does not fetch personal libraries or team activity. Public browsing, sign-in and self-hosting documentation use real links.

## Instance setting

An owner or administrator with an MFA-verified session can open **Admin → Landing page** and change **Show landing page**. Changes take effect after **Save landing setting**. **Discard** restores the last loaded or saved value. A failed save retains the draft so the administrator can retry.

- On (the default): `/` shows the homepage.
- Off: `/` replaces its history entry with `/login`. Existing authenticated-login routing still applies.
- `/login` always works; its public-site and linked-brand controls appear only after the setting is confirmed on.
- Public registry, exact skill URLs, invitation, recovery and verification URLs keep their existing behavior.
- Registration, account permissions, API, CLI and MCP access are independent of this setting. Hiding the homepage is not an access control.

The browser resolves a fresh public setting before rendering the homepage. It shows a neutral loading state, then retry/sign-in options if the read fails or times out. It does not cache an enabled default in browser storage. Navigation within the homepage does not refetch the setting.

## API and storage

`GET /v1/site` returns `{ "site": { "landingPageEnabled": true } }` and `Cache-Control: no-store`. It exposes no account data or other instance settings.

`GET /v1/admin/site` and `PUT /v1/admin/site` require an owner/admin session with MFA. API tokens are not accepted. PUT takes `{ "landingPageEnabled": false }` with a strict boolean value. Cookie-authenticated writes retain the existing origin checks.

The setting uses the existing Postgres `instance_settings` table under key `site`. An absent row defaults to enabled; no migration is required. Setting writes and `admin.site.update` audit events commit together. Audit details include the previous and new values. Concurrent writes use the existing serialized instance-setting pattern; the last saved value wins.

## Deployment and rollback

Ship API and web from the same revision. Deploying the web before the new API causes the homepage to show its retry/sign-in fallback; `/login` remains available. Verify enabled and disabled root visits after deployment. A rollback can revert the application code without a schema migration. The old application ignores the `site` row and shows its previous homepage.

## Verification

The API route tests cover defaults, strict input, public projection, MFA/session/role enforcement, save/readback and audits. The Postgres audit test covers rollback on audit failure and persistence through a new store instance. Browser UI tests cover pending/error root configuration, disabled routing, direct links and save/failure/discard behavior. The approved responsive design also requires desktop/mobile browser and keyboard checks.
