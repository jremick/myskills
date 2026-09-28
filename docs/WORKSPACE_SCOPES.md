# Workspace Scopes

`myskills scopes` records which MySkills target owns the skill inventory of a
local directory, separately for Codex and Claude. A provider can have one
global scope (its user-level skills directory) and any number of project
scopes. Projects can be excluded from the global scope so they can be enrolled
on their own.

## What scopes do not do

- Scopes are MySkills inventory ownership only. They do not change how Codex or
  Claude discover, load, or inherit skills. Every command reports
  `nativeInheritance: "unchanged"` and `runtimeRecognized: false`.
- Scope targets are read-only. They never install, update, roll back, or write
  skill files, and they cannot receive companion operations.
- Counts describe directory entries that MySkills examined. They are not a
  record of the skills a provider loaded at runtime.
- The CLI never discovers a provider home. You pass every directory explicitly.

## Targets

| Provider | Adapter kind | Contract | Capabilities |
|---|---|---|---|
| Codex | `codex-inventory` | 1 | `inventory.read`, `health.read` |
| Claude | `claude-inventory` | 1 | `inventory.read`, `health.read` |

`apply`, `rollback`, and `sync.write` are always false. Targets are personal
(user-owned) and carry `provider`, `scope`, and `inventoryOnly` metadata.
Observed skills are reported with `managed: false`, so update planning ignores
them. The managed Codex workspace adapter (`codex enroll --workspace`) is
unchanged and separate.

## Work and personal CLI configuration

Use `--config-profile work` on every work command, or set
`MYSKILLS_CONFIG_PROFILE=work` for that shell. The explicit flag wins. This
selects separate saved registry, account credentials, and scope state; it is
unrelated to the architecture `--profile-id` required by enrollment.

```bash
myskills config set api-url https://work-registry.example/api --config-profile work
myskills login --config-profile work
myskills scopes enroll --config-profile work --provider codex --scope global \
  --root <absolute-work-skills-dir> --architecture-id <id> --environment-id <id> --profile-id <id>
myskills scopes list --config-profile work
myskills doctor --config-profile work --json
```

