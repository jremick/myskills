# MySkills public site

This workspace builds an independent static product and documentation site.
It uses Node.js and local HTML/CSS/JavaScript, with no new dependencies or
application API calls. The six surfaces are Home, Setup, Docs, Examples,
Downloads and status, and Security.

## Build and preview

From the repository root with its supported Node/npm versions:

```sh
npm run build -w @myskills-app/site
npm run preview -w @myskills-app/site
```

Open `http://127.0.0.1:4188`. Use `-- --port 4190` to change the preview port.
The preview binds to loopback. It is a local preview server.

The build also works without npm or installed dependencies:

```sh
node apps/site/scripts/build.mjs
```

Set `MYSKILLS_SITE_APP_ORIGIN` at build time to the HTTP(S) origin of the app.
The default is `https://myskills.sh`. All app actions link to that origin’s
`/registry` or `/login`; the site owns no application or authentication routes.
Origins with credentials, paths, queries, or fragments fail before output is
written. Use the actual app origin when the product site and app are separated.

## Static deployment

Publish the contents of `apps/site/dist` to a static host. The host must serve
directory indexes, such as `/docs/` from `docs/index.html`, and preserve
`/assets/*`. Deploy at the host root. No SPA fallback, Node runtime, database,
account configuration, secrets, or app service is needed after building.

Generated output is ignored by Git. No deployment or hosting change is made
by the build or preview commands.

## Content and release evidence

The example gallery and hero excerpt come from the public repository packages
under `examples/skills`; the build rejects a non-public example. The document
hub validates its canonical repository paths during build.

The release snapshot in `src/content.mjs` records the verified GitHub prerelease
`v0.1.0-beta.17`, published `2026-09-29T00:21:04Z`. It is a dated snapshot;
read the GitHub release list before choosing a release. The workspace’s beta.18
version is labelled source/staging separately. Neither state proves app
deployment, an npm channel version, container availability, or provider-host
acceptance. Refresh the snapshot through an authorized release readback when
the site is prepared for publication.

The setup page is an orientation path. Canonical repository guides remain
the authority for exact behavior and release-specific instructions.

## Browser acceptance

The [acceptance scenarios](test/ACCEPTANCE.md) and Playwright suite were written
before implementation. They exercise newcomer setup, real examples, keyboard
navigation, six static deep links, canonical references, release boundaries,
mobile fit, and text contrast. They use the existing web workspace’s Playwright
installation; the site adds no dependency.

```sh
npm run test:e2e -w @myskills-app/site
```

If needed, use the existing repository convention
`MYSKILLS_E2E_BROWSER_EXECUTABLE` to select an installed Chromium executable.
The test starts its own local build and server. Dated desktop/mobile screenshots
and JSON scope receipts are saved under the ignored `test-results` directory,
with a browsable report under `playwright-report`. These establish local site
rendering only; they do not establish production runtime behavior.
