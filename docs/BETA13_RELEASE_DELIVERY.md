# Beta.13 release delivery

Status: candidate preparation; publication and live promotion are not yet verified.

## Scope

The owner authorized the MFA enrollment QR change, then push, deployment and release.
The browser renders the exact API enrollment URI with `qrcode.react` after password
verification. The manual secret and URL remain available. API behavior, six-digit
confirmation and one-time recovery-code display are unchanged. No schema migration
is included. GitHub and hosted delivery are in scope; npm remains beta.8.

## Acceptance and checks

Before this version update, repository checks passed 1,194 tests with two existing
Linux-only filesystem tests skipped on macOS. The standalone production-like
full-stack suite passed all eight journeys on the Windows-hosted Linux runtime.
Desktop and mobile tests independently decoded rendered QR pixels with `jsqr`,
checked manual fallbacks, invalid-password and code retries, persisted enabled
state, one-time recovery display, and request/console/storage privacy.

The tests failed when the QR was absent and when the payload was deliberately
changed to the bare secret. Both controls were removed before delivery. Screenshots
mask the QR, secret, setup URL, password, setup code and recovery codes. Automatic
MFA traces, videos and failure screenshots are disabled.

The macOS browser suite passed 91 of 92 scenarios. An existing release-history
keyboard test also failed against unchanged application source. The final clean
Linux canonical gate and protected-branch CI must pass before release.

## Promotion and recovery

Deploy the API and wait for success and direct readiness before deploying the web
from the same immutable source. Verify staging before production, then compare
all three version endpoints, HTML cache behavior, existing-session authentication,
authorized private package delivery and anonymous denial. Preserve account MFA
settings during live checks.

There is no migration or writer-coordination change. The pre-promotion production
pair is source `d8775d6b07e2de06b7af4cbdc6bee1a33455902d`, API
`49a2bc94-2db8-432f-8611-4339c2cdd124`, web
`77bf8274-c816-4095-ba14-38ad3c061f9b`. Verify recovery-point freshness before
promotion. Roll back to the matching API/web pair if a material regression occurs;
retain the existing database and artifact data.

## Remaining acceptance

Physical scans with 1Password, Google Authenticator and Microsoft Authenticator
have not been performed. Automated QR decoding and an independent TOTP calculation
prove the encoded URI and API confirmation path, not those clients' scan behavior.
Issue #49 remains open for that acceptance work.
