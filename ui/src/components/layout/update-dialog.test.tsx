import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { UpdateDialog } from "./update-dialog";
import { GITHUB_URL } from "./user-menu";

function renderDialog(download?: string) {
  return renderWithProviders(
    <UpdateDialog
      current="2.1.0"
      latest={{ version: "2.2.0", changelog: "🔑 New keys", download }}
      onOpenChange={() => {}}
      open
    />,
  );
}

describe("UpdateDialog", () => {
  it("shows how to update, since the repo publishes no GitHub releases", async () => {
    renderDialog("https://github.com/tanu360/kiro-reverse-api");
    expect(await screen.findByRole("heading", { name: "How to update" })).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Docker Compose, in your clone of the repository" }),
    ).toHaveTextContent("git pull && docker compose up -d --build");
    expect(screen.getByRole("textbox", { name: /^Docker image/ })).toHaveTextContent(
      "docker pull ghcr.io/tanu360/kiro-reverse-api:latest",
    );
    expect(screen.getByRole("link", { name: "Open on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/tanu360/kiro-reverse-api",
    );
  });

  it("opens the repository when the remote file has no https link", async () => {
    renderDialog("javascript:alert(1)");
    expect(await screen.findByRole("link", { name: "Open on GitHub" })).toHaveAttribute(
      "href",
      GITHUB_URL,
    );
  });
});
