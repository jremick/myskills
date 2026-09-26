# Libraries

Version: 0.1.0-beta.8
Status: unreleased candidate. Runtime-name normalization and native installation are verified in focused checks; see the [build evidence](plans/2026-09-26-library-build-evidence.md) for release gates.

Libraries collect source references and reviewed registry releases. They retain source citations, track selected content, and record the exact version a person or team recommends. Saving, checking, importing, reviewing, adopting and installing are separate actions.

## Start in the browser

1. Open **Libraries** and create a personal library. Team owners can also create a team library.
2. Save a public GitHub repository, directory or `SKILL.md` URL. **Use ref from URL** preserves a pasted branch or tag. Use **Source selection** to override it with a branch, tag, commit, stable release or tag prefix. Saving does not run repository code or install anything.
3. Choose **Discover skills**. Select complete skill directories, inspect blockers, and preview the selected files. The preview records a resolved commit, included notices, mapping and artifact digest. Unsupported plugin content can remain a saved reference.
4. Inspect the included instructions and supporting files. Review the installed name and both file digests: the runtime `SKILL.md` uses the unique registry slug, while `myskills-source-skill.txt` retains the exact upstream original. Submit the preview for review. Unclassified changes are conservatively recorded as breaking and requiring user action.
5. Use the normal registry review queue, or approve your own strictly private import if the administrator enabled that option. Private approval requires MFA, a clean scan and an explicit artifact attestation. Choose **Inspect submitted artifact** first; the browser verifies its exact digest before enabling the attestation.
6. Adopt the approved release. For a registry entry, add an optional curator note explaining the recommendation. Adoption changes the library recommendation. It does not write to local installations.
7. Set source checks to off, manual, daily or weekly. Opt into **Notify me about changes** to receive in-app events for libraries you can currently access.
8. Install with the command shown on the adopted entry. Review required release actions before accepting an update.

The displayed last successful check is separate from the next check and health. A failed or rate-limited check does not mean a source is unchanged. Scheduled checks require the source worker on the API instance. A source change creates a candidate; it never silently changes adoption.

A repository rename or transfer pauses that source entry for identity review. Inspect its previously trusted and newly observed names, confirm **I reviewed the repository identity change**, then save tracking. Turning checks off keeps the review pending. Each saved entry needs its own acknowledgement, and a later identity change invalidates an earlier confirmation.

**Review candidates** reads saved candidates without contacting GitHub. Use it during a provider outage or after a preview expires. Submitted artifacts remain inspectable through the owner's submission access. Large file previews identify their display limit; export the package to inspect the complete content.

The API starts the source worker by default. Set `LIBRARY_SOURCE_WORKER=disabled` to stop scheduled checks on an instance. Manual checks remain available, and the browser reports when the worker is unavailable. No GitHub credentials are used in this release.

An adopted entry shows an install command after loading its release requirements. When the release requires user action, review those actions before using `--accept-user-action`. Under **Connect an existing target**, users can inspect their bindings, explicitly replace a conflicting binding, or detach it. These actions require an MFA-verified session and do not change installed files.

## Imported names and source evidence

MySkills assigns each imported lineage a unique registry slug. The installed folder and the runtime `SKILL.md` name use that slug so native skill validation remains intact. Supporting files and invocation text are not renamed.

The preview shows the original name, installed name, preserved file path, and the original and transformed SHA-256 digests. The exact upstream `SKILL.md` remains in `myskills-source-skill.txt`, which is not a second discoverable skill. The import manifest and immutable provenance record the transformation. Both files are included in the reviewed artifact and package scan.

The importer supports plain or quoted values, block text and one level of nested frontmatter. Some valid YAML structures are unsupported and produce an explicit blocked preview. A missing description or byte order mark also blocks native installation; MySkills does not invent a description or remove source bytes.

Ambiguous frontmatter, a collision with the reserved original-file path, or a package that exceeds the file or byte limit produces a blocked preview. The importer does not silently discard or truncate evidence to fit a limit. Source tracking compares upstream content; the reviewed artifact digest identifies the actual installed package.

## Private review and sharing

The administrator switch **Allow private import self-review** starts disabled after migration. Administrators can change it in Libraries using an MFA-verified session. Every change is audited.

When enabled, a user can attest only their own strictly private imported release. This records `private-self-reviewed`, not an instance reviewer's approval. Disabling the switch blocks new private attestations while retaining existing private copies.

To share such a release, choose **Request instance review for sharing**. A reviewer opens **Sharing reviews**, inspects the exact artifact and approves it for shared use. Browser inspection checks the response hash and artifact header against the requested digest. Sharing remains subject to ordinary registry grants and policy. A library does not grant access to a private release.

Team libraries curate already-authorized registry releases. Imported content remains owned by its contributor. Removing membership or revoking release access takes effect on subsequent reads, inbox retrieval and delivery checks. Organization-owned imports and private GitHub connections are later phases.

## CLI workflow

Run `myskills libraries help` for all commands. Read/write commands use the same API authorization as the browser. API tokens need `libraries:read` or `libraries:write`; importing and self-review also require `skills:submit`. Administrator settings and target binding changes require an MFA-verified session.

Companions that apply library-bound installs need `skills:read`, `targets:execute` and `libraries:read`. A missing scope produces an actionable error; the CLI never broadens token permissions.

