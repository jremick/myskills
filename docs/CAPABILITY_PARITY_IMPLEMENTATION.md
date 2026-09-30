# Capability parity implementation

The UI is the baseline for user outcomes. Deliver and maintain capability coverage in this order: **API → CLI → MCP**. The API remains the state and permission authority. Work through CLI gaps before MCP gaps; shared API prerequisites can be completed first.

## Approved scope and completion rule

Maintain the capability inventory and generated matrix, add a source drift check, implement the identified CLI gaps, then implement the MCP gaps. Preserve existing user, resource, scope, consent and MFA checks. A capability is complete only to its recorded evidence level; a source mapping does not prove semantic parity or host acceptance. The initial implementation stopped before publication. On 2026-09-30, the user approved completion and release integration; publication and deployed acceptance remain separate recorded gates. No new authentication provider is introduced.

Implementation phases:

1. Make `capability-parity.json` the canonical inventory and generate `CAPABILITY_PARITY.md`. Add deterministic classification and render checks to the repository gate.
2. Complete CLI workflows with explicit parameters, readable/JSON results and the same API permission checks. Record callable commands and positive/negative workflow evidence per capability.
3. Complete MCP workflows using those API contracts. Preserve delegated consent, assurance, actor attribution and local execution boundaries. Record API-token and OAuth behavior independently.
4. Reconcile every changed capability and source location, run required checks, and leave unverified host/deployment behavior explicit.

IMP-07 records partial parameter/execution-path coverage: registry run/event reporting is controlled by the supported local runner. IMP-09 now supports explicit selected-evidence and multiple proposals through a confirmed completed registry run; local-job reporting remains summary-only by design. Static route coverage must not hide these limitations.

SYS-02 (effective user/resource action discovery) remains a separate product gap: the UI and API have no current contract to adapt. It does not block CLI coverage of existing UI/API outcomes.

## MCP phase acceptance design

These decisions were implemented after the CLI slices closed; their evidence appears below. They do not claim deployment or real-host acceptance. The implementation uses a fixed named-action catalog; no arbitrary HTTP proxy or ambient session bridge is part of the contract.

### Authorization contract

Use explicitly named application actions with declared routes, methods, allowed inputs, response handling, scopes and assurance requirements. The API's existing domain services remain authoritative. On every call, intersect the live user's permissions and resource policy with the credential's granted scopes and the action's required assurance. Tool discovery and earlier authorization cannot cache a permission decision.

New application scopes must be usable by both scoped API tokens and OAuth grants where their assurance permits the action. Existing credentials gain no new scopes or authority. Supplying a scoped credential does not become anonymous fallback when scope validation fails. A scope is never evidence of MFA.

For OAuth privileged actions, persist the actual approving session's MFA verification timestamp in the authorization code and resulting grant. The privileged assurance window is **15 minutes from that verification**, matching the access-token lifetime. Code exchange, consent approval time and refresh must not reset this timestamp or extend assurance. Missing or stale assurance must return an actionable requirement to reconnect through the existing browser MFA and consent flow. No synthetic `mfaVerified: true`, token-derived session or cookie bypass is permitted.

Safe metadata/settings operations, authorized API-token revocation and connection revocation may be delegated under their named action policies. Keep credential issuance, password changes/recovery and MFA enrollment/removal/secrets in trusted user controls with explicit browser handoff and inspectable completion. Keep `targets:execute`, local filesystem writes and executor receipts with the enrolled local executor. MCP can schedule and inspect an authorized target operation; it cannot impersonate its executor or report local success without a receipt.

### Required acceptance scenarios

Write failure scenarios and acceptance tests before implementing each policy or adapter slice. Exercise real MCP dispatch through API authorization/services where practical, using an owner and another user, a shared resource, two revisions and a permission change during the workflow.

| Scenario | Required result |
| --- | --- |
| Named-action boundary | Unknown actions, arbitrary URLs/methods, encoded path escape and undeclared body/query fields cannot reach a broader API operation. |
| Scope escalation | A read grant cannot write; additional scopes require explicit browser consent. Requested scopes at token exchange or refresh cannot exceed the recorded grant. API tokens obey the same named scopes. |
| Old credentials | Credentials issued before the new scopes/policy cannot use added actions merely because the server was upgraded. |
| MFA provenance and expiry | Codes/grants retain the actual session verification time. Missing, stale, forged or future assurance cannot enable a privileged action. Boundary checks use the verification time plus 15 minutes; refresh never extends it. Reconnect through browser MFA/consent is required after expiry. |
| Cookie/session bypass | An OAuth credential in a cookie, mixed bearer/cookie inputs or token-to-session conversion cannot bypass action scope, CSRF/session or assurance checks. |
| Live authorization | Role downgrade, membership removal, sharing change, disabled/deleted account or revoked connection takes effect on the next call, even after tool discovery or a successful earlier call. |
| Resource isolation | A different user, team or organization cannot inspect hidden resources or mutate another actor's state. Denials preserve the API's non-disclosure behavior. |
| Revision and replay | Stale expected revisions fail safely. Retries retain the caller's idempotency key and exact artifact identity, creating one logical mutation with inspectable outcomes. |
| Revocation | An authorized token/connection revoke takes effect immediately; cross-user revocation and reused/revoked refresh grants fail. Revoking the current connection does not fabricate a successful follow-up call. |
| Trusted controls | Credential minting, passwords, MFA secrets and recovery codes do not enter model context. A browser handoff is incomplete until its trusted flow and resulting state are verified. |
| Executor boundary | A user-scoped MCP grant cannot claim work as `targets:execute`, change local files or invent an execution receipt. Scheduling, cancellation, target consent and generation/lease/fencing remain separate checks. |
| Evidence and host acceptance | Preserve sanitized repeatable evidence for the tested revision. Static catalog completeness, local MCP/API behavior, PostgreSQL persistence, real ChatGPT/Claude behavior and deployment remain separate proof levels. |

