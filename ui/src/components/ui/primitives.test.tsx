import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { Autocomplete, AutocompleteInput } from "./autocomplete";
import { Input } from "./input";
import { NumberField, NumberFieldDecrement, NumberFieldGroup, NumberFieldIncrement, NumberFieldInput } from "./number-field";
import { SegmentedControl, SegmentedControlItem } from "./segmented-control";
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

  it("makes each tab 40 px tall on touch screens", () => {
    renderTabs();
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className).toContain("pointer-coarse:h-10");
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
  it("uses full-strength muted text and 40 px tall items on touch screens", () => {
    renderWithProviders(
      <SegmentedControl>
        <SegmentedControlItem aria-pressed>All</SegmentedControlItem>
        <SegmentedControlItem>Failed</SegmentedControlItem>
      </SegmentedControl>,
    );
    const item = screen.getByRole("button", { name: "Failed" });
    expect(item.className).not.toContain("text-muted-foreground/72");
    expect(item.className).toContain("pointer-coarse:h-10");
  });
});

describe("Switch", () => {
  it("draws the off track with a contrasting edge and has a 44 px touch hit area", () => {
    renderWithProviders(<Switch aria-label="Allow overage" />);
    const control = screen.getByRole("switch", { name: "Allow overage" });
    expect(control.className).toContain("data-unchecked:inset-ring-switch-border");
    expect(control.className).toContain("pointer-coarse:after:size-11");
  });
});

describe("Input", () => {
  it("is 40 px tall on touch screens at every size", () => {
    renderWithProviders(
      <>
        <Input aria-label="Search" />
        <Input aria-label="Rule" size="sm" />
      </>,
    );
    for (const name of ["Search", "Rule"]) {
      expect(screen.getByRole("textbox", { name }).className).toContain("pointer-coarse:h-10");
    }
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
