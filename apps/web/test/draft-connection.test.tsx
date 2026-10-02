import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { DraftWorkspace } from "../src/components/authoring/DraftWorkspace.js";
import type { AuthorDraft, DraftClient, DraftSubmission } from "../src/drafts-api.js";

Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: window.sessionStorage });
afterEach(() => { cleanup(); sessionStorage.clear(); });
const head: AuthorDraft = { id: "draft-id", title: "Private title canary", revision: 1,
  files: [{ path: "SKILL.md", content: "Private content canary" }], source: null, submission: null, createdAt: "2026-10-01", updatedAt: "2026-10-01" };
const props = { actorId: "same-actor", url: "/submit?draft=draft-id", onNavigate() {}, onNavigationGuardChange() {}, correctionSource: null, async onSubmitted() {} };
function client(registryIdentity: string, get: DraftClient["get"]): DraftClient {
  return { registryIdentity, list: async () => ({ drafts: [] }), get, history: async () => ({ revisions: [{ ...head, title: "Private history canary", fileCount: 1, textBytes: 22 }] }) } as unknown as DraftClient;
}

test("draft submission action status and receipt heading remain distinct while saved history is compared", async () => {
  const saved = { ...head, revision: 2, files: [{ path: "SKILL.md", content: "Current saved content" }] };
  const submission: DraftSubmission = { id: "submission-id", slug: "helper", version: "0.1.1", artifactSha256: "a".repeat(64),
    reviewStatus: "unreviewed", securityStatus: "pending", scan: { status: "queued", findings: [], findingCount: 0 } };
  const api = { ...client("https://registry.example", async () => ({ draft: saved })),
    async submit(id: string, revision: number) {
      assert.equal(id, head.id); assert.equal(revision, 2);
      return { draft: { ...saved, submission }, submission };
    },
    async revision(id: string, revision: number) {
      assert.equal(id, head.id); assert.equal(revision, 1);
      return { draft: head };
    },
  };
  const view = render(<DraftWorkspace {...props} api={api} />);
  await view.findByDisplayValue("Current saved content");
  fireEvent.click(view.getByRole("button", { name: "Submit saved revision" }));
  const heading = await view.findByRole("heading", { name: "Submitted helper@0.1.1" });
  assert.equal(view.getAllByText(/Submitted .*0\.1\.1/).length, 2, "unscoped submission text deliberately matches both status and summary");
  const statuses = view.container.querySelectorAll(".author-status[role='status']");
  assert.equal(statuses.length, 1); assert.equal(statuses[0]!.textContent, "Submitted helper@0.1.1.");
  assert.equal(heading.closest(".draft-receipt")?.getAttribute("role"), "status");
  const history = await view.findByRole("region", { name: "Saved draft history" });
  fireEvent.change(within(history).getByLabelText("Compare saved revision", { exact: true }), { target: { value: "1" } });
  await within(history).findByText("1 changed files", { exact: true });
  assert.equal(within(history).getByRole("button", { name: "Restore as new revision" }).textContent, "Restore as new revision");
});

for (const boundary of ["client", "credential", "registry"] as const) test(`draft private state and old responses are cleared across ${boundary} replacement for same actor`, async () => {
  const first = client("https://first.example", async () => ({ draft: head }));
  const view = render(<DraftWorkspace {...props} api={first} />);
  await view.findByDisplayValue("Private content canary");
  fireEvent.click(view.getByRole("button", { name: /history/i }));
  await view.findByText(/Private history canary/);
  fireEvent.change(view.getByRole("textbox", { name: "File contents" }), { target: { value: "Private recovery canary" } });
  let resolve!: (value: { draft: AuthorDraft }) => void;
  const pending = client("https://first.example", () => new Promise(done => { resolve = done; }));
  view.rerender(<DraftWorkspace {...props} api={pending} />);
  const denied = client(boundary === "registry" ? "https://other.example" : "https://first.example", async () => { throw new Error("Access denied"); });
  view.rerender(<DraftWorkspace {...props} api={denied} />);
  assert.equal(view.queryByDisplayValue("Private content canary"), null);
  assert.equal(view.queryByText(/Private history canary/), null);
  assert.equal(view.queryByDisplayValue("Private recovery canary"), null);
  await act(async () => { resolve({ draft: head }); });
  assert.equal(view.queryByDisplayValue("Private content canary"), null);
  const authorized = client(denied.registryIdentity!, async () => ({ draft: { ...head, title: "New authorized draft", files: [{ path: "SKILL.md", content: "New authorized content" }] } }));
  view.rerender(<DraftWorkspace {...props} api={authorized} />);
  await view.findByDisplayValue("New authorized content");
  assert.equal(view.queryByText(/Recover unsaved/), null);
});

test("same client reference with a new credential epoch clears private edits and history immediately", async () => {
  const api=client("https://registry.example",async()=>({draft:head}));
  const view=render(<DraftWorkspace {...props} api={api} credentialEpoch="first"/>);
  await view.findByDisplayValue("Private content canary");
  fireEvent.change(view.getByRole("textbox",{name:"File contents"}),{target:{value:"Private recovery canary"}});
  view.rerender(<DraftWorkspace {...props} api={api} credentialEpoch="second"/>);
  assert.equal(view.queryByDisplayValue("Private recovery canary"),null);
  assert.equal(view.queryByRole("region",{name:"Unsaved edit recovery"}),null);
  await view.findByDisplayValue("Private content canary");
});

test("authorized same-credential recovery remains available across client reconstruction, but not another registry", async () => {
  const api={...client("https://one.example",async()=>({draft:head})),credentialIdentity:"opaque-credential"};
  const view=render(<DraftWorkspace {...props} api={api}/>);await view.findByDisplayValue("Private content canary");
  fireEvent.change(view.getByRole("textbox",{name:"File contents"}),{target:{value:"Private recovery canary"}});
  const reconstructed={...api};view.rerender(<DraftWorkspace {...props} api={reconstructed}/>);
  await view.findByRole("region",{name:"Unsaved edit recovery"});
  assert.equal(view.queryByDisplayValue("Private recovery canary"),null);
  const other={...api,registryIdentity:"https://two.example"};view.rerender(<DraftWorkspace {...props} api={other}/>);
  await view.findByDisplayValue("Private content canary");assert.equal(view.queryByRole("region",{name:"Unsaved edit recovery"}),null);
});

test("credential identity rotation cannot reuse an equal session epoch or its private recovery", async () => {
  const api={...client("https://registry.example",async()=>({draft:head})),credentialIdentity:"first-credential"};
  const view=render(<DraftWorkspace {...props} api={api} credentialEpoch="equal-session-expiry"/>);
  await view.findByDisplayValue("Private content canary");
  fireEvent.click(view.getByRole("button",{name:/history/i}));await view.findByText(/Private history canary/);
  fireEvent.change(view.getByRole("textbox",{name:"File contents"}),{target:{value:"Private recovery canary"}});
  api.credentialIdentity="second-credential";
  api.get=async()=>({draft:{...head,files:[{path:"SKILL.md",content:"New authorized content"}]}});
  view.rerender(<DraftWorkspace {...props} api={api} credentialEpoch="equal-session-expiry"/>);
  assert.equal(view.queryByDisplayValue("Private recovery canary"),null);assert.equal(view.queryByText(/Private history canary/),null);
  await view.findByDisplayValue("New authorized content");assert.equal(view.queryByRole("region",{name:"Unsaved edit recovery"}),null);
});
