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
});
