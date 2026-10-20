import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SkillLogo } from "../src/components/registry/SkillLogo.js";

afterEach(cleanup);

test("skill logos use the authorized API URL and fall back on missing or invalid images", () => {
  const view = render(<SkillLogo src="/api/v1/skills/example/releases/0.1.0/logo" tone="teal" />);
  const image = view.container.querySelector("img")!;
  assert.equal(image.getAttribute("src"), "/api/v1/skills/example/releases/0.1.0/logo");
  fireEvent.error(image);
  assert.equal(view.container.querySelector("img"), null);
  assert.equal(view.container.querySelector(".registry-tile")?.getAttribute("data-tone"), "teal");
  view.rerender(<SkillLogo src="/api/v1/skills/example/releases/0.2.0/logo" tone="teal" />);
  assert.ok(view.container.querySelector("img"));
  view.rerender(<SkillLogo tone="amber" />);
  assert.equal(view.container.querySelector("img"), null);
});
