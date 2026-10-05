import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { SkillPreview } from "../src/components/registry/SkillPreview.js";
import type { SkillPackageBundle } from "../src/api.js";

beforeEach(() => {
  // JSDOM has no native dialog lifecycle. Keyboard/inert behavior is covered
  // separately in Chromium; this shim makes component state observable here.
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); document.body.style.overflow = ""; });

const bundle = (content: string): SkillPackageBundle => ({ files: [{ path: "SKILL.md", content }] });
const props = { title: "Release Notes Helper", version: "1.0.0", platform: "codex" };
const deferred = () => {
  let resolve!: (value: SkillPackageBundle) => void;
  const promise = new Promise<SkillPackageBundle>(done => { resolve = done; });
  return { promise, resolve };
};

test("View Skill is on demand, single-flight under repeated clicks and StrictMode, and refetches when reopened", async () => {
  let calls = 0;
  const loadBundle = async () => { calls++; return bundle("# Instructions\n\nRead the **selected** release."); };
  const view = render(<StrictMode><SkillPreview {...props} loadBundle={loadBundle} /></StrictMode>);
  assert.equal(calls, 0);
  const trigger = view.getByRole("button", { name: "View Skill" });
  trigger.focus();
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  await view.findByRole("heading", { name: "Instructions" });
  assert.equal(calls, 1);
  assert.equal(view.getAllByRole("dialog").length, 1);
  assert.equal(document.activeElement, view.getByRole("heading", { name: props.title }));
  assert.equal(document.body.style.overflow, "hidden");
  assert.equal(view.getByText("selected").tagName, "STRONG");
  fireEvent.click(view.getByRole("button", { name: "Close skill preview" }));
  assert.equal(view.queryByRole("dialog"), null);
  assert.equal(document.body.style.overflow, "");
  assert.equal(document.activeElement, trigger);
  fireEvent.click(trigger);
  await view.findByRole("heading", { name: "Instructions" });
  assert.equal(calls, 2);
});

test("renders only root SKILL.md and safely formats Markdown, metadata and GFM", async () => {
  const content = '---\nname: release-notes\ndescription: Exact instructions\n---\n# Root instructions\n\n- First item\n- Second item\n\n```sh\nprintf "safe"\n```\n\n| Field | Value |\n| --- | --- |\n| release | exact |\n\n[Docs](https://example.test/docs) [Relative](./reference.md) [Danger](javascript:alert%281%29)\n\n![Tracker](https://example.test/pixel.png)\n\n<img src="https://example.test/raw.png" onerror="alert(1)"><script>alert(1)</script><iframe src="https://example.test"></iframe>';
  const view = render(<SkillPreview {...props} loadBundle={async () => ({ files: [
    { path: "nested/SKILL.md", content: "# Wrong nested skill" },
    { path: "skill.md", content: "# Wrong case" },
    { path: "SKILL.md", content },
  ] })} />);
  fireEvent.click(view.getByRole("button", { name: "View Skill" }));
  await view.findByRole("heading", { name: "Root instructions" });
  assert.equal(view.queryByText("Wrong nested skill"), null);
  assert.equal(view.queryByText("Wrong case"), null);
  assert.equal(view.getByText("Skill metadata").tagName, "SUMMARY");
  assert.equal(view.getByText('printf "safe"').tagName, "CODE");
  assert.equal(view.getAllByRole("listitem").length, 2);
  assert.ok(view.getByRole("table"));
  assert.equal(view.getByRole("link", { name: "Docs" }).getAttribute("rel"), "noopener noreferrer");
  assert.equal(view.getByRole("link", { name: "Docs" }).getAttribute("referrerpolicy"), "no-referrer");
  assert.equal(view.queryByRole("link", { name: "Relative" }), null);
  assert.equal(view.queryByRole("link", { name: "Danger" }), null);
  assert.equal(view.container.querySelector("img, script, iframe"), null);
  assert.ok(view.getByText("[Image: Tracker]"));
});

