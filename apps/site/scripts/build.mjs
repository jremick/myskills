import { readFile, writeFile, mkdir, copyFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { repository, source, release, surfaces, guides } from "../src/content.mjs";

const site = new URL("../", import.meta.url);
const repo = new URL("../../../", import.meta.url);
const output = new URL("dist/", site);
const esc = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));

function appOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("MYSKILLS_SITE_APP_ORIGIN must be an absolute HTTP(S) origin."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("MYSKILLS_SITE_APP_ORIGIN must be an HTTP(S) origin without credentials, a path, query, or fragment.");
  }
  return url.origin;
}

const app = appOrigin(process.env.MYSKILLS_SITE_APP_ORIGIN?.trim() || "https://myskills.sh");
const appUrl = (path) => `${app}${path}`;
const packageJson = await readJson(new URL("package.json", repo));
const exampleNames = ["release-notes-helper", "app-environment-reviewer", "model-guidance-reviewer"];
const examples = await Promise.all(exampleNames.map(async (slug) => {
  const manifest = await readJson(new URL(`examples/skills/${slug}/skill.json`, repo));
  if (manifest.visibility !== "public") throw new Error(`Example ${slug} must be public.`);
  const instructions = await readFile(new URL(`examples/skills/${slug}/SKILL.md`, repo), "utf8");
  return { slug, manifest, instructions: instructions.replace(/^---\n[\s\S]*?\n---\n\s*/, "").trim() };
}));
for (const guide of guides) await access(new URL(guide.path, repo));
const excerpt = examples[0].instructions.split("\n\n## Output")[0];
const mark = `<svg class="brand-mark" viewBox="12 12 76 76" aria-hidden="true" focusable="false"><rect x="14" y="14" width="28" height="28" rx="8" fill="#14B8A6"/><rect x="50" y="14" width="28" height="28" rx="8" fill="#F5B53D"/><rect x="14" y="50" width="28" height="28" rx="8" fill="#2B3A4E"/><rect x="58" y="58" width="28" height="28" rx="8" fill="#FF6B5B"/></svg>`;
const brand = `<a class="brand" href="/" aria-label="MySkills home">${mark}<span>MySkills</span></a>`;
const link = (href, label, className = "") => `<a${className ? ` class="${className}"` : ""} href="${esc(href)}">${esc(label)}</a>`;
const button = (href, label, secondary = false) => link(href, label, `button${secondary ? " secondary" : ""}`);
const intro = (eyebrow, heading, text, actions = "") => `<section class="page-intro"><div class="wrap"><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(heading)}</h1><p class="lead">${esc(text)}</p>${actions ? `<div class="actions">${actions}</div>` : ""}</div></section>`;
const onThisPage = (sections) => `<aside class="on-this-page" aria-label="On this page"><p>On this page</p><ul>${sections.map(([id, text]) => `<li>${link(`#${id}`, text)}</li>`).join("")}</ul></aside>`;
const article = (id, title, body) => `<section class="article-section" id="${id}" aria-labelledby="${id}-title"><h2 id="${id}-title">${esc(title)}</h2>${body}</section>`;
const command = (id, label, text, copy = false) => `<div class="command-block"><div class="command-top"><span>${esc(label)}</span>${copy ? `<button class="copy-button" type="button" data-copy="${id}" data-label="Clone commands" aria-label="Copy clone commands" hidden>Copy</button>` : ""}</div><pre><code id="${id}">${esc(text)}</code></pre></div>`;

