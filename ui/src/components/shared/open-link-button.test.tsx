import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { CopyButton } from "./copy-button";
import { OpenLinkButton } from "./open-link-button";

describe("OpenLinkButton", () => {
  it("is a named link that opens the address in a new tab", () => {
    renderWithProviders(<OpenLinkButton href="https://example.com/a" label="Open link" />);
    const link = screen.getByRole("link", { name: "Open link" });
    expect(link).toHaveAttribute("href", "https://example.com/a");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("takes the same classes as a CopyButton of the same size and variant", () => {
    renderWithProviders(
      <>
        <OpenLinkButton href="https://x" label="Open link" size="icon-sm" variant="quiet" />
        <CopyButton label="Copy link" size="icon-sm" value="https://x" variant="quiet" />
      </>,
    );
    const open = screen.getByRole("link", { name: "Open link" });
    const copy = screen.getByRole("button", { name: "Copy link" });
    expect(open).toHaveClass("size-8");
    expect(open.className).toBe(copy.className);
  });
});
