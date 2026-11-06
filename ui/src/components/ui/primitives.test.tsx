import { screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { AlertDialog, AlertDialogPopup, AlertDialogTitle } from "./alert-dialog";
import { Autocomplete, AutocompleteInput } from "./autocomplete";
import { Button } from "./button";
import { Dialog, DialogPopup, DialogTitle } from "./dialog";
import { Drawer, DrawerPopup, DrawerTitle } from "./drawer";
import { Input } from "./input";
import { NumberField, NumberFieldDecrement, NumberFieldGroup, NumberFieldIncrement, NumberFieldInput } from "./number-field";
import { SegmentedControl, SegmentedControlItem } from "./segmented-control";
import { Select, SelectTrigger, SelectValue } from "./select";
import { Sheet, SheetPopup, SheetTitle } from "./sheet";
import { Switch } from "./switch";
import { Tabs, TabsList, TabsPanel, TabsTab } from "./tabs";

// jsdom has no layout, so touch targets and contrast are asserted through the classes that
// produce them; the browser checks live in the QA report.

describe("Tabs", () => {
  function renderTabs() {
    return renderWithProviders(
      <Tabs defaultValue="errors">
        <TabsList aria-label="Recent activity">
          <TabsTab value="errors">Recent errors</TabsTab>
          <TabsTab value="requests">Recent requests</TabsTab>
        </TabsList>
        <TabsPanel value="errors">
          <p>Errors</p>
        </TabsPanel>
      </Tabs>,
    );
  }

  it("renders inactive tabs in full-strength muted text (no /72 tint)", () => {
    renderTabs();
    const list = screen.getByRole("tablist");
    expect(list.className).toContain("text-muted-foreground");
    expect(list.className).not.toContain("text-muted-foreground/72");
  });

  it("makes the default tab strip 40 px tall on touch screens (36 px tabs in the track)", () => {
    renderTabs();
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className).toContain("pointer-coarse:h-9");
    }
  });

  it("shows a focus outline on the tab panel, which is a tab stop", async () => {
    const { user } = renderTabs();
    screen.getByRole("tab", { name: "Recent errors" }).focus();
    await user.tab();
    const panel = screen.getByRole("tabpanel");
    expect(document.activeElement).toBe(panel);
    expect(panel.className).toContain("focus-outline");
  });
});

describe("SegmentedControl", () => {
  it("uses full-strength muted text and a 40 px track on touch screens", () => {
    renderWithProviders(
      <SegmentedControl>
        <SegmentedControlItem aria-pressed>All</SegmentedControlItem>
        <SegmentedControlItem>Failed</SegmentedControlItem>
      </SegmentedControl>,
    );
    const item = screen.getByRole("button", { name: "Failed" });
    expect(item.className).not.toContain("text-muted-foreground/72");
    expect(item.className).toContain("pointer-coarse:h-9");
  });
});

describe("Switch", () => {
  it("has a 44 px touch hit area and dims to 64 % when disabled", () => {
    renderWithProviders(<Switch aria-label="Allow overage" />);
    const control = screen.getByRole("switch", { name: "Allow overage" });
    expect(control.className).toContain("touch-hit");
    expect(control.className).toContain("data-disabled:opacity-64");
  });
});

describe("Input", () => {
  it("is 40 px tall on touch screens at every size, border included", () => {
    renderWithProviders(
      <>
        <Input aria-label="Search" />
        <Input aria-label="Rule" size="sm" />
      </>,
    );
    for (const name of ["Search", "Rule"]) {
      expect(screen.getByRole("textbox", { name }).className).toContain("pointer-coarse:h-9.5");
    }
  });
});

describe("Button", () => {
  it("keeps focus while loading, is busy, and ignores further clicks", async () => {
    const onSave = vi.fn();
    function SaveButton() {
      const [saving, setSaving] = useState(false);
      return (
        <Button
          loading={saving}
          onClick={() => {
            onSave();
            setSaving(true);
          }}
        >
          Save
        </Button>
      );
    }
    const { user } = renderWithProviders(<SaveButton />);
    const button = screen.getByRole("button", { name: "Save" });
    await user.click(button);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(document.activeElement).toBe(button);
    // The label stays beside the spinner.
    expect(button).toHaveTextContent("Save");
    await user.keyboard("{Enter}");
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(button);
  });

  it("shows loadingText in place of the label while loading", () => {
    renderWithProviders(
      <Button loading loadingText="Saving…">
        Save
      </Button>,
    );
    expect(screen.getByRole("button", { name: "Saving…" })).toBeInTheDocument();
  });
});

