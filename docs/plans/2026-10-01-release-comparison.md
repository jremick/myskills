# Exact published release comparison (HIST-01)

Approved scope: compare two exact releases from the current authorized release history in the Skills Versions panel. The API remains the authority for readable packages. This adds no endpoint, permission, dependency, binary support, or publication action.

The user chooses a base and target version before either package loads. Each response must match its listed SHA-256 and its root manifest name and exact version. Compare full held strings by complete path, with deterministic added, removed, modified and unchanged classifications. Render selected files as inert text with exact base and target labels. Large previews are bounded and identified; classification always uses the complete held content.

The interface uses the existing neutral registry surfaces, typography and borders. Two native version controls lead to one Compare releases action, followed by an ordered file selector and stacked or adjacent text panes. State changes have no animation. Native controls preserve keyboard behavior and narrow screens must not scroll horizontally.

## Failure inventory and browser acceptance

Written before production code. Controlled browser API responses prove browser and transport contracts only. They do not prove persisted releases, deployment or full-stack acceptance.

| Failure | Browser acceptance |
| --- | --- |
| Two releases share a filename but content changes | One modified row for the complete path; exact before and after strings are held and displayed. |
| Supporting files are added or deleted | Added and removed rows identify the correct side as absent. Nested paths with the same basename stay separate. |
| Unicode, CRLF, markup or a change beyond preview limits is normalized away | Exact string comparison keeps those changes; text is escaped and never executed; a large-file tail change is classified as modified. |
| A bundle has the wrong identity or digest | Neither package content nor a comparison appears; an explicit validation error replaces any previous comparison. |
| The second exact fetch fails or current visibility is revoked | Clear both held packages and show the access/error reason; never substitute a version. |
| A slow old selection completes after changing a version, skill or session | Ignore its result; only the current selection can become ready. |
| Management history includes unpublished, revoked or archived rows | Explain that the existing exact bundle reader cannot provide them. No review or owner export route is substituted. |
| Comparison changes version URLs or keyboard history behavior | Comparison controls do not navigate. Existing exact release selection, reload and browser history retain their contracts. |
| Long content or paths overflow mobile | Wrap controls and text; produce a repeatable mobile screenshot and assert document width. |

## Integration contract

`ReleaseComparison` receives the current client, skill slug, authorized release list, history state and a context key. The parent context key covers the selected exact version and session identity; a changed client also resets held content. The parent supplies an unavailable reason when the current readable skill check failed, including management-only archived records. Release-list state and digest changes invalidate held results. Only published approved/deprecated rows with a valid digest are eligible; the exact bundle endpoint rechecks current visibility on every comparison.

The existing `getReleaseBundle` returns parsed JSON without raw response bytes or a digest header. Digest validation follows the immutable artifact serializer (`JSON.stringify({ files })`) without reordering or modifying returned files before hashing. The library inspection helper also uses browser SHA-256; its raw-byte/header behavior cannot be reused through this frozen client contract. Parent integration must keep that limitation explicit.

True unpublished managed release comparison remains outside this bounded slice. It needs a separate authorized exact-artifact contract; private draft revision comparison remains distinct evidence.

## Verification record

Pending: failing baseline, focused browser journeys, component lint, web typecheck, parent integration and repository parity gates. The parent owns shared App/API/parity edits and all external actions.
