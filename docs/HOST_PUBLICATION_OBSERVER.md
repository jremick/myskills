# One live HOST publication observation

This internal fixture hook runs only after an actual binding failure. It keeps
that failure and the normal owned-resource cleanup. It cannot accept a port,
retry launch, change Docker settings or recover HOST acceptance.

The supervisor prepares the observer on the Ubuntu controller runner under the
same Unix UID as the fixture. Use the already verified W11/WSL read-only route.
Do not start a stopped distribution. Before arming, verify `docker-desktop` is
running and that its current Engine namespace has the read-only tools in
`host-publication-backend.sh`. The script rediscovers dockerd and verifies its
namespace before and after collection. Missing tools, namespace mismatch,
command failure or oversized output mean unavailable, never absent publication.

Prepare a private, regular mode0600 JSON adapter file containing `script`, `backendStopProtocol: "timeout7-kill025-process-group"`
and `terminationProbeSha256` from the supervisor's actual forced-termination
probe. The former b56f adapter has no kill escalation and is rejected.
Its shell code must forward stdin and the two positional IPv4 arguments to
`sh -s -- "$1" "$2"` in that already-running backend. For the verified WSL
interop route, resolve the existing `wsl.exe` on Ubuntu first; the concrete
adapter body is `exec <resolved-wsl.exe> -d docker-desktop -u root --exec sh -s --
"$1" "$2"`. The supervisor must quote that resolved executable and guard the
current running-distribution readback before dispatch. No SSH key, credential,
provider variable or machine-specific path belongs in this repository.

The adapter must wrap namespace entry and its complete backend group with
`timeout -k 0.25 -s TERM 7`, passing the freshly observed namespace as the third
backend argument. The local observer forcibly kills its separate adapter
process group, even after leader exit; raw output is capped at 2KiB. Every
backend read also uses TERM followed by KILL after 0.25 seconds. The supervisor
must verify the actual timeout implementation kills the backend group and its
descendants. Killing the local WSL relay alone is insufficient. No updated
adapter deployment or backend termination probe is claimed by source tests.

Compute SHA256 of the exact `script` string, then run on that Ubuntu runner:

```sh
node scripts/observe-host-publication-once.mjs /private/adapter.json <script-sha256> <exact-controller-candidate> <exact-controller-run-id>
```

Obtain the actual controller-assigned run ID after submission, then arm before
its HOST stage. Wait for `{ "ready": true, "windowMs": 15000, "requests": 1,
"backendTimeoutMs": 8000 }` before HOST begins. Do not assume a run ID can be predicted before submission.
The fresh mode0700 `/tmp/myskills-host-publication-once` directory and ready
nonce and exact candidate/run binding are the handshake. Obtain the assigned
controller run ID before its HOST stage; wrong run or candidate rejects the
observer. Existing directory means stop and inspect the previous
owned observer; do not overwrite it. The observer exits after one request or
its two-hour arming expiry. The fixture exports only fixed categories.

On failure the fixture atomically writes one private request, waits at most
12 seconds for the exact nonce/token/IDs, then spends at most 3 seconds checking
the exact owned container again. The post-inspection and optional one
`docker port <owned-id> 9000/tcp` comparison use forced SIGKILL timeouts;
comparison exports only empty/matches-observed/other/unavailable. The backend reads the actual bridge address,
the single NAT rule targeting that owned IPv4/TCP9000 and its corresponding
listener. It bounds each command to 2 seconds and raw intermediate output to
32KiB. Only present/absent/unavailable leave the backend. The existing API
binding/continuity receipt remains alongside this observation. The timing bound
is 15 seconds for observation, followed by up to two 10-second consistency
reads, each with forced SIGKILL, before normal cleanup.

A matching NAT rule supplies a private observed port, not proof of working
publication. The observer uses that port and only the fixture public CA for one
native Ubuntu HTTPS GET to `/minio/health/ready`, with no proxy, redirect, retry
or response-body export and a two-second deadline. That finishes before the
handoff response. Backend TLS is explicitly unavailable: no CA-capable client
has been proved there, and no installation is part of this work.

API bindings empty plus an exact rule and Ubuntu CA-verified health success
narrows the API/reporting boundary. A matching rule without verified health is
only forwarding evidence. No matching rule on the verified bridge narrows the
publication boundary; listener absence alone is inconclusive. Keep the original
failure in every case. No independently observed port substitutes for HOST
acceptance. The controller still owns full verification and cleanup; this
observer never removes Docker objects.
