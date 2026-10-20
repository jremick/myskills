import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { parseSkillManifest } from "@myskills-app/skill-package";
import { buildApp } from "../../../api/dist/app.js";
import { MemorySkillRepository } from "../../../api/dist/repositories/memory-skill-repository.js";
import { MemorySubmissionStore } from "../../../api/dist/submissions/memory-submission-store.js";
import { SubmissionService } from "../../../api/dist/submissions/service.js";

test("API-backed registry renders PNG/SVG logos and preserves a missing-image fallback", async ({ page }, info) => {
  const service = new SubmissionService(new MemorySubmissionStore());
  const platforms = [{ name: "codex", installTarget: "codex-skill", status: "supported" as const }];
  const skills = ["png-logo", "svg-logo", "no-logo"].map(slug => ({ slug, title: slug, summary: "A skill logo acceptance fixture.", visibility: "public" as const,
    lifecycleStatus: "approved" as const, latestVersion: "0.1.0", reviewStatus: "approved" as const, securityStatus: "passed" as const, platforms, tags: [] }));
  for (const skill of skills) {
    const manifest = parseSkillManifest({ name: skill.slug, title: skill.title, summary: skill.summary, visibility: "public", version: "0.1.0", license: "MIT", platforms: [{ name: "codex", install_target: "codex-skill" }] });
    const files = [{ path: "skill.json", content: JSON.stringify(manifest) }, { path: "SKILL.md", content: `---\nname: ${skill.slug}\ndescription: A logo fixture\n---\n# Usage\nRead the instructions.` }];
    if (skill.slug === "png-logo") files.push({ path: "assets/logo.png", content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=" });
    if (skill.slug === "svg-logo") files.push({ path: "logo.svg", content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#245dce"/><path fill="#fff" d="M8 8h16v16H8z"/></svg>' });
    const created = await service.createSubmission({ actor: { id: "author", roles: ["author"] }, manifest, files });
    const actor = { id: "reviewer", roles: ["maintainer" as const] };
    await service.performReviewAction({ actor, submissionId: created.id, action: "approve", artifactSha256: created.artifact.sha256 });
    await service.performReviewAction({ actor, submissionId: created.id, action: "publish" });
  }
  const app = buildApp({ skillRepository: new MemorySkillRepository(skills), submissionService: service });
  const api = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/v1/registry/catalog") return route.fulfill({ json: { rows: skills.map(skill => ({ kind: "skill", skill, memberships: [] })), totalSkills: skills.length, totalBundles: 0, nextCursor: null, snapshot: "logo-fixture" } });
      const response = await route.fetch({ url: `${api}${url.pathname.slice(4)}${url.search}` });
      await route.fulfill({ response });
    });
    await page.goto("/skills/svg-logo");
    for (const slug of ["png-logo", "svg-logo"]) {
      const logo = page.locator(`.bundle-skill-link[href*="/skills/${slug}"] img`);
      await expect(logo).toBeVisible();
      await expect.poll(() => logo.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    }
    await expect(page.locator('.bundle-skill-link[href*="/skills/no-logo"] .bundle-tile')).toBeVisible();
    await expect(page.locator('.bundle-skill-link[href*="/skills/no-logo"] img')).toHaveCount(0);
    const detail = page.locator(".registry-inspector-head .registry-tile img");
    await expect(detail).toBeVisible();
    await expect.poll(() => detail.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath("skill-logos.png"), fullPage: true });
    await writeFile(info.outputPath("skill-logo-receipt.json"), JSON.stringify({ source: "local API with memory stores; catalog rows fixture; real browser rendering", pngDecoded: true, svgDecoded: true, missingLogoFallback: true, deployed: false }, null, 2));
  } finally { await app.close(); }
});