function home() {
  return `<section class="hero" aria-labelledby="hero-title"><div class="wrap hero-grid"><div>
    <p class="eyebrow">Public beta</p><h1 id="hero-title">MySkills</h1>
    <p class="hero-promise">Compose your AI’s skill set.<br>Govern its lifecycle.</p>
    <p class="hero-summary">Build versioned architectures from exact skill releases. Choose profiles and environments, review desired versus observed changes, and control updates.</p>
    <div class="actions">${button(appUrl("/registry"), "Explore skills")}${button("/setup/", "Run the local demo", true)}</div>
    <p class="beta-note">Open source · Apache-2.0 · Use for evaluation and non-critical workloads. ${link("/security/", "Read beta limits")}</p>
  </div><figure class="artifact"><div class="file-header"><span>release-notes-helper / SKILL.md</span><span>v0.1.0</span></div>
    <div class="file-body"><pre id="skill-excerpt">${esc(excerpt)}</pre></div>
    <figcaption>Excerpt from a public example package</figcaption>${link(source("examples/skills/release-notes-helper/SKILL.md"), "Read the full source ↗", "artifact-link")}
  </figure></div></section>
  <section class="section"><div class="wrap"><div class="section-heading"><h2>One skill set.<br>Clear boundaries.</h2><p>Compose routers and skill leaves into saved architecture revisions. Select the profiles and environments that define each target’s scope. A package built around SKILL.md is one part of that larger skill set.</p></div>
    <ol class="workflow"><li><span class="step-number">01 / Compose</span><h3>Define the complete skill set.</h3><p>Build a flat, domain-router, or multi-level architecture with exact package references and explicit profiles.</p>${link(source("docs/ARCHITECTURE_WORKBENCH.md"), "Read the architecture guide ↗")}</li>
    <li><span class="step-number">02 / Review</span><h3>Review desired and observed state.</h3><p>Inspect a saved revision against a target observation. Review approval records that decision; it does not execute a rollout.</p>${link(source("docs/ARCH_LIFE_DELIVERY.md"), "Read the lifecycle delivery state ↗")}</li>
    <li><span class="step-number">03 / Govern</span><h3>Control each lifecycle change.</h3><p>Keep target consent, current permissions, exact revisions, update policy, and recovery authority visible before changing a workspace.</p>${link(source("docs/SKILL_ARCHITECTURE_CONTROL_PLANE.md"), "Understand target governance ↗")}</li></ol>
  </div></section>
  <section class="section"><div class="wrap two-columns"><div><p class="eyebrow">For you and your team</p><h2>Keep architecture intent<br>and target state in view.</h2><p>Use personal or shared architectures to govern a complete skill set. Libraries hold reusable references; saved revisions preserve the composition you review.</p>${link("/docs/", "Find your guide →", "text-link")}</div><ul class="plain-list">
    <li><strong>Preserve reviewed intent</strong><p>Saved plans bind exact revisions, observations, and review fences. Package inspection supports that review.</p></li>
    <li><strong>Evaluate the current boundaries</strong><p>Architecture review is available in roadmap source and local fixtures. Composed workspace rollout is still being verified. Live host recognition and consent need separate acceptance.</p></li>
    <li><strong>Work through your preferred surface</strong><p>Use the web app, CLI, API, or MCP for authorized registry and architecture review actions. Runtime policy enforcement depends on the target and verified delivery path.</p></li>
  </ul></div></section>
  <section class="closing"><div class="wrap"><div><h2>Run the registry on your terms.</h2><p>Self-host your accounts and skill packages. Start with a local evaluation, then use the production guide when you are ready.</p></div>${button("/setup/", "Run the local demo")}</div></section>`;
}

