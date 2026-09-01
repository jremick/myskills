import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, render } from "@testing-library/react";
import { ArchitectureList } from "../src/components/architecture/ArchitectureDashboardListPanel.js";
import type { ArchitectureSummary } from "../src/api.js";

afterEach(() => cleanup());

test("saved architectures expose a semantic list of keyboard-focusable buttons", () => {
  const architectures = [
    { id: "architecture-1", name: "Personal stack", patternId: "flat", revisionCount: 1 },
    { id: "architecture-2", name: "Team stack", patternId: "multi-level-router", revisionCount: 2 },
  ] as unknown as ArchitectureSummary[];

  const view = render(<ArchitectureList architectures={architectures} selectedId="architecture-1" onSelect={() => undefined} />);

  const list = view.getByRole("list", { name: "Saved architectures" });
  assert.equal(view.queryByRole("listbox"), null);
  assert.equal(list.hasAttribute("aria-activedescendant"), false);
  assert.equal(view.getAllByRole("listitem").length, 2);
  assert.equal(view.getByRole("button", { name: /Personal stack/ }).getAttribute("aria-pressed"), "true");
});
