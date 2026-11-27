import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatApi } from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
import { renderWithProviders } from "@/test/render";
import { StreamIntegrityCard } from "./stream-integrity-card";

const RESPONSES_NOTE =
  "The chat API is the newer one (CreateResponse): its finished replies always carry a stop reason, so only Kiro API keys need this switch. Left on, it still lets a cut-off reply pass as complete.";

async function renderWith(chatApi: ChatApi) {
  mockDb.endpoint = { ...mockDb.endpoint, chatApi };
  renderWithProviders(<StreamIntegrityCard />);
  await screen.findByRole("switch", { name: "Accept replies without metering" });
}

describe("StreamIntegrityCard and the chat API", () => {
  it("says only Kiro API keys need the switch while every account uses CreateResponse", async () => {
    await renderWith("responses");
    expect(await screen.findByText(RESPONSES_NOTE)).toBeInTheDocument();
  });

  it("says nothing more while chat can still use the older API", async () => {
    await renderWith("auto");
    expect(screen.queryByText(RESPONSES_NOTE)).not.toBeInTheDocument();
  });
});
