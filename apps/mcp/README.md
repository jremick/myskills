# MCP App

MCP transport surface for AI Skills Share.

Initial scope:

- authenticated read-only skill discovery
- safe metadata for authorized skills
- install/export guidance
- role-gated read-only maintainer/admin tools

MCP clients should authenticate with scoped API tokens, not interactive sessions. Tool handlers must enforce both the local user role and token scope through the API auth boundary.

Package contents should not be returned by MCP tools in the first production surface. Delivery should remain an API/CLI path with explicit authorization and audit.
