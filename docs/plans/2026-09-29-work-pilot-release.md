# Work pilot release

Target: `v0.1.0-beta.16`. Implementation, canonical verification, staging/production
acceptance, and GitHub/npm publication are complete. Work-instance setup remains
a separate future deployment.

## Approved outcome

Two people can install the published CLI, select separate work configurations,
enroll Codex or Claude inventories, separate projects from global ownership,
and share reviewed skills through existing team libraries. The release includes
the web/API deployment, npm beta package, and GitHub prerelease.

The first pilot supports macOS and Linux. Scope enrollment is read-only and does
not change native skill discovery or inheritance. Existing managed Codex project
installation remains the supported writer. Automatic global or Claude updates,
company SSO, private GitHub connections, native Windows filesystem support,
and actual employee-account enrollment are outside this release.

## Delivery slices

1. Integrate the existing global/project scopes implementation with current main.
2. Add provider/scope onboarding and useful inventory status to Connected targets.
3. Add named CLI configuration isolation while preserving default credentials,
   state paths, and target bindings.
4. Replace whole-observation word rejection with structural validation and a
   narrow validated-slug exception, through a forward migration. Older servers
   retain the compatible withholding behavior.
5. Exercise submission, review, team sharing, installation, update, and revoked
   access with two non-admin users and a separate reviewer on disposable data.
6. Verify a clean candidate, merge through required checks, publish the exact
   CLI archive, and promote API before web from the same immutable source.

## Acceptance

- Fresh package installation and existing default configuration upgrade work.
- Named configurations on the same registry do not share credentials or scope
  bindings. A work selection cannot overwrite or reuse a personal session.
- Separate Codex and Claude global targets remain idempotent, read-only, and
  private to their authorized owners. Enrollment retries preserve target IDs.
- Project exclusions and managed workspace migration preserve target identity
  and skill bytes; stale migration plans fail and backups are readable.
- The app produces correctly quoted setup commands and explains partial
  inventories without exposing local paths or skill contents.
- Valid skill slugs containing words such as `config` can be observed after
  migration. Unknown fields, credentials, bodies, and paths remain rejected.
  Historical observations are retained without claiming they were revalidated.
- The consumer can install and update a reviewed, adopted team skill; removing
  authorization prevents further delivery and preserves installed files.
- Release verification, PostgreSQL tests, browser journeys, package smoke,
  supported Node CI, and image checks pass for the final candidate.
- npm archive integrity, exact-version and beta-selector installs, deployed
  API/web identity/readiness, and rendered acceptance are read back separately.

## Operational boundaries

Use the established staging and production services. Reuse documented auth and
backup workflows; do not create a new credential route. Use the verified Windows
Docker Linux host for disposable container workloads. Keep personal evidence
and live inventory details in ignored output, outside the public source tree.

Stop dependent promotion on a failed required check, uncertain deployment,
missing recovery point, incompatible migration, or unresolved account mismatch.
Resolve uncertain writes by remote readback before retrying. No reseeding,
database downgrade, or destructive restore is part of normal release delivery.

The later work rollout will use a separate work-hosted instance. Both
participants will use macOS with Codex and Claude Code. Infrastructure details
and work-instance authorization remain deployment inputs; this release does not
create that instance or upload work content to the personal test instance.

## Evidence

Implementation workers record focused evidence under ignored
`dist/work-pilot-verification/`. The release record must distinguish the tested
commit, merged commit, tagged artifacts, npm publication, and deployed services.
Passing earlier scope tests or live enrollment does not replace the release gate.

## Delivery evidence

The frozen candidate/tag is `acfb7c8c7f8bc560f6fdba13cf0414033ab6d00e`.
The frozen release excludes later GitHub authentication and team Library changes
on main. Canonical, CI, tagged-artifact,
staging, native upgrade, and observation-preservation evidence is recorded in
[Beta.16 release delivery](../BETA16_RELEASE_DELIVERY.md). That record separates
npm registry verification, GitHub publication, and production acceptance.
