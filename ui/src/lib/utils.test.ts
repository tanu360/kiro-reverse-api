import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("lets the later Tailwind class win a conflict", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("drops falsy inputs", () => {
    const enabled = false;
    expect(cn("a", enabled && "b")).toBe("a");
  });

  it("keeps a custom text size next to a text colour", () => {
    expect(cn("font-semibold text-display leading-none", "text-destructive-foreground")).toBe(
      "font-semibold text-display leading-none text-destructive-foreground",
    );
    expect(cn("text-muted-foreground", "font-normal text-meta")).toBe(
      "text-muted-foreground font-normal text-meta",
    );
    expect(cn("text-heading", "text-foreground")).toBe("text-heading text-foreground");
  });

  it("lets a later custom text size replace an earlier one", () => {
    expect(cn("text-sm", "text-kpi")).toBe("text-kpi");
    expect(cn("text-lg", "text-subtitle")).toBe("text-subtitle");
    expect(cn("text-2xs", "text-meta")).toBe("text-meta");
  });
});
