# MySkills Design System

Version: 0.1.0-alpha.0
Last updated: 2026-06-19

MySkills should feel like a truthful operational console, not a marketing shell. Preserve the core surfaces: Skills Registry, Review Dashboard, Submit Skill, compact admin overview, persistent rail, and real API state only.

## Current Adoption Mode

Mode: `react-custom-css` with a staged shadcn/Tailwind migration now covering the main operational workflows.

The web app is React 19 and Vite. It now has Tailwind CSS v4, shadcn/ui `components.json`, and an app-local `@/*` alias configured for `apps/web/src/*`. Treat shadcn/ReUI adoption as a staged migration, not a bulk rewrite.

The current shadcn/ReUI slice is local and workflow-first:

- shadcn `Button`, `Card`, `Badge`, `Input`, and `Textarea` live under `apps/web/src/components/ui`.
- `cn()` lives in `apps/web/src/lib/utils.ts`.
- The Skills Registry uses shadcn `Card`, `Badge`, `Button`, and `Input` for the approved-results pane, selected-skill detail, export controls, account-action forms, and compact registry actions.
- Registry maintainer lifecycle and sharing controls use ReUI `Frame` when they render for users with sharing-management permissions.
- The Review Dashboard uses shadcn core components for its queue/detail cards, status badges, review note field, and action buttons while keeping the same list/detail format as the Skills Registry.
- The Teams page uses shadcn core components for its combined teams/invitations panel, compact header metrics, shared-skills column, inputs, and action buttons.
- The Submit Package page uses shadcn core components for upload/status/submission panels and workflow actions while preserving server-owned validation and scan state.
- The Admin Console uses ReUI `Frame` for structured admin panels where reusable console framing is useful without changing API-owned account, token, provider, or audit state.
- The Settings page uses ReUI `Frame` for account security panels and shadcn `Button`, `Input`, and `Badge` primitives for account actions, MFA setup, API-key creation, and posture labels while preserving API-owned identity state.
- CSS tokens in `apps/web/src/styles.css` bridge the existing MySkills palette into Tailwind/shadcn semantic variables.
- ReUI registry config is present in `apps/web/components.json`; `@reui/frame` is installed under `apps/web/src/components/reui/frame.tsx`.
- Native `select` and checkbox controls remain local for now. Install shadcn `Select`, `Checkbox`, or related ReUI controls only when the next workflow needs their interaction behavior, not for cosmetic parity alone.

## Component Source Order

1. Existing MySkills components and tokens.
2. shadcn/ui core components for new or migrated foundational controls.
3. ReUI components only when a workflow needs richer console patterns than shadcn core provides.
4. Existing local primitives such as `StatusToken` and established row/table layouts where they still carry product-specific semantics.

Use shadcn core for foundational controls: Button, Input, Label, Select, Checkbox, Switch, Tabs, Dialog, Sheet, Popover, Tooltip, Table, Card, Badge, Alert, Progress, Skeleton, Breadcrumb, and Pagination.

Use ReUI for richer product-console components: Data Grid, Filters, Frame, Timeline, Tree, Stepper, File Upload, Date Selector, and advanced Badge or Alert patterns.

Do not run `shadcn add --all`, bulk install registry components, or introduce fake dashboard data to make components look populated.

## Migration Rules

- Start with one workflow or component cluster.
- Keep user-visible state API-backed or explicitly empty/loading/error.
- Prefer lucide-react icons because the app already uses them and shadcn supports lucide.
- Keep controls compact and scan-friendly.
- Keep primary workflow buttons small and restrained; use shadcn `Button` variants plus local density overrides instead of oversized colored actions.
- Maintain keyboard focus states, disabled states, loading states, empty states, and mobile fit.
- Review generated shadcn/ReUI component code as project-owned code before committing.

Before installing additional shadcn/ReUI components, verify current docs again. The last checked guidance was:

- shadcn/ui Vite setup: use the current `shadcn@latest` CLI, Tailwind CSS v4 shape, `components.json`, and explicit aliases.
- ReUI setup: requires React 19 and Tailwind CSS v4, adds a `@reui` registry namespace to `components.json`, and extends semantic tokens such as `--info`, `--success`, `--warning`, `--destructive-foreground`, `--invert`, and matching foreground tokens.

## Migration Status

The Skills Registry, Review Dashboard, Teams page, Submit Package page, Admin Console, Settings page, login form, MFA form, password reset form, and account-action forms now use the shadcn/ReUI foundation where it is useful. ReUI `Frame` is the default candidate for reusable console framing.

Evaluate shadcn `Select`/`Checkbox`, ReUI Filters, or ReUI Data Grid only if a workflow needs richer interaction behavior such as accessible composite selects, bulk filtering, sorting, virtualization, or dense row actions beyond the current row/list contracts.
