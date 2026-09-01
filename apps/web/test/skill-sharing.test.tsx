import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { PublicSkill, SkillSharingDetails } from "@myskills-app/core";
import { SharingPanel } from "../src/App.js";
import type { RegistryClient } from "../src/api.js";

afterEach(() => cleanup());

test("skill sharing loads server-listed organizations and preserves current grants on unrelated edits", async () => {
  const organizations = [
    { id: "org-2", name: "Workgroup", slug: "workgroup", status: "active" as const, role: "member" as const },
    { id: "org-1", name: "Acme", slug: "acme", status: "active" as const, role: "owner" as const },
  ];
  let details: SkillSharingDetails = {
    slug: "release-notes-helper",
    title: "Release Notes Helper",
    visibility: "private",
    settings: {
      publicVisibilityEnabled: true,
      authenticatedVisibilityEnabled: true,
      teamsEnabled: true,
      teamVisibilityEnabled: true,
      userVisibilityEnabled: true,
      organizationVisibilityEnabled: true,
    },
    availableTeams: [],
    teamGrants: [],
    userGrants: [],
    organizationGrants: [organizations[1]!],
  };
  const updates: Array<{ visibility: string; teamIds: string[]; userEmails: string[]; organizationIds: string[] }> = [];
  const client = {
    async getSkillSharing() {
      return details;
    },
    async listOrganizations() {
      return organizations.map((organization) => ({
        ...organization,
        currentPolicyRevisionId: "policy-1",
        createdByUserId: "user-1",
        createdAt: "2026-06-14T00:00:00.000Z",
        updatedAt: "2026-06-14T00:00:00.000Z",
      }));
    },
    async updateSkillSharing(input: { visibility: "private"; teamIds: string[]; userEmails: string[]; organizationIds: string[]; slug: string }) {
      updates.push(input);
      details = {
        ...details,
        visibility: input.visibility,
        organizationGrants: organizations.filter((organization) => input.organizationIds.includes(organization.id)),
      };
      return details;
    },
  } as unknown as RegistryClient;
  const skill: PublicSkill = {
    slug: "release-notes-helper",
    title: "Release Notes Helper",
    summary: "Turns changes into release notes.",
    lifecycleStatus: "approved",
    visibility: "private",
    latestVersion: "0.1.0",
    reviewStatus: "approved",
    securityStatus: "passed",
    platforms: [],
    tags: [],
    access: { canManageSharing: true, reasons: ["owner"] },
  };

  const view = render(
    <SharingPanel
      client={client}
      selectedSkill={skill}
      session={{
        expiresAt: "2026-06-14T01:00:00.000Z",
        user: {
          id: "user-1",
          email: "owner@example.com",
          name: "Owner",
          status: "active",
          roles: ["owner"],
          emailVerified: true,
          mfaVerified: true,
        },
      }}
    />,
  );

  await view.findByText("Current grants: Acme");
  const acme = view.getByRole("checkbox", { name: "Share with Acme" }) as HTMLInputElement;
  const workgroup = view.getByRole("checkbox", { name: "Share with Workgroup" }) as HTMLInputElement;
  assert.equal(acme.checked, true);
  assert.equal(workgroup.checked, false);

  fireEvent.change(view.getByLabelText("Visibility"), { target: { value: "organization" } });
  fireEvent.click(workgroup);
  fireEvent.change(view.getByLabelText("Visibility"), { target: { value: "private" } });
  fireEvent.click(view.getByRole("button", { name: "Save sharing" }));

  await waitFor(() => assert.equal(updates.length, 1));
  assert.deepEqual(updates[0], {
    slug: "release-notes-helper",
    visibility: "private",
    teamIds: [],
    userEmails: [],
    organizationIds: ["org-1", "org-2"],
  });
});
