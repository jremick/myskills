import assert from "node:assert/strict";
import test from "node:test";
import type { Page, TestInfo } from "@playwright/test";
import { captureDraftMobileProof } from "./e2e/fullstack/author-drafts.js";

type Viewport = { width: number; height: number };
const mobile = { width: 390, height: 844 };
const inherited = { width: 1366, height: 768 };

// Execute the actual fixture boundary with a Page contract double. These controls
// prove state restoration and error propagation, not browser layout or identity.
function fixture(initial: Viewport | null, fail?: "resize" | "evaluate" | "overflow" | "screenshot" | "restore") {
  let viewport = initial && { ...initial };
  const changes: Viewport[] = [];
  const screenshots: Array<{ path: string; fullPage: boolean }> = [];
  const failure = new Error(`fixture ${fail} failure`);
  const page = {
    viewportSize: () => viewport && { ...viewport },
    async setViewportSize(next: Viewport) {
      changes.push({ ...next });
      viewport = { ...next };
      if ((fail === "resize" && changes.length === 1) || (fail === "restore" && changes.length === 2)) throw failure;
    },
    async evaluate() {
      assert.deepEqual(viewport, mobile, "overflow proof must run at the mobile viewport");
      if (fail === "evaluate") throw failure;
      return fail !== "overflow";
    },
    async screenshot(options: { path: string; fullPage: boolean }) {
      assert.deepEqual(viewport, mobile, "mobile evidence must be captured before restoration");
      screenshots.push(options);
      if (fail === "screenshot") throw failure;
    },
  } as unknown as Page;
  const info = { outputPath: (name: string) => `/fixture-output/${name}` } as TestInfo;
  return { page, info, changes, screenshots, failure, viewport: () => viewport };
}

for (const size of [inherited, { width: 1440, height: 900 }, { width: 412, height: 915 }]) {
  test(`draft mobile proof restores inherited ${size.width}x${size.height} before the next callback`, async () => {
    const control = fixture(size);
    await captureDraftMobileProof(control.page, control.info);
    assert.deepEqual(control.viewport(), size, "the consumer callback must receive the caller's viewport");
    assert.deepEqual(control.changes, [mobile, size]);
    assert.deepEqual(control.screenshots, [{ path: "/fixture-output/author-private-draft-mobile.png", fullPage: true }]);
  });
}

for (const boundary of ["resize", "evaluate", "overflow", "screenshot"] as const) {
  test(`draft mobile ${boundary} failure restores inherited state and still rejects`, async () => {
    const control = fixture(inherited, boundary);
    if (boundary === "overflow") await assert.rejects(captureDraftMobileProof(control.page, control.info), /toBe/);
    else await assert.rejects(captureDraftMobileProof(control.page, control.info), error => error === control.failure);
    assert.deepEqual(control.viewport(), inherited);
    assert.deepEqual(control.changes, [mobile, inherited]);
    assert.equal(control.screenshots.length, boundary === "screenshot" ? 1 : 0);
  });
}

test("draft mobile proof cannot pass if viewport restoration fails", async () => {
  const control = fixture(inherited, "restore");
  await assert.rejects(captureDraftMobileProof(control.page, control.info), error => error === control.failure);
  assert.deepEqual(control.changes, [mobile, inherited]);
});

test("draft mobile proof rejects an unconfigured viewport before changing caller state", async () => {
  const control = fixture(null);
  await assert.rejects(captureDraftMobileProof(control.page, control.info), /inherited viewport/);
  assert.equal(control.viewport(), null);
  assert.deepEqual(control.changes, []);
  assert.deepEqual(control.screenshots, []);
});
