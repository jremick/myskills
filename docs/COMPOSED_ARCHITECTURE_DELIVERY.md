# Composed Codex workspace architecture delivery

Contract: `codex-workspace-architecture/v1`. This source delivers a composed tree
through an explicitly enrolled local workspace. Ordinary `TargetSkillOperation`
keeps its existing contract. An approved architecture review remains review-only.
The source and local byte fixtures do not establish provider recognition, runtime
policy enforcement, signed-in host consent, deployment, or roadmap completion.

## Authority and immutable intent

The API stores immutable intent beside the existing sync run in migration 0041.
Intent pins selected exact revision, compiled graph and ordered router digests,
profile/environment, target identity/generation/adapter/capabilities, current policy
and consent, authoritative observation, approved package digest/size/platform,
materialized file/tree hashes and prior composed baseline identity. Organization
targets need the receiving organization's architecture and release grants even
when the actor owns the source. Historical private references are withheld from
organization plan/artifact history.

Production prepares and consumes intent inside the existing PostgreSQL target,
actor, membership, sharing, architecture, release and upgrade-policy authority
transaction. Session/token or OAuth grant identity and applicable scopes/assurance
are checked after waits with `clock_timestamp()`. Intent preparation downloads
verified object-backed package bytes once. Later boundaries reauthorize current
exact release metadata without repeating payload downloads or artifact-access
writes. Missing-object fallback and storage permission/provider failure behavior
remain owned by the existing verified artifact reader.

A memory review store cannot execute this contract. The local tests explicitly
install a shared fixture coordinator; that coordinator is test authority only.
Execution needs a distinct actor approval of intent, whole staged tree and whole
baseline. The fixed approval/lease window is 600 seconds. The existing target
lease table, ordinary-operation mutual exclusion and monotonic fence are shared.
Expired or lost claims cannot continue promoting bytes. No lease renewal is added.

The approval stores a compact immutable intent digest, which covers both staged
tree and baseline within the existing SQL metadata bounds. Checkpoints, receipts
and receipt replay require the authenticated forward approver. Explicit rollback
records its own actor, holder and new fence; that actor may differ from the forward
approver. Organization policy digests bind receiving authority rather than unrelated
personal-owner privileges. Current target and organization maintenance windows,
credential expiry and MFA are checked after desired and baseline release lock waits.

## Guided protocol

| API operation | Outcome |
| --- | --- |
| `POST /v1/architecture-targets/:id/artifacts` | Prepare immutable intent from an approved review and optional exact baseline run. |
| `GET /v1/architecture-artifacts/:id` | Inspect intent and recorded receipt; no filesystem execution. |
| `POST /v1/architecture-artifacts/:id/approve` | Bind separate execution approval to `expectedIntentDigest`, `treeDigest`, `baselineDigest`. |
| `POST /v1/architecture-artifacts/:id/claim` | Claim the existing shared target lease for the approved actor and holder. |
| `POST /v1/architecture-artifacts/:id/checkpoint` | Recheck current authority and holder/fence before a local mutation. |
| `POST /v1/architecture-artifacts/:id/receipt` | Accept exact aggregate readback under the current fence. |
| `POST /v1/architecture-artifacts/:id/rollback` | Explicitly approve and claim restoration of the exact still-authorized baseline. |

Use an existing application session or a current MFA-verified scoped token with
`targets:read`, `targets:control`, `targets:execute`, `architectures:read`, and
`skills:read`. OAuth delegated actions can prepare/inspect intent with applicable
current scopes and assurance. OAuth cannot approve or claim host execution.
Browser and MCP show intent and hand off to the enrolled CLI:

```sh
myskills architecture-artifacts create <target-id> --input <request.json> --workspace <absolute-project-workspace>
myskills architecture-artifacts prepare <run-id> --workspace <absolute-project-workspace>
myskills architecture-artifacts apply <run-id> --workspace <absolute-project-workspace>
myskills architecture-artifacts verify <run-id> --workspace <absolute-project-workspace>
```

Optional recovery requires current authority for the exact baseline:

```sh
myskills architecture-artifacts rollback <run-id> --workspace <absolute-project-workspace>
```

Create input contains `reviewRunId`, nullable `baselineRunId`, and
`idempotencyKey`. Local prepare downloads and hashes the complete tree. Apply
requests execution approval only after exact staging and baseline verification.
Verify compares current bytes and the API receipt; it does not restore files.
There is no automatic workspace discovery, daemon or provider execution.

## Filesystem and recovery

Flat, domain-router and multilevel projections preserve effective nodes and
ordered routes, including an optional exact router package. Only effective
nodes get `.agents/skills/ms-<architecture-hash>-<node-hash>/SKILL.md` discovery
entries. Generated labels are escaped. Routing prose explicitly states that it
is guidance. Package bytes retain their original relative layout beneath the
private workspace `.myskills-app/architectures/<hash>/active/` tree. Context,
staging, journals, prior trees and quarantine stay outside discovery.

