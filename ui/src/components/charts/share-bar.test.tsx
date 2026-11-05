import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ShareBar } from "./share-bar";

const fill = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-slot=share-bar] > span");

describe("ShareBar", () => {
  it("draws value / max and clamps to the track", () => {
    const { container, rerender } = render(
      <ShareBar color="var(--chart-1)" max={200} value={50} />
    );
    expect(fill(container)?.style.width).toBe("25%");
    expect(fill(container)?.style.backgroundColor).toBe("var(--chart-1)");

    rerender(<ShareBar color="var(--chart-1)" value={1.4} />);
    expect(fill(container)?.style.width).toBe("100%");

    rerender(<ShareBar color="var(--chart-1)" max={0} value={3} />);
    expect(fill(container)?.style.width).toBe("0%");
  });

  it("is decorative", () => {
    const { container } = render(<ShareBar color="red" value={0.5} />);
    expect(
      container.querySelector("[data-slot=share-bar]")
    ).toHaveAttribute("aria-hidden");
  });
});
