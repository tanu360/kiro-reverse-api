import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { InlineEditRow } from "./property-list";

const LONG = "a-very-long-proxy-name.internal.example.com:8443";

function renderRow() {
  return renderWithProviders(
    <dl>
      <InlineEditRow
        editing={false}
        label="Proxy"
        onCancel={() => {}}
        onEdit={() => {}}
        onSubmit={() => {}}
        saving={false}
        value={LONG}
      >
        <input />
      </InlineEditRow>
    </dl>,
  );
}

describe("InlineEditRow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a cut-off value whole in a tooltip over the row's edit button", async () => {
    // jsdom has no layout: the value reads as cut.
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.textContent === LONG && this.classList.contains("truncate") ? 400 : 0;
    });
    const { user } = renderRow();
    await user.hover(screen.getByRole("button", { name: "Edit Proxy" }));
    // The value itself, plus the tooltip's copy of it.
    await vi.waitFor(() => expect(screen.getAllByText(LONG)).toHaveLength(2));
  });

  it("shows no tooltip when the value fits", async () => {
    const { user } = renderRow();
    await user.hover(screen.getByRole("button", { name: "Edit Proxy" }));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(screen.getAllByText(LONG)).toHaveLength(1);
  });
});
