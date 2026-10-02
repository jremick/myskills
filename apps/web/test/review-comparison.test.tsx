import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ReviewComparison } from "../src/components/registry/ReviewComparison.js";
import type { RegistryClient, ReviewSubmissionSummary, SkillReleaseSummary } from "../src/api.js";
afterEach(() => cleanup());
const id = "00000000-0000-4000-8000-000000000001";
const payload = (version: string) => ({ files: [{ path: "skill.json", content: JSON.stringify({ name: "compare", version }) }, { path: "SKILL.md", content: "PRIVATE-REVIEW-CANARY" + "a".repeat(2000) + version }] });
const sha = (version: string) => createHash("sha256").update(JSON.stringify(payload(version))).digest("hex");
const submission = { id, slug: "compare", version: "2.0.0", reviewStatus: "pending" } as ReviewSubmissionSummary;
function fixture() {
  const base = { id: "base", slug: "compare", version: "1.0.0", lifecycleStatus: "approved", reviewStatus: "approved", securityStatus: "passed", publishedAt: "2026-10-01", artifact: { sha256: sha("1.0.0") } } as SkillReleaseSummary;
  let revoked = false;
  const client = {
    listSkillReleases: async () => [base], getRelease: async () => { if (revoked) throw new Error("Denied"); return base; },
    getReleaseBundle: async () => payload("1.0.0"), getReviewSubmissionDetail: async () => submission,
    getReviewSubmissionBundle: async () => { if (revoked) throw new Error("Denied"); return { payload: payload("2.0.0"), artifactSha256: sha("2.0.0") }; },
    performReviewAction: async () => assert.fail("comparison must not approve"),
  } as unknown as RegistryClient;
  return { client, revoke: () => { revoked = true; } };
}
test("review diff compares complete candidate content, bounds previews and clears private evidence on current denial", async () => {
  const f = fixture(); const view = render(<ReviewComparison client={f.client} submission={submission} />);
  await view.findByRole("option", { name: "1.0.0" });
  fireEvent.change(view.getByLabelText("Published baseline"), { target: { value: "1.0.0" } });
  fireEvent.click(view.getByRole("button", { name: "Compare candidate" }));
  await view.findByText(/Modified 2/);
  assert.ok(view.getByText(/Candidate SHA-256:/)); assert.ok(view.getAllByText(/Preview truncated/).length >= 2);
  assert.equal(document.body.textContent?.includes("PRIVATE-REVIEW-CANARY"), true);
  f.revoke(); fireEvent.click(view.getByRole("button", { name: "Compare candidate" }));
  await view.findByRole("alert"); assert.equal(document.body.textContent?.includes("PRIVATE-REVIEW-CANARY"), false);
});
test("review diff invalidates completed and late candidate reads when its client changes", async () => {
  const f = fixture(); let finish!: (value: Awaited<ReturnType<RegistryClient["getReviewSubmissionBundle"]>>) => void;
  f.client.getReviewSubmissionBundle = () => new Promise(done => { finish = done; });
  const view = render(<ReviewComparison client={f.client} submission={submission} />);
  await view.findByRole("option", { name: "1.0.0" }); fireEvent.change(view.getByLabelText("Published baseline"), { target: { value: "1.0.0" } });
  fireEvent.click(view.getByRole("button", { name: "Compare candidate" }));
  await act(async () => { for (let n = 0; n < 10 && !finish; n++) await new Promise(done => setTimeout(done, 5)); });
  assert.ok(finish);
  const denied = { ...f.client, listSkillReleases: async () => { throw new Error("Denied"); } };
  view.rerender(<ReviewComparison client={denied} submission={submission} />);
  await act(async () => finish({ payload: payload("2.0.0"), artifactSha256: sha("2.0.0") }));
  await view.findByRole("alert"); assert.equal(document.body.textContent?.includes("PRIVATE-REVIEW-CANARY"), false);
});
