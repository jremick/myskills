# Beta.12 release delivery

Status: GitHub prerelease published and production promotion verified on 27 September 2026. npm publication is excluded.

## Approved scope and design

The owner authorized all four Opus-led redesign waves through push, deployment and release. The work brings the approved Libraries design across Registry and mobile navigation; Submit, Review and Manage; Architectures, Connected targets and Updates; and Teams, Organizations, Admin, Settings and sign-in. Existing API, CLI, permission, exact-release, artifact and database contracts remain. No dependency or schema change is included.

Opus 5.5 passed the final visual review through the personal Claude Max subscription. The assistant transcript records `claude-opus-5-5`, and the attached runtime reports xhigh effort. It compared the final screens with Libraries references and earlier application captures. Map legibility, consent action emphasis, mobile review steps, unavailable update actions and Manage action order passed the recheck. Optional follow-ups concern mobile role-chip width, Organization archive placement and create-button consistency.

The review covered source `da2558a1825e0caf9b1304c7429b3fa2ae50479b`. Application source in beta.12 is identical; only two browser-test synchronization assertions, release versions and records differ. No visual reimplementation followed acceptance.

The local before/after gallery covers 15 workspaces and views with synthetic data. Final 12-route captures at 1440, 1280, 390 and 320 pixels reported no page errors, missing fixture routes or document overflow; 16 additional Admin states were checked. Screenshots establish appearance. Browser journeys establish interaction behavior.

## Candidate supersession and verification

[PR #95](https://github.com/jremick/myskills/pull/95) merged the redesign. The immutable beta.11 tag remains at its original source. Its tagged workflow failed when an Admin test started keyboard navigation after observing a request but before the confirmation dialog finished closing and restored focus. Production remained beta.10, and no beta.11 GitHub release or npm package was published. See [Beta.11 release delivery](BETA11_RELEASE_DELIVERY.md).

[PR #97](https://github.com/jremick/myskills/pull/97) added assertions for dialog closure and restored focus before the existing End-key assertion. The corrected desktop and mobile journeys passed 20 production-build runs with retries disabled. No application change was required.

The beta.12 source is `c280795e6f0bd54533514ab6c58af7a584cbd3a4`. PR #97 merged through the protected branch as `004883759dfec56de2aabb383bbe6f686faab83a`; its tree matches the tested source, which is an ancestor of main. All 12 protected-branch checks passed, including both supported Node versions, browser and PostgreSQL suites, Railway image builds and CodeQL.

The clean Linux canonical gate passed 1,194 repository tests, 80 route-mocked browser scenarios, eight real API/web/Postgres journeys and 241 PostgreSQL tests. No full-stack journey was skipped or flaky. Canonical evidence archive SHA-256: `768c741757610bfc0bf073e80672536320a0164b559dac4b17da265852838bfd`.

## Verified release

Immutable tag `v0.1.0-beta.12` points to the tested source. The [tagged workflow](https://github.com/jremick/myskills/actions/runs/36310605987) passed canonical verification, application and Railway image builds, and credential-free backup-image entrypoint smokes.

The [GitHub prerelease](https://github.com/jremick/myskills/releases/tag/v0.1.0-beta.12) contains five assets. The uploaded sizes and GitHub SHA-256 digests match the local files. The workflow's source archive, metadata and checksums match the prepared files byte for byte.

- Source archive SHA-256: `b2026e87efb47b0ccdef3c7d621148a8dcf613fc61b13c0961483fc7207f5cd6`.
- CLI archive SHA-256: `bf812f067a75cc88abba972799020b8d3213a5aea7c346a6b264368321bbc28c`; size 306,996 bytes.

The CLI archive passed a fresh installation, version readback, example validation, scan and file allowlist inspection. npm still reports beta.8; latest and alpha remain alpha.3. The beta.12 CLI archive is a GitHub asset.

## Staging and production

Staging API `d0385455-76d9-4d9d-b48a-de0f0cf1cef6` reached readiness before web `0feb0259-4906-483e-a025-9ab80b859f14` deployed. Both report SUCCESS and beta.12 with the tested revision. Fourteen HTTP checks passed across direct API, same-origin API and web identity, health/readiness, three catalog views and anonymous denial of an actual private bundle.

Fresh staging browser login succeeded. Package inspection returned HTTP 200 with the expected two-file manifest and 552-byte response. SHA-256 matched the preceding candidate: `28f6fb9596f5254613c00c3a5514388602b9b854413a59318aeb54e97c9b98c0`. The identical application source had also preserved stored Library references and correctly locked Admin for a session without MFA. Temporary staging sessions were signed out; no password, MFA factor or permission was changed.

Production API `9cf1264b-6903-4806-abed-23a446d580ee` reached readiness at 10:02 UTC before web `fb7a2b03-ea8c-4698-84f5-396d5b5c6ccc` was promoted. Both report SUCCESS and version beta.12 with revision `c280795e6f0bd54533514ab6c58af7a584cbd3a4`. The 610-file deployment archive matched the tested Git source. Normal API startup ran; no owner seeding or schema downgrade occurred.

Fourteen production HTTP checks passed. The existing MFA-verified owner session remained usable. Browser acceptance confirmed the redesigned Registry, exact release selection, Admin tab keyboard navigation and the Email, Password, MFA and API keys sections. End selected and focused the Audit tab. No browser console errors or document overflow were observed in these checks.

Authenticated package inspection returned HTTP 200, four files and 17,300 bytes. Its SHA-256, `946f089187f096b7f8e48828b1a0a4e139402e489e29d3fa750002f17ce4c119`, matches the pre-promotion browser response exactly. Anonymous access to that private release returned 404. Verification inspected the browser network response; it does not claim a filesystem download. Private package contents were not retained in the evidence files.

The fresh beta.12 CLI passed all nine doctor checks and anonymous catalog browsing. Sampled logs showed no application fault patterns in 77 API and 95 web entries. Railway labelled 54 nginx startup notices as errors because they used stderr; none had an nginx error, critical, alert or emergency level.

## Recovery and limits

The completed backup captured at `2026-09-26T16:00:54.194Z` passed the existing 26-hour freshness policy before promotion. Its manifest SHA-256 is `172c83c83d6d31cc3521d4fc97c99ab55e747a6d8aedcfce73d9bcd1fd3eb4dd`; the recorded check age was 64,168 seconds. This proves freshness and a completed manifest, not a new capture or restore.

The verified pre-promotion baseline was beta.10, source `084b48e4bce0e8693357f7a4f89d7aabf8ff89f4`, API `a73367e7-94c5-4f31-a6aa-917f8002e5f0` and web `77cdfa45-cd97-4564-8f34-f4487edfc499`. For a material runtime regression, deploy the previous API, verify readiness, then deploy its matching web. Retain the bundle-aware schema, references and audit records. Do not downgrade the database, reseed the owner, change production credentials or perform a destructive restore.

MySkills remains public beta. The visual review's optional polish is recorded above; screenshot checks do not prove all interaction states. Documentation-only follow-up commits do not change the deployed source revision.
