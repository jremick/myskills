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

Prepare a private, regular mode0600 JSON adapter file containing only `script`.
Its shell code must forward stdin and the two positional IPv4 arguments to
`sh -s -- "$1" "$2"` in that already-running backend. For the verified WSL
interop route, resolve the existing `wsl.exe` on Ubuntu first; the concrete
adapter body is `exec <resolved-wsl.exe> -d docker-desktop -u root --exec sh -s --
"$1" "$2"`. The supervisor must quote that resolved executable and guard the
current running-distribution readback before dispatch. No SSH key, credential,
provider variable or machine-specific path belongs in this repository.

Compute SHA256 of the exact `script` string, then run on that Ubuntu runner:

```sh
node scripts/observe-host-publication-once.mjs /private/adapter.json <script-sha256> <exact-controller-candidate> <exact-controller-run-id>
```

Wait for `{ "ready": true, "windowMs": 15000, "requests": 1,
"backendTimeoutMs": 8000 }` before the one maintained controller submission.
The fresh mode0700 `/tmp/myskills-host-publication-once` directory and ready
nonce and exact candidate/run binding are the handshake. Obtain the assigned
controller run ID before its HOST stage; wrong run or candidate rejects the
observer. Existing directory means stop and inspect the previous
owned observer; do not overwrite it. The observer exits after one request or
its two-hour arming expiry. The fixture exports only fixed categories.

On failure the fixture atomically writes one private request, waits at most
12 seconds for the exact nonce/token/IDs, then spends at most 3 seconds checking
the exact owned container again. The backend reads the actual bridge address,
the single NAT rule targeting that owned IPv4/TCP9000 and its corresponding
listener. It bounds each command to 2 seconds and raw intermediate output to
32KiB. Only present/absent/unavailable leave the backend. The existing API
binding/continuity receipt remains alongside this observation.

API bindings empty with exact forwarding present identifies an API/reporting
boundary; no forwarding with a verified observed bridge narrows the publication
boundary. Listener absence alone is inconclusive. This hook does not perform a
TLS health probe. A later supervisor CA-verified probe may be diagnostic only;
it cannot substitute for the required binding receipt. If observation is
unavailable, preserve that limit and do not infer a cause. The controller still
owns full verification and cleanup; this observer never removes Docker objects.
