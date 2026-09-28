# Team Library sourcing and tracking

Status: local implementation and disposable-environment verification approved on 2026-09-29. Publication and deployment are outside this approval.

## Outcome

Team curators can source public GitHub skills, review changes, and maintain adopted recommendations without a contributor's personal Library owning the workflow. Existing team owners are curators. Organization-owned Libraries, private GitHub authentication, Collections/Groups redesign, ownership transfers, unattended local updates, external notification channels, and native plugin execution are outside this change.

The baseline is `fe88fdca056dd0017dbe46d99d228ad448932df5`. It supports team curation of authorized releases and reference-only sources. Source operations, import lineages, and scheduled checks are personal-only at that revision.

## Ownership and authority

- The API derives import ownership from the Library. A team owns its imported skill and lineage; importer, reviewer, and adoption actors remain separate attribution.
- A lineage is unique within its owner scope, repository identity, path, and ref rule. Libraries retain independent adoption pins and notification audiences.
- Effective team owners manage sources and candidates. Imports also require existing author permissions and token scopes. Team writes retain MFA requirements.
- The first team import uses team visibility and an owning-team registry grant. Later imports preserve explicitly changed visibility and cannot silently restore a revoked owning-team grant. Registry review/publication and delivery checks remain authoritative. Private self-review is personal-only.
- Team members read authorized recommendations, subscribe, and explicitly install/update their own targets. Library membership does not grant access to unrelated private skills or pending candidates.
- Public-source checks use the team's saved configuration, not the initiating person's identity. They continue when that person leaves and another eligible curator remains. Loss of all eligible curators pauses checks until deliberate resumption.
- Membership, active-user state, parent-organization policy, and release grants are checked at the relevant read and transaction boundaries. Revoked access must not survive a stale preflight.

## Separate user actions

Saving records a reference. Following configures source checks. Subscribing opts into inbox events. Importing creates a submission. Instance review permits publication. Adoption selects the team's exact recommendation. Explicit installation or updating changes local files.

Candidates and source health events reach current eligible subscribed curators. Adoption events reach current eligible subscribed members. Unsubscribing does not stop tracking. Failed checks never imply unchanged source content.

## Compatibility and migration

Add team ownership to canonical skills, import lineages, candidates, and provenance. Preserve personal records and immutable historical attribution. Preserve orphaned skill slugs as unavailable for takeover. Team deletion must not remove owned release history. Do not turn a contributor-owned reference into a team-owned release.

Existing personal imports, private self-review, registry grants, adoption pins, and target bindings retain their behavior. A replacement team lineage requires explicit adoption/rebinding. Access loss blocks new resolution and updates, leaves local files intact, and never falls back to registry latest. Older application code must not be used after team-owned writes without a tested compatibility strategy.

## Failure scenarios and acceptance

These scenarios are specified before production edits. The primary boundary is the real HTTP API with disposable Postgres and deterministic GitHub transport; browser tests prove the UI workflow and CLI tests prove file application behavior.

| ID | Scenario | Required result |
|---|---|---|
| T01 | Two curators select public source roots, import, obtain instance review, publish, and adopt | Stable team ownership, exact digests, explicit team grant, persistent adoption |
| T02 | Initiating curator leaves before import completion | Removed actor denied; remaining curator continues the same lineage; original attribution retained |
| T03 | Curator is revoked after HTTP preflight, before commit | No unauthorized import/adoption and no partial submission or provenance |
| T04 | A member or outsider attempts source/candidate management | Denial without candidate content or unrelated private-skill disclosure |
| T05 | A token lacks author role, scope, or team-write MFA | Actionable denial; token authority is never broadened |
| T06 | Selected supporting files change; unrelated files later change | One relevant candidate/event, then none for unrelated content; no automatic adoption or installation |
| T07 | Two Libraries in one team use a lineage and check on different schedules | One owned lineage; independent recommendations and scoped notifications, including an existing revision imported before the second Library checks |
| T08 | Competing curators or retries import the same candidate | No duplicate version; stable replay or explicit conflict |
| T09 | All effective curators disappear, including parent-organization revocation | Checks pause; no new unauthorized delivery; explicit resume after authority restored |
| T10 | Member or release grant is revoked | Subsequent inbox, resolution, export, and update delivery are blocked |
| T11 | Team candidate attempts private self-review or ordinary submission injects ownership | Rejected; ordinary review and server-owned ownership remain mandatory |
| T12 | Existing personal import, binding, local edit, or required action | Existing protections and personal ownership remain unchanged |
| T13 | Migration runs over populated personal/orphan records | Data preserved; invalid mixed owners rejected; no slug takeover |
| T14 | Source identity, package, dependency, or rights checks fail | Existing explicit blocker; no skipped bytes, review bypass, or silent conversion |

## Concrete source journey

Use an Engineering Library and `https://github.com/everyinc/compound-engineering-plugin`. The paths `skills/ce-plan` and `skills/ce-code-review` exist at upstream commit `5e3aee1a29d2d106d5deec9dd845698b76b6ca17`. This is source evidence, not an import or host-compatibility claim. A live pinned preview must record current blockers. Deterministic transport fixtures exercise updates and races without mutating an upstream repository.

## Verification and evidence

Run the repository gate, disposable Postgres journeys, relevant browser and CLI journeys, and full-stack verification. Preserve a repeatable artifact containing the source revision and input fingerprint, provider fixture/upstream commits, scenario receipts, artifact digests, owner and audit readbacks, CLI file checksums, screenshots, and browser results. Exclude credentials and package bodies from receipts.

Use test-owned databases and resources only. Prefer the approved remote container host and transfer exact source inputs. Any local container fallback requires separate confirmation. Test artifacts and runtime state stay outside tracked source.

With the repository's declared Node/npm versions and a disposable `TEST_DATABASE_URL`, the focused API and populated-migration journey is repeatable with:

```sh
npm run build
node --import tsx --test --test-concurrency=1 apps/api/test/team-library-journey.pgtest.ts
```

The browser and CLI journey uses a separate disposable database. It starts a real HTTP API and built web UI, persists package bytes in Postgres, and substitutes only deterministic public GitHub transport. It exercises real authentication, instance review, team adoption, CLI installation, and denied updates after revocation:

```sh
VITE_API_BASE_URL=/api npm run build -w @myskills-app/web
node_modules/.bin/playwright test --config scripts/test/team-libraries.playwright.ts
```

The existing `npm run test:e2e:fullstack` remains the production server and object-storage wiring check. The deterministic browser fixture does not replace that gate or establish that the live upstream packages pass the scanner.

Stop for a scope decision if satisfying these contracts requires broader organization ownership, a new authentication route, ownership transfer, weakening package/review checks, or an incompatible migration that cannot preserve existing data.