Omitting the selector keeps the existing default account and all its bindings.
A named `personal` profile starts with empty state. There is no automatic copy,
migration, or unbind. Profiles can use different accounts on the same registry.
Confirm the selected account with `whoami --config-profile work` before enrollment.
Explicit `--api-url`/`MYSKILLS_API_URL` and `--token`/`MYSKILLS_TOKEN` still
override saved values; clear inherited overrides to use profile-local values.
See the [CLI configuration rules](../apps/cli/README.md#separate-work-and-personal-configuration)
for name validation, storage, and legacy file-override behavior.

## Commands

```bash
myskills scopes inventory --provider codex|claude --root <absolute-skills-dir> [--json]
myskills scopes enroll --provider codex|claude --scope global --root <absolute-skills-dir> \
  --architecture-id <id> --environment-id <id> --profile-id <id> [--name <name>] [--api-url <url>]
myskills scopes enroll --provider codex|claude --scope project --project <absolute-dir> \
  --architecture-id <id> --environment-id <id> --profile-id <id> [--name <name>] [--api-url <url>]
myskills scopes observe --provider codex|claude --scope global|project [--project <absolute-dir>] [--upload]
myskills scopes list [--provider codex|claude]
myskills scopes resolve --provider codex|claude --path <absolute-dir>
myskills scopes exclude|include --provider codex|claude --project <absolute-dir>
myskills scopes unbind --provider codex|claude --scope global|project [--project <absolute-dir>]
myskills scopes migrate plan --provider codex|claude --project <absolute-dir>
myskills scopes migrate apply --provider codex|claude --project <absolute-dir> --plan-digest <sha256>
```

`inventory` is local only: it reads the directory, prints what an upload would
contain, and makes no network call. Use it to review a directory before
enrollment. Add `--json` to any command for machine-readable output.

For a global scope, `--root` is the provider's skills directory itself, for
example `$HOME/.codex/skills` or `$HOME/.claude/skills`. Pass the directory
your provider actually uses; MySkills does not check that. For a project scope,
MySkills reads `<project>/.agents/skills` for Codex and `<project>/.claude/skills`
for Claude.

## What is read and what is uploaded

For a selected skills directory, the CLI lists its immediate entries (at most
10,000) and opens only `<entry>/SKILL.md` for each candidate, without following
links. Nothing else is opened. It never reads skill bodies beyond `SKILL.md`,
other files, credentials, or provider configuration.

| Entry | Classification | Uploaded |
|---|---|---|
| Directory with a valid `SKILL.md` (YAML `name` equal to the directory name, nonempty `description`) | skill | slug and a SHA-256 of `SKILL.md` |
| Valid skill whose slug contains a word an older registry treats as private (for example `config`, `token`, `path`) | skill locally; withheld on older-server uploads | slug and digest on upgraded registries; count only on older registries |
| Symbolic link | linked, not followed | count only |
| Invalid directory name, missing or invalid `SKILL.md` | invalid | count only |
| Name starting with `.` | skipped (`hidden`) | count only |
| `.myskills-app` | skipped (`managed-install-state`); never read or attached | count only |
| Regular file | skipped (`not-a-directory`); never opened | count only |

Names of linked, invalid, withheld, and skipped entries stay in local output.
The registry receives slugs, counts, digests, and the provider and scope labels.
It never receives absolute paths, exclusion paths, skill bodies, descriptions,
file names, or credentials. Registries with migration `0034` advertise
`architectureObservationSlugValidation: true` in `/v1/capabilities`. They
validate the observation structure and skill slugs separately, so valid names
such as `codex-config-sync` can be uploaded without weakening other privacy
checks. When this capability is absent or false, the CLI withholds names that
match the older registry's privacy check and reports an incomplete upload.
Local inventory retains these valid skills.

`inventoryComplete` is true only when every entry was examined and every entry
that could hold a skill was listed. It is false when anything was withheld,
linked, invalid, truncated, or a hidden directory (for example `.system` or
`.git`), or when a project's skills location is a link or unreadable.
`incompleteReasons` names each cause. Regular files and `.myskills-app` do not
affect completeness. At most 500 skills are listed per observation; more are
reported as `inventory-truncated`.

## Ownership resolution

`scopes resolve` answers which scope owns a directory for one provider.

1. The path is resolved to its real path, so a symlinked alias resolves to the
   same owner as its target.
2. Matching uses whole path segments: an exclusion of `/work/foo` matches
   `/work/foo/src` but never `/work/foobar`.
3. Among project scopes and exclusions that contain the path, the deepest one
   wins. At the same directory, a project scope wins over an exclusion.
4. A winning exclusion makes the path `excluded`. It never falls back to an
   enclosing project or to the global scope.
5. With no match, the provider's global scope owns the path if one is enrolled;
   otherwise the path is `unowned`.

Codex and Claude rules are independent. Excluding a project for Codex does not
affect Claude.

Rules that are refused:

- the filesystem root or your home directory as a global root, project, or
  exclusion;
- a directory whose final component is a symlink (pass the real directory);
- a project or exclusion that contains, equals, or sits inside the provider's
  global skills directory, and a global directory that overlaps an existing
  project or exclusion;
- an inventory project scope for a Codex project that already has a managed
  workspace binding (adopt it with `scopes migrate` instead).

Nested project scopes and nested exclusions are allowed. Enrolling the same
project twice resumes the existing binding.

## Enrollment lifecycle

Enrollment needs a password session with MFA, as for other target
registration. API tokens are refused by the registry for these routes.

1. The CLI checks local rules, then reads the registry instance
   (`/v1/capabilities`) and the signed-in account (`/v1/me`).
2. It writes a private intent with a random opaque identity digest, the
   registry origin and instance, and the account ID, before it registers.
3. It registers the target, stores it, grants consent, and marks the scope
   active.

If a step is interrupted, run the same command again. A retry first looks for a
target with the stored identity digest, so a registration that committed on
the server is resumed rather than duplicated. The retry fails closed, without
registering, when:

- the signed-in account differs from the one that started the enrollment
  (`SCOPE_ACCOUNT_MISMATCH`);
- the registry's target list cannot be read in full (`SCOPE_TARGET_LIST_INVALID`);
- the registry origin or instance changed (`SCOPE_REGISTRY_MISMATCH`);
- the architecture, environment, or profile IDs differ (`SCOPE_BINDING_CONFLICT`);
- the target changed identity, owner, or provider (`SCOPE_TARGET_IDENTITY_CHANGED`,
  `SCOPE_TARGET_PROVIDER_MISMATCH`).

A repeated enrollment of an active scope makes no registry writes.

`scopes observe --upload` holds the local state lock from reading the binding
until the upload is stored, so a concurrent `unbind` or re-enrollment waits for
it. It rechecks the directory, the registry, the account's access, consent, and
target identity before it uploads. Commands that change scope state wait up to
10 seconds for the lock and then report that it is busy. Read-only commands
(`inventory`, `list`, `resolve`, and `observe` without `--upload`) do not wait.

### Revocation and recovery

A revoked, deleted, or inaccessible target fails with `SCOPE_TARGET_REVOKED` or
`SCOPE_TARGET_UNAVAILABLE`. A replaced or relinked directory fails with
`SCOPE_ROOT_CHANGED`. In each case run `scopes unbind` for that scope and then
`scopes enroll` again; this creates a new target. `unbind` changes only local
state. It prints the target ID so you can revoke the old target in the browser
if it is still active. Exclusions are kept.

## Local state

State lives in `workspace-scopes.json` in the `scopes` directory under the
MySkills config directory: `$MYSKILLS_CONFIG_DIR/scopes`, otherwise
`$XDG_CONFIG_HOME/myskills-app/scopes`, otherwise
`$HOME/.config/myskills-app/scopes`. With a named CLI configuration profile,
the same base-directory precedence applies and state lives in
`<base>/profiles/<name>/scopes/`. `MYSKILLS_CONFIG_DIR` sets the base, not the
final named-profile directory.

- The directory must be private to you (mode `700`). Files are written with
  mode `600` through a temporary file and an atomic rename, under the same root
  lock the installer uses.
- The file is versioned (`schemaVersion: 1`). A malformed file fails with
  `SCOPE_STATE_INVALID` and a file from a newer CLI fails with
  `SCOPE_STATE_UNSUPPORTED`. Neither is rewritten.
- The file is limited to 512 KiB and 256 project scopes and 256 exclusions per
  provider. A change that would exceed a limit is refused with
  `SCOPE_STATE_LIMIT` and nothing is written.
- Absolute paths stay in this file only.

## Migration

### Existing local formats

| Format | Location | Handling |
|---|---|---|
| Managed Codex workspace binding, schema 1 | `<project>/.agents/skills/.myskills-app/codex-workspace.json` | Can be adopted as a managed project scope by reference. The file is never changed. |
| Install registry, version 1 | `<root>/.myskills-app/installed.json` | Read only to count installations without registry provenance. Never attached. |
| Earlier scope state | none | `workspace-scopes.json` schema 1 is the first scope format. |
| Claude bindings | none | No earlier MySkills format exists. |

### Plan and apply

`scopes migrate plan` is read-only. For one project it reports the current
owner, the actions, any blockers, and a plan digest. The digest covers the
exact bytes of the scope state, the workspace binding, and the install
registry. Actions are:

- `add-exclusion`: stop the project from falling back to the global scope;
- `adopt-managed-binding` (Codex only): record an existing valid managed
  workspace binding as the project's owner, by target ID and identity.

Blockers stop `apply`: an invalid binding, an unreadable install registry,
installations without registry provenance
(`legacy-installations-without-provenance`), an existing inventory scope for
the same project, a changed adopted binding, or overlap with the global
directory.

`scopes migrate apply --plan-digest <digest>` takes the state lock, recomputes
the plan, and refuses with `SCOPE_MIGRATION_STALE` if anything changed since
the preview. It then copies the current state to
`scopes/backups/workspace-scopes.<timestamp>.<digest-prefix>.json` and writes
the new state atomically. If `apply` is interrupted, the state is either the old
or the new file; run `plan` again, and it shows no actions once the migration
is complete. To roll back, copy the backup over `workspace-scopes.json` while no
`scopes` command is running.

Migration never contacts the registry, never changes a target's identity or
history, never moves or deletes skill content, never attaches installations
without provenance, and never turns an inventory scope into a managed writer.

To move a project from the global scope to its own target, run `migrate plan`
and `migrate apply` for it (this adds the exclusion and adopts a managed Codex
binding if present), then `scopes enroll --scope project` if it has no binding.

### Server compatibility

The existing target schema accepts inventory targets, and observations use the
existing observation and health routes. Scope enrollment needs a registry that
exposes a stable instance ID in `/v1/capabilities`. Older CLIs ignore the scope
state file. Upgrading the CLI preserves the default configuration and bindings;
choosing a new named configuration starts separate state.

Migration `0034_observation_slug_privacy.sql` is required for full valid-slug
uploads. It replaces the observation privacy constraint transactionally and
enforces the new constraint on subsequent writes. The constraint is installed
with `NOT VALID` to preserve immutable historical observations without a table
scan; existing rows are not claimed to have passed the new validation. No IDs,
digests, observations, or append-only protections are rewritten. The API checks
migration readiness before advertising the capability.

Keep migration `0034` if rolling back application code. An older API omits the
capability and the new CLI resumes its compatibility withholding. Do not
reapply the earlier constraint: newly accepted valid names may violate it.
Database corrections use a forward migration. Local project adoption remains
an explicit preview-and-apply operation described above.