function setup() {
  const clone = `git clone --branch ${release.tag} ${repository}.git\ncd myskills\nnpm install -g "$(node -p 'require("./package.json").packageManager')"\nnpm ci`;
  return intro("Local evaluation", "Run MySkills locally.", "Try the public beta with disposable local data. The repository guide remains the authority for setup and configuration.", `${button(source("docs/GETTING_STARTED.md"), "Canonical getting started guide")}${button("/downloads/", "Check releases", true)}`) +
    `<div class="wrap page-body page-layout">${onThisPage([["prerequisites", "Prerequisites"], ["clone", "Clone and configure"], ["start", "Start the demo"], ["verify", "Verify the first run"], ["production", "Self-hosting"]])}<div>
    <div class="notice"><p><strong>Local demo, local data.</strong> Do not reuse local seed credentials in production. Review the untracked environment file before starting; keep secrets out of Git.</p></div>
    ${article("prerequisites", "1. Check your environment", `<ul><li>Git and macOS or Linux. Windows/WSL2 are outside the current beta verification matrix.</li><li>Node.js 22.13+ within 22.x, or Node.js 24.x.</li><li>The npm version declared by the chosen release’s packageManager field.</li><li>Docker with Compose for local Postgres and MinIO dependencies.</li></ul><p>The application runs through npm; Docker supplies the local data services.</p>`)}
    ${article("clone", "2. Clone a release and configure it", `<p>This example uses the verified GitHub prerelease ${esc(release.tag)}. ${link(`${repository}/releases`, "Review the release list")} before choosing a version.</p>${command("clone-commands", "Clone the verified prerelease", clone, true)}<p class="copy-status" id="copy-status" role="status" aria-live="polite"></p>${command("configure-commands", "Create the local environment file and build", "cp .env.example .env\nnpm run build")}<p>Review .env locally. The normal npm development commands read it through Node’s env-file support.</p>`)}
    ${article("start", "3. Start dependencies and the app", `${command("dependency-commands", "Database and object storage", "npm run docker:up\nnpm run db:migrate\nnpm run db:seed")}<p>Start the API and web app in separate terminals.</p>${command("api-command", "Terminal 1 · API", "npm run dev:api")}${command("web-command", "Terminal 2 · web", "npm run dev:web")}<p>Open ${link("http://localhost:3000/registry", "localhost:3000/registry")} and look for the seeded Release Notes Helper. Read seed credentials only from your local .env.</p>`)}
    ${article("verify", "4. Verify your first run", `${command("verify-commands", "Local API and public example", "curl http://localhost:3001/health\ncurl http://localhost:3001/ready\nnode apps/cli/dist/index.js validate --path examples/skills/release-notes-helper\nnode apps/cli/dist/index.js scan --path examples/skills/release-notes-helper")}<p>The ${link(source("docs/GETTING_STARTED.md"), "canonical guide")} includes full first-run checks, optional MCP servers, and shutdown steps.</p>`)}
    ${article("production", "Evaluation comes before production", `<p>Public beta APIs, package formats, and deployment defaults may change. MySkills is not yet a business-critical production platform.</p><p>${link(source("docs/DEPLOYMENT.md"), "Production deployment guide", "text-link")}<br>${link(source("docs/UPGRADE_POLICY.md"), "Read the upgrade policy", "text-link")}<br>${link("/security/", "Security and reporting", "text-link")}</p>`)}
    </div></div>`;
}

function docs() {
  const groups = [...new Set(guides.map((guide) => guide.group))];
  return intro("Documentation", "One source of truth.\nA clear place to start.", "These guides open the canonical repository documentation. Follow the document for your chosen release when exact setup or API behavior matters.", button("/setup/", "Run the local demo")) +
    `<section class="wrap page-body"><div class="guide-groups">${groups.map((group) => `<section class="guide-group" aria-label="${esc(group)}"><h2>${esc(group)}</h2>${guides.filter((guide) => guide.group === group).map((guide) => `<a class="guide-link" href="${esc(source(guide.path))}"><h3>${esc(guide.title)} ↗</h3><p>${esc(guide.text)}</p><span>${esc(guide.path)}</span></a>`).join("")}</section>`).join("")}</div></section>
    <section class="closing"><div class="wrap"><div><h2>Want to see a skill before you build one?</h2><p>Read the public examples, including their manifests and instruction files.</p></div>${button("/examples/", "Browse examples")}</div></section>`;
}

function gallery() {
  return intro("Public example packages", "Real instructions.\nSmall enough to inspect.", "Three public-safe packages from the repository. These are source examples; their presence here does not claim a published registry release or a measured performance result.", button(`${repository}/tree/main/examples/skills`, "Open examples on GitHub", true)) +
    `<section class="wrap page-body" aria-label="Example skills">${examples.map(({ slug, manifest, instructions }) => `<article class="example-row" id="${slug}"><div><div class="example-id">${esc(slug)}</div><div class="example-meta">v${esc(manifest.version)} · ${esc(manifest.license)}<br>Codex · public source</div></div><div><h2>${esc(manifest.title)}</h2><p>${esc(manifest.summary)}</p><details class="example-excerpt"><summary>Preview the instructions</summary><pre>${esc(instructions)}</pre></details></div><div class="example-links">${link(source(`examples/skills/${slug}/SKILL.md`), "Read SKILL.md")}${link(`${repository}/tree/main/examples/skills/${slug}`, "View package")}${link(source(`examples/skills/${slug}/skill.json`), "View manifest")}</div></article>`).join("")}</section>`;
}

