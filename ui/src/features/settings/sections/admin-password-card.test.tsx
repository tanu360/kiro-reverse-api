import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { renderWithProviders } from "@/test/render";
import { AdminPasswordCard } from "./admin-password-card";
import { SECTION_ID } from "./sections";

const ENV_NOTE = /ADMIN_PASSWORD puts its password back at each start\./;
const ENV_BADGE = "Set by ADMIN_PASSWORD";

async function renderCard(adminPasswordFromEnv: boolean) {
  mockDb.settings = { ...mockDb.settings, adminPasswordFromEnv };
  renderWithProviders(<AdminPasswordCard />);
  await screen.findByLabelText("New password");
  const card = document.getElementById(SECTION_ID.adminPassword);
  if (!card) throw new Error("admin password card not rendered");
  return card;
}

describe("AdminPasswordCard", () => {
  it("says a changed password lasts until the next start while ADMIN_PASSWORD is set", async () => {
    const card = await renderCard(true);
    expect(await within(card).findByText(ENV_NOTE)).toBeInTheDocument();
    expect(within(card).getByText(ENV_BADGE)).toBeInTheDocument();
  });

  it("says nothing more without ADMIN_PASSWORD", async () => {
    const card = await renderCard(false);
    expect(within(card).queryByText(ENV_NOTE)).not.toBeInTheDocument();
    expect(within(card).queryByText(ENV_BADGE)).not.toBeInTheDocument();
  });
});
