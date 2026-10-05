# Beta.20 release preparation

Prepared: 5 October 2026. Target release: `v0.1.0-beta.20`.
Status: source and release-metadata preparation. No beta.20 tag, published
artifact or deployment is claimed by this record.

Beta.20 is a bounded CLI follow-up to published beta.19. It resumes a pending
browser/device login for the same API URL, configuration profile and requested
scopes through a separate OS keyring entry. A private process lock serializes
polling and logout. The original server expiry, conservative local deadline,
requested scopes and polling interval remain fixed across restart; consent,
MFA assurance, token lifetime and one-time redemption remain API-owned.

The CLI reports expiry, interruption, denial, unconfirmed credential saving,
configuration-save failure and incomplete cleanup distinctly. Pending device
secrets never enter config, token files or terminal output. Explicit
`--no-resume` starts an in-memory request when secure storage is unavailable;
it cannot replace a readable existing pending request. A response lost after
server redemption cannot recover the token. See the [CLI guide](../apps/cli/README.md).

The cumulative source artifacts also retain the device authorization form
spacing already merged in [PR #136](https://github.com/jremick/myskills/pull/136)
after the beta.19 tag. That existing UI fix does not imply a new hosted rollout.

Hosted API/web/MCP deployment is unchanged. API service behavior, migrations,
dependency versions and runtime support are unchanged. Workspace versions move
together solely to retain the repository's release-coherence contract. This
release does not complete broader roadmap or provider-host acceptance work.

## Evidence and remaining gates

- Node 24.19.0 local selection: 59/59 device/auth/profile/token/API checks and
  13/13 existing response/redirect transport regressions passed, with no skips.
- Three real CLI processes share one loopback HTTP API request: abrupt SIGKILL
  before consent, graceful SIGTERM after approval, then resumption yields one
  usable scoped token. Replay is invalid. A separate actual lost-response case
  produces one server token and cannot recover it locally.
- Focused tests prove original expiry, bounded near-deadline polling, saved
  slow-down timing, API/profile/scope isolation, corrupt/keyring failures,
  credential/configuration/cleanup failures and OS-user lock identity.
- Keyring storage is an in-memory/IPC fixture. Native OS-keyring, real account,
  PostgreSQL, human-host and deployed acceptance are unverified by this slice.
- Targeted lint, CLI typecheck, structure and capability-parity checks passed
  before version preparation. Exact-candidate release and required branch
  checks, immutable artifact identity, tagging and publication remain pending.

No fallback stores pending secrets in plaintext. Hosts without working keyring
access remain explicitly nonresumable with `--no-resume`. Expiry after process
loss is cleaned on the next login/logout for that API/profile, without a
background agent. Existing API-token logout stays local-only.
