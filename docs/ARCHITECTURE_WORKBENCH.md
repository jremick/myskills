# Architecture overview and Workbench

Last updated: 2026-10-01

This page records how the web app presents skill architectures and the URL contract it keeps. Architecture data, access and revisions stay owned by the MySkills API; see [SKILL_ARCHITECTURE_CONTROL_PLANE.md](SKILL_ARCHITECTURE_CONTROL_PLANE.md).

## URLs

| URL | Shows |
|---|---|
| `/architectures` | The overview. It keeps the current architecture, or shows the first one when nothing is selected. On a phone it shows the list. |
| `/architectures/:id` | The overview of one architecture. |
| `/architectures/:id/workbench` | The full-page Workbench for one architecture. |

- `profile`, `environment` and `organization` query parameters carry the preview context. The app validates them against the architecture. It never applies a profile, environment or organization that the architecture does not declare or grant. When a requested value is not available, the app shows the default context, says so on the page and replaces the URL.
- `node` carries the selected node on the overview and the Workbench, and `view=map` the Structure map on the overview. They are presentation requests only: a node is kept once the preview loaded for the current context contains it (or, in the Workbench, the saved revision the reader may edit) and is otherwise dropped from the URL. Neither parameter makes a request or widens access.
- An ID that is not in the signed-in user's architecture list shows "This architecture isn't available to your account." No other architecture is opened in its place, and the app does not request it.
- Normal clicks navigate in the same tab. Cmd/Ctrl-click and other modified clicks keep browser behaviour, such as opening a new tab. Reload, direct links, Back and Forward restore the surface, the architecture and the context.

## Overview

The overview shows the saved revision only, never an unsaved draft. It has a compact title, the description, a meta line (pattern, revision, owner, access) and the preview context. Its tabs are:

- **Structure**: a dense nested list of routers and skills with branch collapse, skill counts (routers never count as skills), search that keeps each match's ancestors, and a node inspector (kind, path, exact skill version and digest, package access, exposure in the selected context). Trees above 40 nodes open with only the top-level routers shown. A complementary **Map** (React Flow and Dagre, left to right) shows routers first; focusing a router reveals its skills and **All branches** returns to the overview. The list stays the complete accessible structure. Technical details (dry-run sync plan, observed-state fixture and exports) follow the explorer.
- **Skills**: the effective skills with search, an exposure filter, branch, exact version and package access.
- **History**: saved revisions.
- **Sharing** (managers): organization grants.

Owners and team members also see nodes that are not exposed in the selected context, taken only from the saved revision the API returned to them, with an **All nodes / Exposed only** filter. Organization-only readers see exactly the API's exposed projection. Pattern migration is under **Change pattern** in the header (managers). Hidden tabs and the closed migration panel stay mounted, so access drafts and migration retry keys are kept. When the explorer is narrow, the inspector is a bottom sheet that closes with Escape or **Close details** and returns focus to the row.

The main action depends on state: **Open workbench**, **Inspect in workbench** (read-only), **Build first revision** (no revision yet) or **Resume draft** (unsaved work). Readers who can save revisions also get **Edit in Workbench** in the inspector, which opens the Workbench on the same node and context; **Architecture overview** and Back return to the same node.

## Workbench

The Workbench uses the full content width and keeps the app navigation. One toolbar holds the draft status, the optional revision message, Discard, Preview draft and Save revision. Under it, **Draft changes** names each difference from the revision the draft started from (renames, added, removed and moved nodes, release and exposure changes, profile and environment changes, and a bounded summary of anything else) before you save. Tabs:

- **Design**: the outline, the selected-node inspector and the canvas. Up to 900px wide, the outline and details come first and a switch shows the canvas.
- **Profiles & environments**: profile, environment and binding editing.
- **Preview**: the API draft preview for the chosen context. The saved revision is unchanged until you save.
- **Advanced**: the immutable-revision JSON form.

The canvas is a visual projection only; positions are not saved. Small topologies open fitted. Larger ones open on the selected node at a readable scale, and the fit control still shows every node.

Read-only members can inspect a saved revision without save, message or advanced controls. Saving from a historical revision still sends the latest revision as the concurrency token.

## Unsaved drafts

- The draft spec and the revision message are kept when you move between the overview and the Workbench of the same architecture, including with Back and Forward. The overview then shows **Resume draft**.
- A change to the revision message alone counts as unsaved work.
- The app asks once before a draft would be lost: another architecture, a page outside the section, Refresh, replacing the draft from history, or leaving the page. If you cancel, the URL and the draft stay as they were.
- Drafts are not stored in the browser. Reloading or closing the page loses them after the browser's leave-page warning.
- A failed save or a revision conflict keeps the draft and the message. A save that finishes after you move to another draft does not change that newer draft.

## Connected-target review plans

The connected-target inspector at `/targets` provides **Architecture review plans**.
Choose an exact saved revision to create a server-owned dry run against the latest
authorized observation. The plan retains its target generation, logical profile
and environment, revision, steps, digests and approval receipt in the API journal.
It does not use an unsaved Workbench draft.

**Approve this review** records an explicit review with current MFA and the full
review digest. The API rechecks current access, observation, consent, capabilities
and policy. A stale request keeps the existing plan visible for inspection.
Review approval does not schedule or execute target changes. See the
[delivery ledger](ARCH_LIFE_DELIVERY.md) for verification and remaining execution
contracts.
