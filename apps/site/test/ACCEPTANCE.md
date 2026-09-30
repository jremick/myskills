# Public site browser acceptance

Written before implementation on 2026-10-01. This checks a local static build,
not a deployed MySkills instance, published package, or provider connection.

1. A newcomer starts at Home, identifies public beta limits, reads a labelled
   excerpt from the real Release Notes Helper package, then reaches the local
   setup sequence. The sequence distinguishes evaluation from production and
   links to the canonical guide. A clipboard action returns visible feedback.
   Credible failures: fabricated proof, unsupported production promises, stale
   copied setup detail, or copying the wrong command block.
2. A keyboard user navigates the six surfaces, including a narrow-screen menu,
   skips repeated navigation, closes the menu with Escape, and regains focus.
   Credible failures: hidden links staying focusable, lost focus, no skip target,
   or mobile navigation trapping the reader.
3. A reader follows setup, deployment, CLI/API/MCP, authoring, and security
   references from the documentation hub. Every local URL and fragment resolves;
   canonical GitHub references identify real repository paths. No account or
   API request occurs. Credible failures: broken static deep links, SPA-only
   deployment assumptions, wrong guide targets, or leaking app state into the site.
4. A reader compares the three public example packages, opens the exact source
   and manifest references, and sees their real version/platform metadata.
   Credible failures: invented packages, unsupported platform labels, or content
   drift between the public gallery and repository packages.
5. A reader reaches Downloads and status, distinguishes the verified beta.17
   prerelease from beta.18 source, and reaches GitHub release/security reporting
   destinations without being shown a fabricated uptime or package availability.
6. All six first viewports and full pages fit desktop and mobile widths, have
   readable text contrast, stable focus indicators, and usable controls.
   Repeatable screenshots and a dated JSON receipt identify local-only scope.

These are the first site tests. Existing app tests cover app behavior and cannot
exercise independent static hosting, public-site navigation, or this content.
They require no production-only seam, live service, credentials, or dependency.
