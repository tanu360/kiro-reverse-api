import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import { renderWithProviders } from "@/test/render";
import { RowNote, SettingsRow } from "./settings-rows";

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

  it.each(["field", "auto"] as const)(
    "puts a %s row's notice after the text and the control, across the row",
    (controlWidth) => {
      renderWithProviders(
        <SettingsRow
          control={<input />}
          controlWidth={controlWidth}
          description="Where requests go"
          notice={<p>Could not save</p>}
          title="Upstream"
        >
          <p>Current value</p>
        </SettingsRow>,
      );
      const notice = screen.getByText("Could not save");
      for (const before of [screen.getByText("Current value"), screen.getByRole("textbox")]) {
        expect(
          before.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
      // A slot of its own in the row, outside the text column.
      const slot = notice.parentElement;
      expect(slot?.parentElement).toHaveAttribute("data-slot", "settings-row");
      expect(slot).not.toContainElement(screen.getByText("Current value"));
      expect(slot).toHaveClass(controlWidth === "auto" ? "col-span-full" : "basis-full");
    },
  );

  it("keeps a field level with the title and description: children go under the control", () => {
    renderWithProviders(
      <SettingsRow control={<input />} description="Where requests go" title="Upstream">
        <p>Current value</p>
      </SettingsRow>,
    );
    const value = screen.getByText("Current value");
    expect(
      screen.getByRole("textbox").compareDocumentPosition(value) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("Where requests go").parentElement).not.toContainElement(value);
  });

  it.each(["field", "auto"] as const)(
    "puts a %s row's notes last, as strips out to the card's edges",
    (controlWidth) => {
      renderWithProviders(
        <SettingsRow
          control={<input />}
          controlWidth={controlWidth}
          description="Where requests go"
          notes={<RowNote tone="warning">Debug writes prompts to the log</RowNote>}
          notice={<p>Could not save</p>}
          title="Upstream"
        />,
      );
      const note = screen.getByRole("note");
      expect(note).toHaveAttribute("data-slot", "row-note");
      expect(note).toHaveTextContent("Debug writes prompts to the log");
      for (const before of [screen.getByText("Could not save"), screen.getByRole("textbox")]) {
        expect(
          before.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
      const strip = note.parentElement;
      expect(strip?.parentElement).toHaveAttribute("data-slot", "settings-row");
      expect(strip).toHaveClass("-mx-4");
    },
  );
});