function downloads() {
  return intro("Public beta · release evidence", "Downloads and status.", "Choose a tagged release for evaluation. Source, GitHub release artifacts, package distribution, and a running instance are separate states.", `${button(release.url, "Open verified GitHub release")}${button(`${repository}/releases`, "Browse all releases", true)}`) +
    `<div class="wrap page-body page-layout">${onThisPage([["release-status", "Release status"], ["downloads", "Download paths"], ["beta", "Beta limits"]])}<div>
    ${article("release-status", "What is verified", `<dl class="status-list"><div><dt>GitHub prerelease</dt><dd><strong>${esc(release.tag)}</strong><p>Published ${esc(release.publishedAt)}. This is the verified release snapshot used by this site. ${link(`${repository}/releases`, "Check GitHub for newer releases")}</p></dd></div><div><dt>This source tree</dt><dd><strong>${esc(packageJson.version)}</strong><p>The workspace version at build time. Source/staging changes do not establish a published release.</p></dd></div><div><dt>Running instance</dt><dd><p>A GitHub release does not confirm a running instance, its serving revision, or its health. This static site does not monitor the app.</p>${link(appUrl("/registry"), "Open the app", "text-link")}</dd></div></dl>`)}
    ${article("downloads", "Get the release from its source", `<ul class="plain-list"><li><strong>Source and release assets</strong><p>Use the tag’s GitHub release page for source archives and attached release assets. Review its checksums and notes.</p>${link(release.url, "View release assets ↗", "text-link")}</li><li><strong>CLI</strong><p>The canonical CLI guide covers installation, supported commands, and authentication. This site does not assert an npm channel version.</p>${link(source("apps/cli/README.md"), "Read the CLI installation guide ↗", "text-link")}</li><li><strong>Containers and self-hosting</strong><p>Use the production deployment and release guides to choose an image or build from the chosen tag.</p>${link(source("docs/DEPLOYMENT.md"), "Read deployment instructions ↗", "text-link")}<br>${link(source("docs/RELEASE.md"), "Read the release guide ↗", "text-link")}</li></ul>`)}
    ${article("beta", "Evaluate with the limits in view", `<p>Use non-critical workloads. APIs, package formats, and deployment defaults can change before 1.0. Security triage is best effort during beta, with no SLA.</p><p>${link(source("docs/UPGRADE_POLICY.md"), "Upgrade policy", "text-link")}<br>${link("/security/", "Security and reporting", "text-link")}</p>`)}
    </div></div>`;
}

