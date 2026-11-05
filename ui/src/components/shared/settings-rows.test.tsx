import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import { renderWithProviders } from "@/test/render";
import { SettingsRow } from "./settings-rows";

describe("SettingsRow", () => {
  it("names a field control by the row title and describes it by the row description", () => {
    renderWithProviders(
      <SettingsRow control={<input />} description="Where requests go" title="Upstream" />,
    );
    const input = screen.getByRole("textbox", { name: "Upstream" });
    expect(input).toHaveAccessibleDescription("Where requests go");
  });

  it("lets a button keep its own label, still described by the row", () => {
    renderWithProviders(
      <SettingsRow
        control={<Button>Add rule</Button>}
        controlWidth="auto"
        description="Send a model to another one"
        title="Model mapping"
      />,
    );
    const button = screen.getByRole("button", { name: "Add rule" });
    expect(button).toHaveAccessibleDescription("Send a model to another one");
  });

  it("names any control by the title when labelControl is set", () => {
    renderWithProviders(
      <SettingsRow control={<Button>Reset</Button>} labelControl title="Statistics" />,
    );
    expect(screen.getByRole("button", { name: "Statistics" })).toBeInTheDocument();
  });
});