Mutation bodies use reviewed JSON files. Keep `clientMutationId` unchanged when retrying a creation or import whose outcome was uncertain. Change it only for a new intended mutation. Files are limited to 64 KiB.

Create a library:

```json
{
  "name": "Planning tools",
  "owner": { "type": "user" },
  "clientMutationId": "planning-library-1"
}
```

```bash
myskills libraries create --input library.json --json
myskills libraries list --json
myskills libraries show LIBRARY_ID --json
```

Save a public source:

```json
{
  "url": "https://github.com/everyinc/compound-engineering-plugin",
  "ref": { "kind": "tag-prefix", "value": "compound-engineering-v" },
  "clientMutationId": "compound-source-1"
}
```

```bash
myskills libraries add-source LIBRARY_ID --input source.json --json
myskills libraries discover SOURCE_ENTRY_ID --json
```

Choose paths from discovery and use its snapshot ID:

```json
{ "snapshotId": "SNAPSHOT_ID", "paths": ["skills/ce-plan"] }
```

```bash
myskills libraries preview SOURCE_ENTRY_ID --input preview.json --json
myskills libraries candidate CANDIDATE_ID --json
```

A preview can be blocked by unsupported files, unresolved dependencies, missing metadata or other findings. Do not infer whole-plugin compatibility from a discovered skill root. Review the returned paths rather than assuming the example repository layout is unchanged.

Submit the exact preview:

```json
{
  "expectedPackageDigest": "DIGEST_FROM_PREVIEW",
  "release": { "classification": "unclassified" },
  "clientMutationId": "compound-import-1"
}
```

```bash
myskills libraries import CANDIDATE_ID --input import.json --json
```

For private self-review, supply `{ "artifactSha256": "DIGEST_FROM_PREVIEW" }` to `libraries self-review CANDIDATE_ID --input attestation.json`. This succeeds only when the current administrator policy and private ownership requirements allow it. Otherwise, follow the ordinary review process.

Adopt using the returned skill entry ID and exact release hash:

```json
{
  "version": "0.0.1",
  "artifactSha256": "REVIEWED_ARTIFACT_DIGEST",
  "expectedCurrentAdoptionId": null
}
```

```bash
myskills libraries adopt SKILL_ENTRY_ID --input adoption.json --json
myskills libraries resolve SKILL_ENTRY_ID --json
myskills install IMPORTED_SLUG --library-entry SKILL_ENTRY_ID
myskills updates IMPORTED_SLUG --json
myskills update IMPORTED_SLUG
```

If an update requires user action, read the release notes and complete the required action before rerunning with `--accept-user-action`. Neither an upstream version label nor a library adoption removes that requirement.

The local install registry retains the library entry binding. Every install/update resolves the current authorized adoption and rechecks it before file promotion. A missing entry or lost access leaves the existing files in place and refuses fallback to the latest registry version. Local edits stop replacement. An explicit rollback retains the binding.

Batch updates report unavailable entries per skill and continue with other skills. If a library adopts an older version, the CLI explains how to use an available rollback snapshot or a new installation root; it never silently downgrades an installed skill.

For a sharing review, copy the artifact digest from `libraries review-requests`, then inspect its exact bundle:

```bash
myskills libraries review-bundle SUBMISSION_ID --artifact-sha256 REVIEW_REQUEST_DIGEST --output reviewed-bundle.json
```

The command verifies the response body against its hash header and the supplied review digest before displaying or saving content. The output file must be new. Without `--artifact-sha256`, verification covers the response header only. Supply the same reviewed digest when requesting elevation.

To stop following a local library binding without changing files:

```bash
myskills libraries unbind-local IMPORTED_SLUG --dir INSTALL_ROOT
```

Future updates then use ordinary registry selection. Connected target bindings are separate API records; use `libraries detach BINDING_ID` to remove one explicitly. The Updates screen shows library pins, unavailable curation and conflicting recommendations.

## Commands and payloads

| Intent | Commands |
|---|---|
| Collections | `list`, `create`, `show`, `edit`, `remove` |
| Entries | `entries`, `add-source`, `add-skill`, `entry`, `remove-entry` |
| Import | `discover`, `preview`, `candidates`, `candidate`, `import`, `self-review`, `request-review`, `ignore` |
| Adoption | `adopt`, `adoptions`, `resolve` |
| Tracking and inbox | `tracking`, `check`, `subscribe`, `unsubscribe`, `inbox`, `mark-read` |
| Targets | `bindings`, `bind`, `detach`, `unbind-local` |
| Administration and review | `settings`, `set-settings`, `review-requests`, `review-bundle`, `elevate` |

List commands support `--limit 1..100` and `--cursor`. Removing a library requires its current `--revision`. JSON bodies and error codes are defined in the [API contract](plans/2026-09-26-library-api-contract.md).

## Operation and limits

Source checks use fixed public GitHub HTTPS endpoints, no provider credentials and no repository code execution. Scheduled checks use persistent leases and respect retries; `LIBRARY_SOURCE_WORKER=disabled` turns the source worker off. Instances without it retain manual checks and report that scheduling is unavailable.

Deleting a library stops its tracking/subscriptions and makes its target bindings unavailable. Imported registry releases and installed files remain. Retained provenance describes the original source snapshot and the imported artifact separately.

This release does not include private GitHub credentials, company-owned imported assets, email delivery, unattended local application or native plugin execution. The complete future scope and acceptance criteria are in the [feature specification](plans/2026-09-26-library-feature-spec.md).