function security() {
  return intro("Security", "Know what you are trusting.", "MySkills is a public beta for evaluation and experimental self-hosting. Review the package instructions, your instance configuration, and the published security boundaries.", `${button(`${repository}/security/advisories/new`, "Report a vulnerability privately")}${button(source("SECURITY.md"), "Read the security policy", true)}`) +
    `<div class="wrap page-body page-layout">${onThisPage([["report", "Private reporting"], ["packages", "Package safety"], ["permissions", "Permissions"], ["scope", "Beta scope"]])}<div>
    ${article("report", "Keep vulnerability details private", `<p>Do not open a public issue for a suspected vulnerability, exposed secret, permission bypass, or package-safety escape. Use GitHub private vulnerability reporting.</p><p>If GitHub does not show a private reporting button, contact the maintainer through ${link("https://github.com/jremick", "their GitHub profile")} and request a private channel before sharing details.</p><p>Include the affected release or commit, component, reproduction steps, and whether private data, credentials, or package contents are involved. Beta triage is best effort; there is no SLA.</p>`)}
    ${article("packages", "A reviewed package still needs your judgment", `<p>Package intake validates manifests and scans package contents. Publication and artifact delivery use server-side review, lifecycle, visibility, and integrity checks.</p><p>Read the instructions before use. A scan or review does not prove that a skill is safe for every task, host, model, or tool permission.</p><p>${link(source("docs/SECURITY_MODEL.md"), "Read the full security model ↗", "text-link")}</p>`)}
    ${article("permissions", "The API owns authorization", `<p>Accounts, permissions, review decisions, release records, and audit history are application data. API tokens need explicit scopes and the user’s local roles. Privileged session actions retain MFA requirements.</p><p>Public pages do not grant access to private skills or package files. This documentation site reads no account, Library, or team activity.</p><p>${link(source("docs/THREAT_MODEL.md"), "Read the threat model ↗", "text-link")}</p>`)}
    ${article("scope", "Keep beta use bounded", `<p>Only the latest main branch and latest tagged beta release receive security attention. The project is not yet a business-critical production platform.</p><p>Keep local seed credentials out of production, protect deployment secrets, and use the documented backup and upgrade paths.</p><p>${link(source("docs/BACKUPS.md"), "Backup and restore guide ↗", "text-link")}<br>${link(source("docs/UPGRADE_POLICY.md"), "Upgrade policy ↗", "text-link")}</p>`)}
    </div></div>`;
}

const renderers = { "/": home, "/setup/": setup, "/docs/": docs, "/examples/": gallery, "/downloads/": downloads, "/security/": security };
for (const surface of surfaces) {
  const nav = `<nav class="primary-nav" id="primary-navigation" aria-label="Primary" data-open="false"><ul>${surfaces.map(({ path, label }) => `<li><a href="${path}"${path === surface.path ? ' aria-current="page"' : ""}>${label}</a></li>`).join("")}</ul></nav>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(surface.title)}</title><meta name="description" content="${esc(surface.description)}"><meta name="theme-color" content="#F6F8FA"><meta property="og:title" content="${esc(surface.title)}"><meta property="og:description" content="${esc(surface.description)}"><meta property="og:type" content="website"><link rel="icon" href="/assets/mark.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/styles.css"><script src="/assets/site.js" defer></script></head><body>
<a class="skip-link" href="#main-content">Skip to content</a><header class="site-header"><div class="wrap header-inner">${brand}${nav}<div class="header-actions">${link(appUrl("/login"), "Sign in")}${link(appUrl("/registry"), "Explore skills", "button small")}<button class="menu-button" type="button" data-menu aria-controls="primary-navigation" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M4 12h16M4 17h16"/></svg>Menu</button></div></div></header>
<main id="main-content" tabindex="-1">${renderers[surface.path]()}</main>
<footer class="site-footer"><div class="wrap"><div class="footer-top">${brand}<div class="footer-links">${link(repository, "GitHub ↗")}${link("/docs/", "Documentation")}${link("/security/", "Security")}${link(source("LICENSE"), "Apache-2.0 ↗")}</div></div><div class="footer-bottom"><p>Public beta · Source version ${esc(packageJson.version)}</p><p>Canonical guides live in the repository.</p></div></div></footer></body></html>\n`;
  const directory = new URL(surface.path.slice(1), output);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL("index.html", directory), html);
}

await mkdir(new URL("assets/", output), { recursive: true });
for (const file of ["styles.css", "site.js"]) await copyFile(new URL(`src/${file}`, site), new URL(`assets/${file}`, output));
await writeFile(new URL("assets/mark.svg", output), mark.replace('class="brand-mark" ', 'xmlns="http://www.w3.org/2000/svg" '));
await writeFile(new URL("site-build.json", output), `${JSON.stringify({ sourceVersion: packageJson.version, appOrigin: app, releaseSnapshot: release, routes: surfaces.map(({ path }) => path), scope: "Static product/docs site. Does not establish app deployment, npm publication, or provider acceptance." }, null, 2)}\n`);
process.stdout.write(`Built ${surfaces.length} static MySkills surfaces in ${fileURLToPath(output)}\n`);