test("missing root SKILL.md and empty instructions are explicit, with no README fallback", async () => {
  const view = render(<SkillPreview {...props} loadBundle={async () => ({ files: [{ path: "nested/SKILL.md", content: "Wrong instructions" }, { path: "README.md", content: "Wrong readme" }] })} />);
  fireEvent.click(view.getByRole("button", { name: "View Skill" }));
  await view.findByText(/does not include a root SKILL.md/);
  assert.equal(view.queryByText("Wrong readme"), null);
  view.rerender(<SkillPreview key="empty" {...props} loadBundle={async () => bundle(" \n\t ")} />);
  fireEvent.click(view.getByRole("button", { name: "View Skill" }));
  await view.findByText(/SKILL.md file in this release is empty/);
});

test("denied preview clears loading and can retry without exposing stale text", async () => {
  let calls = 0;
  const view = render(<SkillPreview {...props} loadBundle={async () => {
    if (++calls === 1) throw Object.assign(new Error("Untrusted response detail"), { status: 403, code: "FORBIDDEN" });
    return bundle("# Authorized retry");
  }} />);
  fireEvent.click(view.getByRole("button", { name: "View Skill" }));
  await view.findByText("You do not have access to that skill or release.");
  assert.equal(view.queryByText("Untrusted response detail"), null);
  assert.equal(view.queryByText("Loading skill instructions…"), null);
  fireEvent.click(view.getByRole("button", { name: "Try again" }));
  await view.findByRole("heading", { name: "Authorized retry" });
  assert.equal(calls, 2);
  assert.equal(view.queryByRole("alert"), null);
});

test("close during loading ignores a late response and reopen uses a fresh request", async () => {
  const old = deferred();
  let calls = 0;
  const view = render(<SkillPreview {...props} loadBundle={() => ++calls === 1 ? old.promise : Promise.resolve(bundle("# Fresh instructions"))} />);
  fireEvent.click(view.getByRole("button", { name: "View Skill" }));
  await view.findByText("Loading skill instructions…");
  fireEvent(view.getByRole("dialog"), new window.Event("cancel", { bubbles: false, cancelable: true }));
  assert.equal(view.queryByRole("dialog"), null);
  fireEvent.click(view.getByRole("button", { name: "View Skill" }));
  await view.findByRole("heading", { name: "Fresh instructions" });
  await act(async () => { old.resolve(bundle("# Old private instructions")); });
  assert.equal(view.queryByRole("heading", { name: "Old private instructions" }), null);
  assert.ok(view.getByRole("heading", { name: "Fresh instructions" }));
});

test("changing resource identity dismisses the preview and ignores its pending response", async () => {
  const old = deferred();
  const view = render(<SkillPreview key="private:1:codex:alice" {...props} loadBundle={() => old.promise} />);
  fireEvent.click(view.getByRole("button", { name: "View Skill" }));
  await view.findByText("Loading skill instructions…");
  view.rerender(<SkillPreview key="public:2:generic:anonymous" {...props} version="2.0.0" platform="generic" loadBundle={async () => bundle("# Current instructions")} />);
  assert.equal(view.queryByRole("dialog"), null);
  assert.equal(document.body.style.overflow, "");
  fireEvent.click(view.getByRole("button", { name: "View Skill" }));
  await view.findByRole("heading", { name: "Current instructions" });
  await act(async () => { old.resolve(bundle("# Private old text")); });
  assert.equal(view.queryByText("Private old text"), null);
  assert.match(view.container.querySelector(".skill-preview-header p")?.textContent ?? "", /SKILL.md ·.*2.0.0.*generic/);
});

for (const [name, value, message] of [
  ["binary", bundle("bad\0file"), /binary content/],
  ["oversized", bundle("x".repeat(128_001)), /too large to preview/],
  ["duplicate root", { files: [{ path: "SKILL.md", content: "first" }, { path: "SKILL.md", content: "second" }] }, /more than one root/],
  ["malformed", { files: [null] }, /cannot be displayed safely/],
] as const) test(`${name} packages fail safely`, async () => {
  const view = render(<SkillPreview {...props} loadBundle={async () => value as SkillPackageBundle} />);
  fireEvent.click(view.getByRole("button", { name: "View Skill" }));
  await waitFor(() => assert.match(view.getByRole("alert").textContent ?? "", message));
  assert.ok(view.getByRole("button", { name: "Close skill preview" }));
});