Enrollment and execution reject workspace roots inside Codex or Claude project
discovery trees and roots overlapping another enrolled managed workspace. Validation
uses canonical ancestry and a bounded directory-only search for local bindings
(10,000 directories, depth 64); an unprovable isolation boundary is refused before
staging or approval. Disjoint workspace roots remain supported.

The companion holds the same whole install-root lock as ordinary installation.
It pins workspace/discovery device and inode plus existing registry provenance.
It refuses unmanaged namespace collisions, altered owned bytes, path traversal,
case/portable-name collisions, symlinks, hardlinks and root replacement. Removal
uses only unchanged prior manifest-owned entries. Unrelated files and ordinary
workspace bindings remain intact. Limits are 256 KiB intent/context, 16 KiB per
generated discovery entry, 2,000 materialized files and 16 MiB aggregate bytes.
Journals contain relative owned paths, hashes, state and opaque IDs, with no
package text, prompts, credentials or absolute workspace paths.

Multiple directory moves are not atomic. Durable per-path intent records exact
partial states before each move; replay validates both named and relocated bytes.
Transaction and recovery directory chains are synced through the workspace root.
Nested staging directories are synced before approval. After a rename, the
destination parent is synced before the source parent, so source removal cannot
be committed before its recovery or promoted name. Directory-sync failures retain
partial state and prevent further destructive moves or a success receipt.
A success receipt follows complete aggregate readback, manifest persistence and
current authority. Interrupted apply/receipt and explicit rollback can resume
under a still-valid claim or a newly approved rollback fence. Read/failed-check
helpers never restore exposure. A forbidden or altered baseline stays quarantined.
Same-OS-user concurrent path replacement remains the existing filesystem-helper
trust boundary; this does not provide a sandbox against that OS principal.

## Criterion bindings and evidence limits

| Criterion | Source and acceptance binding | Outstanding acceptance |
| --- | --- | --- |
| ARCH-02 | Existing exact-review routes and current credential checks; `postgres-architecture-plan-authority.pgtest.ts` observes actual target/writer locks and a successful first approval write before rollback. Real organization history/grant cases live in `postgres-architecture-artifact.pgtest.ts`. | Windows-owned PostgreSQL execution and independent correction review. |
| ARCH-03 | Core topology projection; API compact approval, actor and maintenance-window regressions; CLI two disjoint byte fixtures, actual router disable, unrelated-path preservation, directory-sync ordering/failures and overlapping-root refusal. Current-schema PG cases add approval readback, shared leases, distinct rollback actor, baseline-only credential expiry waits and actual window closing. | Final exact-candidate Windows execution remains required. HOST backup uses the owned bridge gateway, assigned scoped port and TLS IP SAN. Exact5128 failed endpoint readback; fixed state/network/port diagnostics are prepared for Linux retry. Actual host recognition/consent stays separate. |
| ARCH-04 | Existing graph editor/migration source remains. `ArchitectureArtifactHandoff` and browser/MCP transport tests bind selected saved review to intent and exact pins, then display trusted-companion commands and receipt limitations. | Full canonical browser/runtime and actual connected-host acceptance; byte fixtures alone do not complete the full architecture lifecycle thesis. |

Historical correction checks on the frozen combined source at `097cd50`
passed 34 API/CLI contract cases,
five focused CLI boundary cases and both admin keyboard cases (1440 and 390).
The API/CLI/MCP/core/package builds, web typecheck and strict compile of the four
changed PostgreSQL fixtures passed. Pre-merge HOST source fixtures passed 8/8.
These are supporting local receipts. Real PostgreSQL locks/serialization,
MinIO/Linux backup setup, fullstack and host recognition remain Windows-owned.
The canonical seven failed jobs and failed HOST cleanup receipt are retained.

The later exact `5128bb8` diagnostic completed on 1 October 2026. Both general
checks passed; both PostgreSQL lanes had 306 passes and six failures, including
an early production-process exit before the exact DB blocker. Mocked browsers
had 193 passes and one skip per lane; fullstack had eight passes and two failures.
Five image builds/smokes passed; HOST stopped at backup endpoint readback.
Current inner/HOST cleanup completed without replacing the older failed receipt.

Current source corrects the process fixture's notification configuration,
canonical fixture identities, private suite restore binding, common OS-user
enrollment authority and pre-correction nonempty-plan replay. Legacy IDs/digests
stay immutable; new generated IDs remain namespaced. The browser draft exercise
shares the operational actors and explicitly accepts dirty-import replacement.
Actual process lifecycle, final SQL, fullstack and complete HOST restore remain
unproven until the corrected exact candidate runs. Local receipts and independent
review belong to their exact checkpoints; historical evidence remains retained.

`docs/capability-parity.json` records stable ARC-11 coverage and evidence levels.
Generate its matrix with `npm run docs:parity`; static coverage is not runtime
parity. Run details and exact candidate SHA are recorded in the parent delivery
reports. No release, publication or deployment is authorized by this document.
