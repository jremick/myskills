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

## Lifecycle residual ledger

| Outcome | Source boundary | Remaining implementation | Separate acceptance |
| --- | --- | --- | --- |
| Discover | Registry/exact-release resolver and architecture explorer | Task-aware retrieval and explicit provider projections where required by the roadmap | Provider host discovery/recognition |
| Govern | API tenancy, membership, grants, profile denials and release lifecycle | Provider-derived role mapping and conditional exposure | Current target policy and operator consent |
| Version | Immutable architecture revisions and exact release identities | Durable versioned layout/artifact projections when required | Deployed revision/readback |
| Share | API grants and existing CLI/MCP management | Public architecture publishing contract | Real recipient/provider access |
| Compose | Router → router → leaf graph and derive-shell migration | Router/exposure/removal/context-artifact delivery contract; composed orchestration through existing queue/leases/receipts | Real target pilot after supported source exists |
| Inspect | Saved graph/history and persisted review-only plans | Run outcome UI for later supported execution | PostgreSQL, host and deployed proof kept separate |
| Safely update | Exact plan fences; per-skill install/update/rollback companion | Whole-architecture preflight, atomic artifact delivery or per-step rollback binding | Explicit pilot and second-provider write activation |

Two supported tool instances can be two explicitly selected isolated Codex
workspaces. Their binding, observation, approval, placement and revocation must
remain independent. The two-instance review journey exercises that source
boundary. It does not establish whole-architecture installation or actual host
recognition. A broader provider contract is a separate strategic decision.

Fixture recovery tests prove synthetic leases, receipts and recovery only. Layout
and diagrams remain derived projections; neither is a new visual source of truth.

## Smallest composed-delivery contract delta

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
Plans remain permanently review-only. Apply, claim, lease, recovery and rollback reject their purpose before mutation. Historical exposure must be permitted by the current effective profile and ancestors; current policy constraints are fenced. Organization target grants and receiving-organization release visibility are independent from personal ownership. The memory fixture provides point-in-time review intent and is not execution authority. The Postgres production wrapper retains authority through review persistence. Full composed graph artifact delivery from ARCHITECTURE_DECISION.md remains for the next worker; per-skill success is not composed acceptance.

Wave2 local proof: memory API route/instance and CLI/MCP transport journeys pass in the21-test narrow selection. Desktop/mobile selected-revision and stale-review browser journeys pass in the25-test affected Chromium selection. Canonical PostgreSQL additions cover held consent/account/exact-release authority, actual observation/policy writers, post-change refusal, atomic approval rollback, concurrent same-actor replay, restart and permanent review-purpose denial. Strict test-source typecheck is a syntax/contract check only; PostgreSQL execution remains with the controller. Current upgrade revisions fence review, while complete composed delivery and execution-time upgrade eligibility remain the next bounded workstream.
