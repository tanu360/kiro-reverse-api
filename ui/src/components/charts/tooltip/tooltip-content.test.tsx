import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipContent, TooltipHeader } from "./tooltip-content";

describe("TooltipHeader", () => {
  it("puts a muted meta after a mono title", () => {
    const { getByText } = render(
      <TooltipHeader meta="2 min" mono>
        14:02–14:04
      </TooltipHeader>,
    );
    expect(getByText("14:02–14:04")).toHaveClass("font-mono");
    expect(getByText("2 min")).toHaveClass("text-meta", "truncate");
  });

  it("renders a plain title as before", () => {
    const { container } = render(<TooltipHeader>Today</TooltipHeader>);
    expect(container.firstElementChild?.textContent).toBe("Today");
    expect(container.querySelector("span")).toBeNull();
  });

  it("passes title, meta and mono through TooltipContent", () => {
    const { getByText } = render(
      <TooltipContent
        meta="acc-1"
        mono
        rows={[{ color: "red", label: "Errors", value: 3 }]}
        title="09:15"
      />,
    );
    expect(getByText("09:15")).toHaveClass("font-mono");
    expect(getByText("acc-1")).toBeInTheDocument();
    expect(getByText("Errors")).toBeInTheDocument();
  });
});
