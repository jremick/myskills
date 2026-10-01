# Architecture lifecycle delivery

This work advances discover → govern → version → share → compose → inspect →
safely update. Architecture revisions remain the API-owned source of truth.
Physical targets bind a logical profile and environment to a supported adapter.

## Bounded wave: persisted review plans

Persist a dry run for an exact revision and trusted target observation. Retain
inspectable steps and metadata-only fences in the existing sync journal. Expose
create, list, inspect and explicit review approval through API, CLI, MCP and the
connected-target inspector. Review approval does not schedule or execute writes.

No new registry, sync engine, runtime, dependency, provider or credential route
is required. Revert the feature wiring to remove the new surface; retained journal
rows remain valid history. No release, deployment or actual target pilot is in this
wave.

## Failure scenarios written before implementation

1. Transport loses the selected revision, observation digest or generation and
   silently creates a plan for a different input.
2. Retrying a create generates a second run or returns a different immutable plan.
3. A steps-only digest is accepted as approval of the complete review envelope.
4. Target generation, observation, capability, consent, profile or release policy
   changes after review and approval proceeds with stale evidence.
5. An unauthorized reader learns another target's history or writes plan metadata.
6. Concurrent approval loses a receipt, changes an immutable approval or admits
   two distinct approvers.
7. Revocation hides retained history or permits a new review approval.
8. A fixture apply result or approval is presented as actual target execution.
9. Switching target selections displays or approves an earlier target's result.
10. Missing input, unexpected options, unknown fields or malformed identifiers
    reach a mutating endpoint before validation.

The primary domain proof is the API journey with real services and in-memory
authorities. Transport journeys exercise public CLI and MCP dispatch. Browser
evidence establishes inspection and explicit review UX. PostgreSQL persistence,
real host acceptance and deployed proof remain separate evidence layers.

## Current composed candidate

The API, CLI, MCP and browser now integrate the guided
`codex-workspace-architecture/v1` contract. This source preserves the full
router → router → leaf thesis, exact versions, profiles and environments.
Separate execution approval, one shared lease, whole-tree staging/readback and
explicit rollback replace the earlier proposed delivery gap. Review approval
remains permanently non-executable. See
[COMPOSED_ARCHITECTURE_DELIVERY.md](COMPOSED_ARCHITECTURE_DELIVERY.md).

| Outcome | Current source | Remaining acceptance or intentional boundary |
| --- | --- | --- |
| Discover | Authorized deterministic task retrieval and explorer | Model benefit and real provider recognition are unverified. |
| Govern | Current API tenancy/grants/profile/target/release policy | Provider-derived roles and conditional runtime enforcement remain deferred. |
| Version | Immutable revisions, exact release pins and owned context artifact | Deployed readback pending; durable visual layout is deferred. |
| Share | Current API grants with CLI/MCP management | Public architecture publication remains unselected. |
| Compose | Whole-artifact API intent and enrolled Codex companion | Canonical SQL/MinIO/process and actual host consent/recognition pending. |
| Inspect | Graph/history, saved review and composed intent/receipt handoff | Canonical browser and current receiving-organization denial proof pending. |
| Safely update | Whole-tree baseline, fences, current execution windows and rollback journal | Canonical interrupted transitions and independent correction review pending. |

Two disjoint enrolled Codex workspaces have local byte-fixture journeys. They
are two separate tool instances; each keeps its own identity, consent, approval,
lease and receipt. They do not prove a signed-in host recognized the entries.
Broader providers and optional telemetry remain downstream decisions. Diagrams
remain derived exports, without a second visual source of truth.

## Historical pre-composition contract decision

The following proposal records the decision that led to the implemented guided
contract. Its future-tense statements are historical planning, not present source
gaps. Current behavior and limits are above and in the composed delivery record.


The existing `TargetSkillOperation` queue accepts install/update/rollback with
one slug/version/artifact. It cannot deliver configure-router, enable, disable,
remove or a profile context artifact. Persisted review is therefore a completed
source slice only after its checks; full architecture delivery remains an
implementation decision as well as an external acceptance task.

