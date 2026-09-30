import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { TaskDiscoveryResponse } from "@myskills-app/core";
import type { RegistryClient } from "../src/api.js";
import { TaskDiscovery } from "../src/components/registry/TaskDiscovery.js";

afterEach(() => cleanup());
const response = {
  method: "lexical-v1", uncertainty: [], results: [{ skill: { title: "Private canary", summary: "Private metadata" }, release: { slug: "private-canary", version: "1.0.0", sha256: "a".repeat(64) }, relevance: { label: "word-overlap", matchedTerms: ["private"] } }],
} as unknown as TaskDiscoveryResponse;
const href = (slug: string, version: string) => `/skills/${slug}?version=${version}`;

for (const boundary of ["token", "connection"] as const) test(`task text, private results and pending state do not cross a ${boundary} change`, async () => {
  let resolve!: (value: TaskDiscoveryResponse) => void;
  let calls = 0;
  const client = { discoverTask: () => ++calls === 1 ? Promise.resolve(response) : new Promise<TaskDiscoveryResponse>(done => { resolve = done; }) } as unknown as RegistryClient;
  const next = { discoverTask: async () => ({ ...response, results: [] }) } as unknown as RegistryClient;
  const view = render(<TaskDiscovery client={client} token="first" skillHref={href} />);
  view.container.querySelector("details")!.open = true;
  fireEvent.change(view.getByRole("textbox", { name: "Task description" }), { target: { value: "private task" } });
  fireEvent.click(view.getByRole("button", { name: "Find relevant skills" }));
  await view.findByText("Private canary · 1.0.0");
  const renderNext = () => view.rerender(<TaskDiscovery client={boundary === "connection" ? next : client} token={boundary === "token" ? "second" : "first"} skillHref={href} />);
  renderNext();
  view.container.querySelector("details")!.open = true;
  assert.equal(view.queryByText("Private canary · 1.0.0"), null);
  assert.equal((view.getByRole("textbox", { name: "Task description" }) as HTMLTextAreaElement).value, "");
  // Return to the initial connection, start a delayed read, then switch again.
  view.rerender(<TaskDiscovery client={client} token="first" skillHref={href} />);
  view.container.querySelector("details")!.open = true;
  fireEvent.change(view.getByRole("textbox", { name: "Task description" }), { target: { value: "pending private task" } });
  fireEvent.click(view.getByRole("button", { name: "Find relevant skills" }));
  assert.ok(view.getByRole("button", { name: "Finding skills…" }));
  renderNext();
  view.container.querySelector("details")!.open = true;
  assert.equal(view.queryByRole("button", { name: "Finding skills…" }), null);
  fireEvent.change(view.getByRole("textbox", { name: "Task description" }), { target: { value: "new task" } });
  assert.equal((view.getByRole("button", { name: "Find relevant skills" }) as HTMLButtonElement).disabled, false);
  await act(async () => { resolve(response); });
  assert.equal(view.queryByText("Private canary · 1.0.0"), null);
});
