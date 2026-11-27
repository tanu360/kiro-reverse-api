import { PlusIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import { CompactActionsContext } from "@/components/ui/compact-actions";
import { renderWithProviders } from "@/test/render";
import { SegmentedPicker } from "./segmented-picker";

const ITEMS = [
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
] as const;

function Picker({ compact }: { compact: boolean }) {
  const [value, setValue] = useState<(typeof ITEMS)[number]["value"]>("1h");
  return (
    <CompactActionsContext.Provider value={compact}>
      <SegmentedPicker items={ITEMS} label="Range" onValueChange={setValue} value={value} />
      <Button size="sm">
        <HugeiconsIcon icon={PlusIcon} aria-hidden="true" />
        Add header
      </Button>
    </CompactActionsContext.Provider>
  );
}

describe("compact card actions", () => {
  it("shows a radio group and a labelled button while there is room", () => {
    renderWithProviders(<Picker compact={false} />);
    expect(screen.getByRole("radiogroup", { name: "Range" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "6h" })).toBeInTheDocument();
    expect(screen.getByText("Add header")).not.toHaveClass("sr-only");
  });

  it("cycles the options from one button when compact, round to the first", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Picker compact />);
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Range: 1h" }));
    await user.click(screen.getByRole("button", { name: "Range: 6h" }));
    await user.click(screen.getByRole("button", { name: "Range: 24h" }));
    // The picker keeps its label: the current option is shown, not only an icon.
    expect(screen.getByRole("button", { name: "Range: 1h" })).toHaveTextContent("1h");
  });

  it("keeps only the icon of a labelled button when compact, the label as its name", () => {
    renderWithProviders(<Picker compact />);
    const add = screen.getByRole("button", { name: "Add header" });
    expect(screen.getByText("Add header")).toHaveClass("sr-only");
    // The icon size of an sm button.
    expect(add).toHaveClass("size-7");
  });

  it("keeps a busy compact button's loading text visually hidden too", () => {
    renderWithProviders(
      <CompactActionsContext.Provider value>
        <Button loading loadingText="Creating…">
          <HugeiconsIcon icon={PlusIcon} aria-hidden="true" />
          Create backup
        </Button>
      </CompactActionsContext.Provider>,
    );
    expect(screen.getByText("Creating…")).toHaveClass("sr-only");
    expect(screen.getByRole("button", { name: "Creating…" })).toHaveClass("size-8");
  });
});
