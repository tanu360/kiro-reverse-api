import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { Bar } from "./bar";
import { BarChart } from "./bar-chart";
import { BarXAxis } from "./bar-x-axis";
import { ChartTooltip } from "./tooltip/chart-tooltip";

// jsdom has no layout: the chart gets a fixed 400 x 200 box.
vi.mock("./chart-parent-size", () => ({
  ParentSize: ({
    children,
  }: {
    children: (size: { width: number; height: number }) => ReactNode;
  }) => children({ width: 400, height: 200 }),
}));

describe("BarChart", () => {
  it("draws bars that share a label in bands of their own, labelled plainly", async () => {
    // The fall-back night: 01:00 comes round twice.
    const data = [
      { name: "00:00", v: 1 },
      { name: "01:00", v: 2 },
      { name: "01:00", v: 3 },
      { name: "02:00", v: 4 },
    ];
    const { container } = render(
      <BarChart animationDuration={0} data={data} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
        <Bar animate={false} dataKey="v" />
        <BarXAxis showAllLabels tickerHalfWidth={0} />
        <ChartTooltip showDatePill={false} />
      </BarChart>,
    );

    // The plot's hit rect is x=0; every other rect is a bar.
    const xs = [...container.querySelectorAll("svg g rect")]
      .map((rect) => Number(rect.getAttribute("x")))
      .filter((x) => x > 0);
    expect(xs).toHaveLength(4);
    expect(new Set(xs).size).toBe(4);

    const axis = [...container.querySelectorAll(".chart-tick")].map((el) => el.textContent);
    expect(axis).toEqual(["00:00", "01:00", "01:00", "02:00"]);

    // Over the third bar (the second 01:00), the tooltip names the plain label and its value.
    const plot = container.querySelector("svg g rect") as SVGRectElement;
    await waitFor(() => {
      fireEvent.mouseMove(plot, { clientX: 260, clientY: 100 });
      expect(document.body.textContent?.endsWith("01:00v3")).toBe(true);
    });
  });
});
