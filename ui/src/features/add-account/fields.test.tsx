import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { UrlBox } from "./fields";

describe("UrlBox", () => {
  const url = "https://oidc.us-east-1.amazonaws.com/authorize?client_id=mock&state=abc";

  it("shows the URL with an open icon link, then a copy icon button", () => {
    renderWithProviders(<UrlBox label="Login URL" url={url} />);
    expect(screen.getByText("Login URL")).toBeInTheDocument();
    expect(screen.getByText(url)).toBeInTheDocument();

    const open = screen.getByRole("link", { name: "Open link" });
    expect(open).toHaveAttribute("href", url);
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
    // Icon-only: the name comes from aria-label, with no visible text beside the icon.
    expect(open).toHaveTextContent("");

    const copy = screen.getByRole("button", { name: "Copy link" });
    expect(open.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // One look for both: the same Button size and variant.
    expect(open.className).toBe(copy.className);
    expect(open.parentElement).toBe(copy.parentElement);
  });

  it("names the open link in the reader's language", () => {
    renderWithProviders(<UrlBox label="登录链接" url={url} />, { lang: "zh" });
    expect(screen.getByRole("link", { name: "打开链接" })).toHaveAttribute("href", url);
    expect(screen.getByRole("button", { name: "复制链接" })).toBeInTheDocument();
  });
});