describe("SelectTrigger", () => {
  it("is a full-width field by default and as wide as its value with fit=content", () => {
    renderWithProviders(
      <>
        <Select defaultValue="25" items={{ "25": "25 / page" }}>
          <SelectTrigger aria-label="Rows" fit="content">
            <SelectValue />
          </SelectTrigger>
        </Select>
        <Select defaultValue="all" items={{ all: "All" }}>
          <SelectTrigger aria-label="Status">
            <SelectValue />
          </SelectTrigger>
        </Select>
      </>,
    );
    const rows = screen.getByRole("combobox", { name: "Rows" });
    expect(rows.className).toContain("w-fit");
    expect(rows.className.split(" ")).not.toContain("w-full");
    expect(rows.className).not.toContain("min-w-36");
    const status = screen.getByRole("combobox", { name: "Status" });
    expect(status.className.split(" ")).toContain("w-full");
  });
});

describe("AutocompleteInput", () => {
  it("names the icon-only trigger and clear buttons", () => {
    renderWithProviders(
      <Autocomplete items={["claude-sonnet-4.6"]}>
        <AutocompleteInput aria-label="Test model" showTrigger />
      </Autocomplete>,
    );
    expect(screen.getByRole("button", { name: "Show options" })).toBeInTheDocument();
  });

  it("translates the trigger name and lets the caller override it", () => {
    renderWithProviders(
      <>
        <Autocomplete items={["a"]}>
          <AutocompleteInput aria-label="模型" showTrigger />
        </Autocomplete>
        <Autocomplete items={["b"]}>
          <AutocompleteInput
            aria-label="Other"
            showTrigger
            triggerProps={{ "aria-label": "Show models" }}
          />
        </Autocomplete>
      </>,
      { lang: "zh" },
    );
    expect(screen.getByRole("button", { name: "显示选项" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show models" })).toBeInTheDocument();
  });
});

describe("NumberField", () => {
  it("labels the steppers in the UI language", () => {
    renderWithProviders(
      <NumberField aria-label="Weight" defaultValue={1}>
        <NumberFieldGroup>
          <NumberFieldDecrement />
          <NumberFieldInput aria-label="Weight" />
          <NumberFieldIncrement />
        </NumberFieldGroup>
      </NumberField>,
      { lang: "zh" },
    );
    expect(screen.getByRole("button", { name: "减少" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "增加" })).toBeInTheDocument();
  });
});

describe("Modal surfaces on phones", () => {
  function slot(name: string): string {
    const element = document.querySelector(`[data-slot="${name}"]`);
    expect(element).not.toBeNull();
    return element?.className ?? "";
  }

  it("float dialogs and alert dialogs centred, 5vw and 5dvh clear of the edges", () => {
    renderWithProviders(
      <>
        <Dialog open>
          <DialogPopup>
            <DialogTitle>Edit</DialogTitle>
          </DialogPopup>
        </Dialog>
        <AlertDialog open>
          <AlertDialogPopup>
            <AlertDialogTitle>Delete?</AlertDialogTitle>
          </AlertDialogPopup>
        </AlertDialog>
      </>,
    );
    for (const name of ["dialog", "alert-dialog"]) {
      const viewport = slot(`${name}-viewport`);
      expect(viewport).toContain("grid-rows-[1fr_auto_1fr]");
      expect(viewport).toContain("max-sm:px-(--modal-gap-x)");
      expect(viewport).toContain("max-sm:py-(--modal-gap-y)");
      const popup = slot(`${name}-popup`);
      expect(popup).toContain("rounded-2xl");
      expect(popup).not.toContain("max-sm:max-w-none");
      expect(popup).not.toContain("max-sm:rounded-b-none");
    }
  });

  it("makes a side sheet an inset panel with four rounded corners", () => {
    renderWithProviders(
      <Sheet open>
        <SheetPopup side="left">
          <SheetTitle>Navigation</SheetTitle>
        </SheetPopup>
      </Sheet>,
    );
    expect(slot("sheet-viewport")).toContain("max-sm:py-(--modal-gap-y)");
    const popup = slot("sheet-popup");
    expect(popup).toContain("max-sm:rounded-2xl");
    expect(popup).toContain("max-sm:border");
  });

  it("keeps the bottom drawer as far above the screen edge as it is from the sides", () => {
    renderWithProviders(
      <Drawer open>
        <DrawerPopup>
          <DrawerTitle>Add account</DrawerTitle>
        </DrawerPopup>
      </Drawer>,
    );
    const viewport = slot("drawer-viewport");
    expect(viewport).toContain("max-sm:[--inset:var(--modal-gap-x)]");
    expect(viewport).toContain("max-sm:px-(--inset)");
    expect(viewport).toContain("max-sm:pb-[calc(var(--inset)+env(safe-area-inset-bottom,0px))]");
    const popup = slot("drawer-popup");
    expect(popup).toContain("max-sm:rounded-2xl");
    expect(popup).toContain("max-sm:after:hidden");
  });
});