## Drift-check failure scenarios, before implementation

These are tooling contracts, not application-parity tests. Existing application tests do not detect an omitted inventory mapping or stale generated documentation. The primary test boundary is the real checker/render command against a disposable repository fixture.

| Failure scenario | Observable failure required |
| --- | --- |
| A route is added without a capability mapping | Check fails and names the unclassified method/path. |
| A classified route is removed | Check fails and names the stale method/path. |
| A dynamically registered route family changes | Every statically resolved member is checked; unsupported dynamic registration fails rather than disappearing. |
| A tool, tool action, native handler or CLI command is added/removed | Check fails until its classification is reconciled. |
| A mapping references a removed capability | Check fails with the missing capability ID. |
| Capability IDs or statuses are invalid/duplicated | Check fails with a validation error. |
| A partial, missing or handoff status has no explanation | Check fails; an exception cannot hide a gap. |
| The JSON changes but Markdown is not regenerated | Check fails for a stale render. |
| Unrelated source lines move | Refresh updates source anchors without promoting a status. |

## Verification ledger

Append commands and their actual results here as each phase completes. Keep static inventory, local workflow, external host and deployment evidence separate.

| Phase | Evidence | Result |
| --- | --- | --- |
| Initial inventory | Prior source audit of 123 capability groups and 198 API operations | Source classification only; no cross-surface runtime parity claim. |
| Drift tooling | `node --test scripts/test/capability-parity.test.mjs` | 9/9 passed. Fixtures prove unclassified/removed/dynamic route handling, tool/action/native-handler and switch/branch CLI drift, invalid references/status/reasons, stale render and refresh without status promotion. Source-registry tool expansion and helper-built handoff enum classification also have failing-control evidence. The added branch-dispatch and referenced-schema cases first failed against the prior extractor, then passed after repair. |
| CLI collaboration | `apps/cli/test/registry-collaboration-parity.e2e.test.ts` | 4/4 passed through CLI → HTTP → API authorization/services with memory stores: organization/team boundaries, private inventory/submission access and argument/MFA/session failures. |
| CLI architecture and targets | `apps/cli/test/architecture-target-parity.e2e.test.ts` | 3/3 passed through CLI → HTTP → API authorization/services with memory stores: revisions, grants, migration replay, consent, ownership, generation, policies, operation idempotency and invalid input. The journey exposed and verified a repair to batch-operation parsing. |
| CLI read coverage | `apps/cli/test/read-parity.e2e.test.ts` | 3/3 passed. Search uses the real API and memory repository to prove pagination, visibility and cursor binding. A controlled HTTP server proves exact-release metadata/terminal output, review pagination, library kind/state/unread filters and invalid-argument rejection. The latter is a transport contract test, not API authorization/persistence proof. The third test rejects repeated credential/host flags before any request. Test-first controls failed before inbox, terminal-output and global-option repairs. |
| CLI improvement reads | `apps/cli/test/improvement-read-parity.e2e.test.ts` | 2/2 real CLI → HTTP → API/auth/service journeys passed with memory stores; both failed for their intended missing-command/login-restriction reasons before implementation. Saved-plan inspection preserves expired/non-Claude records without local execution; public compatibility permits anonymous reads while preserving private visibility and credential scopes. Combined rerun with collaboration tests: 6/6 passed. |
| CLI improvement sharing | `apps/cli/test/improvement-share-parity.e2e.test.ts` | Five new HTTP sharing tests passed for explicit disclosure, 0–4 proposals, completion/digest/readback, owner/scope/policy, replay and local-job provenance. Combined improvement read/share/runner regression: 21/21 passed. |
| CLI upstream secret errors | `apps/cli/test/parity-secret-errors.e2e.test.ts` | 1/1 passed with a controlled fetch response: human/JSON errors do not echo prompted credentials and JSON preserves safe code/status. This is error-output contract proof. |
| CLI account/admin | `apps/cli/test/account-admin-parity.e2e.test.ts` | 6/6 passed through the normal dispatcher and real API/services. Covers registration/recovery, password/email/MFA, reserved private setup/recovery-code output and post-activation output loss, admin/owner safeguards, connections and instance metadata. Parent reviewed the private-file reservation repair; scoped lint and source/test type checks passed. |
| CLI after API delegation changes | Collaboration, architecture/target and improvement regression tests | 28/28 passed after preserving the new API scope-denial contract; two denial assertions changed to the explicit scope code. |
| API delegated-action prerequisite | `apps/api/test/delegated-actions.e2e.test.ts`, `apps/api/test/oauth-assurance.e2e.test.ts`, complete API suite | 458/458 passed (391 top-level), including 4 delegated-action and 2 OAuth-assurance journeys. Source builds passed. Invitation scope was repaired with two-direction failing controls: settings scope denied, admin-users scope allowed, for API token and OAuth. No PostgreSQL, host or deployed proof from this slice. |
| MCP action policy | Acceptance design above and the API prerequisite evidence | Named-action API policy and OAuth assurance have local tests; MCP tool dispatch/host acceptance remain separate gates. |
| MCP workflows | `apps/mcp` complete suite, including `application-parity.e2e.test.ts` and `application-schema.e2e.test.ts` | 97/97 passed before final description/annotation polish; build and targeted 2/2 checks passed after that polish. Final repository gate will rerun the complete suite. The real OAuth SDK/API journey proves scoped team write/read, owner denial, conditional scopes, assurance expiry through refresh and revoked credentials. Separate controlled HTTP fixtures prove payload contracts, size ceilings, sanitized errors and reviewed-export digest handling. These checks do not exhaustively prove all 168 actions. |
| MCP handoffs | `apps/mcp/test/application-handoffs.test.ts` | 8/8 passed for 27 guidance actions, including five local workflows and SDK strict-input/readback behavior. No browser operation, local command or suggested readback is performed; completion remains unconfirmed. |
| Web consent | Mocked browser and component checks | 8/8 browser journeys, 4 connection component tests and 2 API-token component tests passed. Parent inspected screenshots. Typecheck/build/lint passed; this is rendered UI with mocked API evidence, not full-stack persistence proof. |
| Original parity PostgreSQL | Recovered existing Windows job by container/readback and saved source manifest | 245/245 passed on the 682-file snapshot with archive SHA-256 `67518f131a7827f3228d9b894b48a06bfe1cf1a46c26b08861785de709d101b4`; zero failures/skips, all source hashes matched. The job completed on 2026-09-28 UTC and was read back on 2026-09-30. This is the original parity snapshot, not the reconciled main candidate. The corresponding full-stack job was never started. |
| Main reconciliation | Current main `8468ae9f`; focused API/CLI/MCP journeys plus lint and web typecheck | 40/40 focused tests passed after test-first repairs. Added safe GitHub metadata/disconnect/test adapters and trusted linking/configuration handoffs, managed-skill detail, and OAuth bootstrap profile minimization. Failure controls rejected the missing operations and detected unconsented OAuth profile exposure before repair. Full repository and PostgreSQL/full-stack checks of the reconciled candidate follow below. |
| CI integration | Portable four-lane runner and phased full-stack evidence | Targeted subprocess checks passed 4/4. Exact MCP image cleanup and separate sanitized connector-report retention each failed against the pre-fix runner. The existing credential-redaction fixture now exercises a failed stack start; a separate case proves config rejection creates no stack. Independent security review found no remaining actionable high/medium findings at `b3c1ca0c`; this is source review, not deployed or host acceptance. |
| Library Collections and Groups | LIB-26–29 inventory; API delegated-action, CLI/MCP transport, PostgreSQL and browser journeys, independent security and data-integrity review | Merged in PR #124 after `myskills-verify-c2bd1e71d7-1` passed all seven jobs on the tested merge tree shared by landed source `6905bf690cd0b9108fc74a392f51909c9726aeb2`. Each Node runtime passed 1,372 repository tests and 253 PostgreSQL tests. The real PostgreSQL selection journey proves multiple sources, overlapping Groups, independent pins, current visibility, revision/quota concurrency and read races. The persistent full-stack browser journey passed without retries on both runtimes. Mocked journeys separately cover responsive views and permission/stale-edit recovery. Controlled CLI/MCP fixtures establish adapter behavior, not complete adapter-to-PostgreSQL parity or provider-host acceptance. |
| Release/deployment | [Beta.18 delivery record](BETA18_RELEASE_DELIVERY.md) | Phase-1 Railway staging is verified at `14970ba10a67f7372b713a3c29a17b8b72d91a24`, before Collections. The final Collections matrix and CodeQL passed; its staging upgrade and deployment remain pending. No beta.18 tag, canonical release verification, publication or production promotion is claimed. Production remains beta.16. |
| ChatGPT and Claude acceptance | Requires real host sessions against an authorized deployment | Not run. |

The [final Collections verification record](BETA18_RELEASE_DELIVERY.md#collections-and-groups-verification)
names the candidate, tested merge, landed commit, shared tree, controller runs
and retained export checksums. Earlier rows retain their original proof limits.

MCP transport ceilings: application API request bodies are limited to 14 MiB, with 64 KiB for the HTTP JSON-RPC envelope; metadata responses are bounded to 512 KiB and exports to 10 MiB. The matrix records operation coverage separately from these limits and from exhaustive parameter or host acceptance.
