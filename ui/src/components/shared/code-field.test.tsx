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

  it("breaks a command only between its words, never inside one", () => {
    const command = "git pull && docker compose up -d --build";
    renderWithProviders(<CopyField label="Command" multiline value={command} />);
    const box = screen.getByRole("textbox", { name: "Command" });
    expect(box.textContent).toBe(command);
    expect(box).not.toHaveClass("break-all");
    expect(box).not.toHaveClass("wrap-anywhere");
    // Each word is one unbreakable run; a word too long for the line scrolls sideways.
    const runs = [...box.querySelectorAll("span.whitespace-nowrap")].map((run) => run.textContent);
    expect(runs).toEqual(["git", "pull", "&&", "docker", "compose", "up", "-d", "--build"]);
    expect(box).toHaveClass("overflow-x-auto");
  });

  it("lets a path inside a command break after its slashes, not at a hyphen", () => {
    const command = "docker pull ghcr.io/tanu360/kiro-reverse-api:latest";
    renderWithProviders(<CopyField label="Command" multiline value={command} />);
    const box = screen.getByRole("textbox", { name: "Command" });
    expect(box.textContent).toBe(command);
    const runs = [...box.querySelectorAll("span.whitespace-nowrap")].map((run) => run.textContent);
    expect(runs).toEqual(["docker", "pull", "ghcr.io/", "tanu360/", "kiro-reverse-api:latest"]);
    expect(box.querySelectorAll("wbr")).toHaveLength(2);
  });

  it("puts the open link before the copy button, opening the address in a new tab", () => {
    const url = "https://proxy.example.com/v1";
    renderWithProviders(
      <CopyField label="Endpoint" openHref={url} openLabel="Open endpoint" value={url} />,
    );
    expect(screen.getByRole("textbox", { name: "Endpoint" })).toHaveValue(url);
    const open = screen.getByRole("link", { name: "Open endpoint" });
    expect(open).toHaveAttribute("href", url);
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
    const copy = screen.getByRole("button", { name: "Copy" });
    expect(open.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("has no open link without an address", () => {
    renderWithProviders(<CopyField label="Key" value="sk-123" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
