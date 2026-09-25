# Archive authoring and native MCP delivery

Date: 2026-09-25
Delivery: [PR #83](https://github.com/jremick/myskills/pull/83)
Baseline: `04d80fc70ae56cce43d73faaac4fb74a99558e8c`

This record covers source delivery. CLI and image publication, production
deployment, and native model activation are separate steps.

## Delivered behavior

- `myskills package` validates and scans one directory snapshot, then writes a
  deterministic ZIP to a new, private output file outside the source. It preserves
  exact UTF-8 text, refuses symlinks and replacement destinations, and reports a
  SHA-256 digest and separate submit command.
- Native MCP `skills/list`, `skills/get`, and `resources/read` use current API
  authorization and immutable release bundles. Manifests bind every resource to
  its exact bytes. Limits cover pagination, response bytes, file count, paths,
  frontmatter and operation time. The six metadata tools retain their contract.
- Native method audit context describes declared authorization intent. The
  existing artifact audit records bundle authorization. Neither means that a host
  activated or executed a skill.

See the [CLI guide](../apps/cli/README.md) and [MCP guide](../apps/mcp/README.md)
for command syntax, protocol negotiation and limits.

## Verification boundaries

All builds, tests and containers ran on Windows-hosted Linux or GitHub Actions.
No build or container ran on the local Mac. Windows-native filesystem behavior
and a fresh macOS runtime were not tested in this delivery; local package writes
remain supported on macOS and Linux.

The Windows repository gate at `051de61640ef2839a1d54abea68cce47b8527d5b`
passed all 1,116 tests, lint, builds, web type checks, secret/privacy checks,
production dependency audit and installed CLI tarball smoke. Later review fixes
receive focused package/MCP regression checks and the PR's complete required CI.
Use the PR check records for the exact final commit and supported Node 22/24,
PostgreSQL, browser, image and CodeQL results.

The disposable workflow fixture used the real HTTP API and CLI with synthetic
credentials and memory repositories. It created a private skill, made two
identical ZIPs, changed the original source, submitted the saved ZIP, rejected a
duplicate version, inspected the exact held content, approved it and published
it. The search projection was explicitly populated after publication because
the memory stores are separate. This is not PostgreSQL persistence evidence;
the CI integration jobs cover that boundary.

The three-file fixture included BOM, CRLF and non-ASCII text. Its ZIP SHA-256 was
`73062a94789e98e5fa65d5d9e617d1f7f32320a9d400b55ea8006f93a6f618b5`.
Its published JSON artifact SHA-256 was
`16a1040e0d912f4ec863312637f3e7bc8a809767b0212c7b0b26e9bde3df2a65`.

## Official scenario checks

The pinned official conformance source was
[`7169291ec0b68eb370fddcd9947313ab0d5e4156`](https://github.com/modelcontextprotocol/conformance/tree/7169291ec0b68eb370fddcd9947313ab0d5e4156).
Its source archive SHA-256 was
`51c1e27027f36be5b5f067746eb3a0f240fc3fbb7adcbd64bc4a79d86db65cd8`.

The stock CLI fails against a server that enforces both peers' Skills declaration:
its Skills scenarios connect with default capabilities that omit the extension.
The CLI also excludes extension scenarios when an explicit dated spec filter is
supplied. These failed and skipped results are retained as limitations, not
counted as passing evidence.

The successful run invokes the unchanged enumeration, manifest and directory
scenario classes and wire-schema checks with the official `ConnectOptions`
configured to declare `io.modelcontextprotocol/skills`. It uses protocol
`2026-07-28`. A loopback proxy adds only the synthetic fixture bearer header;
request bodies and responses are not changed. No check or expected failure is
suppressed.

Result: 37 successful checks, two warnings, six skips, no failures. The warnings
concern name/description metadata in optional `resources/list`, which returns an
empty list; native discovery uses `skills/list`. The skips are for the undeclared
optional directory-read feature. This is **official scenario checks with a
configured client**, not a stock CLI pass or full MCP conformance certification.

## Real host import

The released `fast-agent-mcp==0.10.33` host imported the complete fixture through
its actual `scan_mcp_skill_registry` and `McpSkillSource.install_skill` paths. The
harness only adapts HTTP results to the host's own models. The installer verified
all three files and wrote provenance. It rejected both equal-length altered
bytes and a changed manifest, leaving no installed or staged partial package.
No model or provider request ran.

The pinned wheel SHA-256 was
`79e3ab1047d4317bd873245fb09fb5c34983002f0fbb49f33c2782d1ec6816bb`.
The actual Python dependency freeze was retained with the execution evidence;
transitive packages were resolved under the wheel's constraints.

This host uses a draft-compatible local-copy importer. It downloads the complete
manifest. The result does **not** prove current-spec, model-selected on-demand
activation, host execution permission handling or nested activation. MCP-1 stays
open for that acceptance.

## Review and remaining work

Opus reviewed source with read-only tools. Its findings led to per-entry handling
of unsupported releases, transient upstream error classification, readable URI
length limits, empty template discovery, and structural validation without
repeating content-risk scans. A targeted wire check also found and closed legacy
batch dispatch. Regression checks cover these paths.

Bundle verification still downloads the complete bounded artifact on each read.
This preserves fresh authorization and full digest verification; it is not a
claim of optimized large-package streaming. Binary artifacts are outside the
current text-package contract.

Next roadmap slices are held-byte folder/ZIP import previews, commit-pinned
public GitHub imports, a versioned self-host distribution, browser drafts, and
guided setup and operations. See [Roadmap](ROADMAP.md).
