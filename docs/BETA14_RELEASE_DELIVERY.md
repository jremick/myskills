# Beta.14 release delivery

Status: candidate preparation; publication and promotion are not yet verified.

## Scope

The owner authorized branding implementation, then push, deployment and release
alongside QR enrollment. QR enrollment was already released as beta.13, so this
candidate builds on that release without changing its immutable tag or assets.
GitHub and hosted delivery are in scope; npm remains beta.8.

MFA-verified owners and admins can change the logo and brand text in Admin →
Branding. The shared identity covers landing, authentication and application
pages on desktop and mobile. PNG, JPEG and WebP files are limited to 256 KB and
2048 × 2048 pixels. Preview, save, discard, removal and reset are available.
Settings and audit events commit together in the existing instance-settings
store. No schema migration, new dependency or external image service is required.

## Acceptance

Before integration with beta.13, the general repository gate passed 1,206 tests.
The branding browser journey passed against the production build with real API
handlers and PostgreSQL: save/reload, public pages, save during navigation, failed
save and draft retention, invalid uploads, hidden text, wide and long branding,
mobile save, keyboard reset and unchanged landing-page settings.

The full macOS browser run had 86 passes and five failures. Four failures passed
on targeted retry; the remaining release-history keyboard failure also occurred
on unchanged main. The clean Linux canonical gate and exact-candidate CI must
pass before this release is published. The earlier local result alone is not
release verification.

## Promotion and recovery

Verify a clean immutable candidate with the canonical release gate, current
protected-branch CI and staging acceptance. Deploy API, wait for SUCCESS and
direct readiness, then deploy web from the same source. Verify all three version
endpoints, HTML revalidation, preserved session/authentication, private package
delivery and anonymous denial. Verify the Branding panel in the deployed UI.

The pre-promotion production pair is beta.13 source
`48273d5ff401ddcfd9046c448b1b38a58ee12337`, API
`89cc870c-a3bb-4f2f-a2b0-d1defa931a98`, web
`2d47a504-8b65-4d5d-b38f-2a96db71842d`. Check backup freshness before promotion.
Rollback uses that matching API/web pair, retaining database and artifact data.
The older app ignores the new branding row. Do not reseed or restore the database
for an application rollback. No writer-coordination change is required.

## Remaining limitations

Branding does not change favicons, browser titles, email content, package names,
CLI/MCP identity or marketing copy. A public branding read failure retains the
built-in identity and leaves the app usable. See [branding](BRANDING.md).
Physical scans of beta.13 QR enrollment with authenticator apps remain tracked
in issue #49; automated QR decoding is distinct from those client checks.
