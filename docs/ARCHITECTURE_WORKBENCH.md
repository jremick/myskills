# Architecture overview and Workbench

Last updated: 2026-09-29

This page records how the web app presents skill architectures and the URL contract it keeps. Architecture data, access and revisions stay owned by the MySkills API; see [SKILL_ARCHITECTURE_CONTROL_PLANE.md](SKILL_ARCHITECTURE_CONTROL_PLANE.md).

## URLs

| URL | Shows |
|---|---|
| `/architectures` | The overview. It keeps the current architecture, or shows the first one when nothing is selected. On a phone it shows the list. |
| `/architectures/:id` | The overview of one architecture. |
| `/architectures/:id/workbench` | The full-page Workbench for one architecture. |

- `profile`, `environment` and `organization` query parameters carry the preview context. The app validates them against the architecture. It never applies a profile, environment or organization that the architecture does not declare or grant. When a requested value is not available, the app shows the default context, says so on the page and replaces the URL.
- An ID that is not in the signed-in user's architecture list shows "This architecture isn't available to your account." No other architecture is opened in its place, and the app does not request it.
- Normal clicks navigate in the same tab. Cmd/Ctrl-click and other modified clicks keep browser behaviour, such as opening a new tab. Reload, direct links, Back and Forward restore the surface, the architecture and the context.

## Overview

The overview shows the saved revision only, never an unsaved draft. It has a compact title, the description, a meta line (pattern, revision, owner, access) and the preview context. Its tabs are Overview (routing diagram, accessible outline and technical details with the dry-run sync plan, observed-state fixture and exports), Skills, History and Access (for managers). Hidden tabs stay mounted, so access drafts and migration retry keys are kept.

The main action depends on state: **Open workbench**, **Inspect in workbench** (read-only), **Build first revision** (no revision yet) or **Resume draft** (unsaved work).

## Workbench

The Workbench uses the full content width and keeps the app navigation. One toolbar holds the draft status, the optional revision message, Discard, Preview draft and Save revision. Tabs:

- **Design**: the outline, the selected-node inspector and the canvas. On a phone, a switch shows either the canvas or the outline with details.
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
