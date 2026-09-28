# Beta.15 release delivery

Status: candidate preparation; publication and deployment are not yet verified.

## Scope and acceptance

The owner authorized implementation, push, deployment and release of browser
branding. Saved brand text becomes the tab title even when visible text is
hidden. The saved PNG, JPEG or WebP logo becomes the favicon after the browser
can decode it. Competing default icons are removed while a custom logo is active.
Drafts and failed saves do not change browser branding. Logo removal restores
default icons; MySkills text restores the original title and tagline. New pages
read saved settings. Other open tabs update on reload. A read/decode failure
retains defaults. Browser bookmark caches can retain older icons.

No API, database, dependency or authentication change is included. Social
metadata, Apple touch icons and installed-app manifests remain unchanged.
GitHub and hosted delivery are authorized; npm remains beta.8.

The extended real-API browser journey must detect missing title and favicon
updates and pass with the implementation. It covers desktop/mobile controls,
save during navigation, public pages, PNG/JPEG/WebP decoding, replacement,
removal, reset, failed saves and public-read outages. The exact clean candidate
must pass the canonical gate, protected CI, staging and tagged verification.

## Promotion and recovery

Deploy API first, require SUCCESS and direct readiness, then deploy web from the
same immutable source. Verify direct/proxied API and web versions, public catalog,
authentication, private package rendering, HTML caching and browser branding.
Retain exact deployment IDs and verify all published archive bytes and checksums.

The rollback pair is beta.14 source
`5647be19f15a8f9bb2c6b0ecfb067478b7528ed0`, API
`2ced5023-8288-4864-b9c5-87b550cb7362`, web
`be0c3cc6-037e-4e91-813f-b1347745d678`. No migration is required. Retain database,
artifact and branding data when rolling back. Check backup freshness before
production promotion.
