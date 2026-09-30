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
