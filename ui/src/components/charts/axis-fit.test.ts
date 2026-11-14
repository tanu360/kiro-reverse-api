import { describe, expect, it } from "vitest";
import { dateLabelCount, rightAxisMargin } from "./axis-fit";

describe("rightAxisMargin", () => {
  it("keeps the chart's margin below 1,000 and for short compact labels", () => {
    expect(rightAxisMargin(0, 36, "en")).toBe(36);
    expect(rightAxisMargin(790, 36, "pt-BR")).toBe(36);
    // 967 requests draw a 1,000 tick: "1 mil" needs more room than the 36 px.
    expect(rightAxisMargin(967, 36, "pt-BR")).toBeGreaterThan(36);
    // "1.3K" fits the 36 px margin.
    expect(rightAxisMargin(1000, 36, "en")).toBe(38);
  });

  it("widens for languages that spell compact numbers longer", () => {
    // pt-BR prints 1,250 as "1,3 mil" and 4.1 million as "5,1 mi".
    expect(rightAxisMargin(1000, 36, "pt-BR")).toBeGreaterThan(rightAxisMargin(1000, 36, "en"));
    expect(rightAxisMargin(1000, 36, "pt-BR")).toBe(Math.ceil(7 * 6.8) + 10);
    expect(rightAxisMargin(4_100_000, 36, "pt-BR")).toBe(Math.ceil(6 * 6.8) + 10);
  });
});

describe("dateLabelCount", () => {
  it("prints two labels on a phone when a date runs long", () => {
    expect(dateLabelCount(["Sep 29", "Oct 15"])).toEqual({ base: 3, sm: 4, md: 6 });
    expect(dateLabelCount(["29 de set.", "15 de out."])).toEqual({ base: 2, sm: 4, md: 6 });
  });
});
