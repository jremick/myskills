# Core Package

Shared domain contracts and utilities.

Planned contents:

- domain types
- errors
- lifecycle constants
- authorization decision contracts
- audit event contracts
- search and pagination contracts


Registry discovery defaults to the highest visible, published, reviewed,
security-passed release that has an approved lifecycle and a valid stable SemVer
version. `selectDefaultSkillRelease` applies the version and lifecycle rule.
Backports created later do not replace a higher version; prereleases, deprecated
releases, and noncanonical historical versions cannot become the default. Build
metadata does not affect precedence. The registry breaks equal-precedence ties
by creation time and then release ID, both descending.

A skill with historical releases but no eligible default remains discoverable
with `latestVersion: null` and no default platforms. Exact release addressing and
release history remain available under their existing access policy. Historical
identities are never rewritten.
