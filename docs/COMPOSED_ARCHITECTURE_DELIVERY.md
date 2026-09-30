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
A success receipt follows complete aggregate readback, manifest persistence and
current authority. Interrupted apply/receipt and explicit rollback can resume
under a still-valid claim or a newly approved rollback fence. Read/failed-check
helpers never restore exposure. A forbidden or altered baseline stays quarantined.
Same-OS-user concurrent path replacement remains the existing filesystem-helper
trust boundary; this does not provide a sandbox against that OS principal.

## Criterion bindings and evidence limits

| Criterion | Source and acceptance binding | Outstanding acceptance |
| --- | --- | --- |
| ARCH-02 | Existing exact-review route/CLI/MCP/browser tests plus current credential checks in `plan-service.ts`/`postgres-store.ts`; `postgres-architecture-plan-authority.pgtest.ts` adds actual API lock-wait revocation/no-write controls. | Canonical PostgreSQL execution and independent review of this candidate. |
| ARCH-03 | `architecture-artifact.test.ts` covers all topologies. API tests cover separate approval, current fences and no repeated downloads. CLI e2e tests install/verify/update/rollback two enrolled multilevel byte fixtures with mixed pins/profile denials, disable/removal, interruptions, drift/link/collision and forbidden rollback. | Canonical shared-lease/SQL constraint/object-backed PG tests; maintained fullstack `operational-journey.spec.ts` invokes the required real MinIO composed exact-byte journey and records its named check. HOST railway-images rehearsal also requires a named composed MinIO byte/permission-denial/no-intent receipt and checks persisted intent after restore. Actual host recognition/consent stays separate. |
| ARCH-04 | Existing graph editor/migration source remains. `ArchitectureArtifactHandoff` and browser/MCP transport tests bind selected saved review to intent and exact pins, then display trusted-companion commands and receipt limitations. | Full canonical browser/runtime and actual connected-host acceptance; byte fixtures alone do not complete the full architecture lifecycle thesis. |

`docs/capability-parity.json` records stable ARC-11 coverage and evidence levels.
Generate its matrix with `npm run docs:parity`; static coverage is not runtime
parity. Run details and exact candidate SHA are recorded in the parent delivery
reports. No release, publication or deployment is authorized by this document.
