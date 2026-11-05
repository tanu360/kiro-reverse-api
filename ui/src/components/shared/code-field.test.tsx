import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { CopyField } from "./code-field";

describe("CopyField", () => {
  it("shows a multiline value as a named read-only textbox that breaks after each slash", () => {
    const url = "https://proxy.example.com/v1/chat/completions";
    renderWithProviders(<CopyField label="Endpoint" multiline value={url} />);
    const box = screen.getByRole("textbox", { name: "Endpoint" });
    expect(box).toHaveAttribute("aria-readonly", "true");
    expect(box).toHaveAttribute("tabindex", "0");
    // The <wbr> elements add no text, so the value reads (and copies) unchanged.
    expect(box.textContent).toBe(url);
    expect(box.querySelectorAll("wbr")).toHaveLength(5);
  });

  it("breaks a key at any character, so no fragment sits alone on the first line", () => {
    renderWithProviders(<CopyField label="Key" multiline value="sk-0123456789abcdef" />);
    const box = screen.getByRole("textbox", { name: "Key" });
    expect(box).toHaveClass("break-all");
    expect(box).not.toHaveClass("wrap-anywhere");
  });
});
