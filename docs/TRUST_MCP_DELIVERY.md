# Artifact delivery and MCP trust

Status: implementation in progress. Real host acceptance and release signing remain pending.

## Scope and acceptance

This change completes the existing private S3/MinIO to API to CLI/MCP delivery
path. The API remains the visibility, lifecycle and credential authority. It
does not expose object URLs, issue delivery credentials, activate skills or
change release versions. No migration or new dependency is required.

Before sending an artifact, the API must verify the exact release identity,
expected digest when supplied, stored byte size, payload digest, supported
platform and current account/scope/visibility/lifecycle. It must check again
after storage completes. Invalid supplied credentials must fail rather than
fall back to anonymous public access. Responses must prevent shared caching.
Storage must stop an oversized or stalled body. Revert the source commit to
roll back; there is no persistent schema change.

## Failure inventory written before implementation

- A credential is revoked, loses scope or belongs to a suspended account while
  object storage is reading, yet the API sends package bytes.
- Team membership, sharing policy or release lifecycle changes during a read,
  yet an earlier authorization snapshot remains usable.
- A stale digest reads a different immutable release or causes object retrieval.
- A stored object has altered bytes, wrong size/content type, malformed UTF-8,
  excessive bytes or a stalled body, yet delivery succeeds or grows unbounded.
- A cached public response exposes a later private release, or an invalid
  supplied token silently becomes an anonymous reader.
- Native resource traversal, another registry origin, digest drift or oversized
  request bypasses the exact manifest; privileged tools bypass scope/role gates.
- Audit details include bearer values, package content or caller-supplied paths;
  an intent event is reported as proof of successful host activation.
- Provenance accepts dirty or mismatched source, changed artifact bytes, mutable
  image tags, missing production integrity or private registry credentials.
- Two equivalent provenance runs vary by timestamp, directory or component order;
  an unsigned lockfile inventory is presented as image SBOM or signed attestation.

Checks use real API/MCP sockets and domain services with deterministic memory
stores, streamed S3 SDK response fixtures, and disposable git repositories for
provenance. These layers do not establish PostgreSQL, MinIO deployment,
ChatGPT/Claude host acceptance, publication or signing. Existing PostgreSQL and
canonical Linux checks remain separate integration gates.

## Integrated candidate and decision point

Production delivery now uses the PostgreSQL store's read-only `REPEATABLE READ`
transaction after the object read. Its first SELECT defines the authorization
snapshot. Credential/account state, sharing settings, membership, organization
policy and exact release metadata all use that snapshot. Revocations committed
before this point deny delivery. A concurrent revocation can serialize after the
decision. The API performs no later credential usage UPDATE or slow object read
after this gate. The existing 15-second delivery window still bounds the result.
This is request authorization; it cannot retract bytes already delivered.

Legacy DB payload fallback is limited to missing-object errors. Storage access
denials, timeouts, malformed bytes and provider failures fail closed. CLI requests
reject redirects and stream bounded bytes before hashing and strict UTF-8
decoding. Artifact metadata must declare a valid digest and a safe integer byte
size within the existing 10 MiB object limit. Device responses have a 16 KiB limit.

`postgres-artifact-delivery.pgtest.ts` is registered through `test:postgres`.
It prepares real database tests for stale credential SELECT/usage UPDATE races,
post-storage revocation and policy changes, and exact identity drift. The existing
full-stack cookie export journey now checks digest/size, no-store, stale-digest
denial and invalid supplied credentials against the canonical PostgreSQL/MinIO
stack. These additions have not been executed locally; the parent controller owns
canonical execution. Loopback SDK/API/MCP and provenance fixture checks passed on
Node 22.23.2 with npm 11.12.1. They do not establish deployed or human-host proof.

The existing `test:tooling` check discovers the provenance fixture.
`release:verify` also prepares unsigned provenance from its exact source archive
and npm lockfile after artifact verification. The dependency inventory describes
production lockfile entries, not image contents or installed dependencies.
Signing authority, image inspection and publication remain separate gates.
