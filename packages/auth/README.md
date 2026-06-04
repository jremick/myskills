# Auth Package

Shared authentication and authorization contracts.

Implemented:

- role and permission definitions
- user status definitions
- bcrypt password hashing helpers
- opaque session token generation and hashing
- opaque API token generation and hashing

Planned contents:

- provider identity mapping contracts
- MFA policy contracts

Implementation-specific route and store code lives in `apps/api` until the boundary is stable.
