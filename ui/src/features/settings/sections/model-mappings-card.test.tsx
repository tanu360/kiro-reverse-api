import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { defaultModelMappings } from "@/lib/mocks/fixtures";
import { renderWithProviders } from "@/test/render";
import { ModelMappingsCard } from "./model-mappings-card";

describe("ModelMappingsCard", () => {
  it("keeps focus on screen when a filtered row is deleted", async () => {
    mockDb.modelMappings = [
      ...defaultModelMappings(),
      { key: "extra-model", value: "claude-opus-5" },
      { key: "other-model", value: "claude-haiku-4.5" },
    ];
    const { user } = renderWithProviders(<ModelMappingsCard />);
    const filter = await screen.findByRole("searchbox", { name: "Filter mappings" });

    // The next row on screen, not the hidden one after it in the full list.
    await user.type(filter, "opus");
    await user.click(screen.getByRole("button", { name: "Mapping 4 actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete mapping" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Mapping 6 actions" })).toHaveFocus(),
    );

    // No row left on screen: the filter field.
    await user.clear(filter);
    await user.type(filter, "extra");
    await user.click(screen.getByRole("button", { name: "Mapping 9 actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete mapping" }));
    await waitFor(() => expect(filter).toHaveFocus());
  });
});