The smallest extension would introduce a versioned architecture artifact intent
that references an exact immutable revision and approved review digest. It must:

1. Negotiate explicit adapter capabilities for router configuration, exposure
   changes, removal and context artifact installation; unknown capabilities fail
   closed. A read-only adapter cannot be promoted by a caller's flag.
2. Describe deterministic package pins, router/exposure metadata and a context
   artifact digest. Paths, prompts and credentials remain local to the supported
   target companion. Logical profile/environment identifiers remain distinct
   from a physical target binding.
3. Bind approval to target generation, fresh observation, current policy/consent,
   capabilities, release lifecycle, ordered intent and artifact digest.
4. Reuse the existing target lease and fencing counter for queue claims. Each
   execution/recovery boundary rechecks authority; revoked or stale work stops.
5. Bind readback receipts to the exact approved artifact and generation. Partial
   or ambiguous delivery requires a recorded baseline and existing trusted
   recovery flow. Retrying cannot synthesize success or bypass approval.
6. Preserve immutable plan, approval, receipt and topology history. Never copy
   source target bindings, grants or consent during derive-shell migration.

| Approach | Result and source changes | Acceptance and security | Cost and limitation |
| --- | --- | --- | --- |
| Guided verified artifact export/install | Compile one deterministic architecture delivery artifact; operator inspects it and invokes an explicit companion install for one target. Reuse package installer validation, local conflict checks, leases and receipt readback. | Fixture contract tests cover topology/profile denials, exact pins, unsupported adapters, stale fences, partial install and rollback. Actual target consent and host recognition remain separate. | No model/provider calls. Smaller queue/orchestration change, but export is not delivery and operator completion must be read back. |
| Automatic graph executor | Extend queue intent to each router, exposure/removal and package step; bind whole graph approval, preflight and rollback to one context artifact. | Requires step capability negotiation, admission/order validation, shared lease, partial failure/compensation and independent security review before target activation. | No model calls required, but materially larger protocol, companion and recovery surface. Current per-skill receipts cannot establish graph success. |

Recommend the guided verified artifact path first if a supported companion can
install that artifact with bounded conflicts and rollback. Automatic graph
execution follows only after the artifact and companion contracts are agreed.
The outstanding decision is the supported local artifact format and companion
operation, including router storage/exposure semantics and rollback baseline.
This document does not invent a platform contract or authorize a live pilot.

Verification results and the exact reviewed commit are recorded at closeout.

## Wave2 integration source state

Shared API production registration, CLI/MCP dispatch and browser entry paths are integrated on the roadmap candidate. Historical leaf-check receipts above remain historical and are not whole-candidate acceptance. Current Node22 source/narrow checks and parent canonical PostgreSQL/browser/image results are recorded in the wave2 build report.
Plans remain permanently review-only. Apply, claim, lease, recovery and rollback reject their purpose before mutation. Historical exposure must be permitted by the current effective profile and ancestors; current policy constraints are fenced. Organization target grants and receiving-organization release visibility are independent from personal ownership. The memory fixture provides point-in-time review intent and is not execution authority. The Postgres production wrapper retains authority through review persistence. The later guided composed artifact source implements ARCHITECTURE_DECISION.md; per-skill success still does not prove composed acceptance.

Wave2 local proof: memory API route/instance and CLI/MCP transport journeys pass in the21-test narrow selection. Desktop/mobile selected-revision and stale-review browser journeys pass in the25-test affected Chromium selection. Canonical PostgreSQL additions cover held consent/account/exact-release authority, actual observation/policy writers, post-change refusal, atomic approval rollback, concurrent same-actor replay, restart and permanent review-purpose denial. Strict test-source typecheck is a syntax/contract check only; PostgreSQL execution remains with the controller. Current upgrade revisions fence review. The later composed contract adds execution-time upgrade/window checks; actual SQL and host acceptance remain pending.
