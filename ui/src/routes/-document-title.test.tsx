import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render";

// Each page names itself in document.title, in the UI language.
describe("document title", () => {
  it("names the signed-in page", async () => {
    await renderApp("/accounts");
    await waitFor(() => expect(document.title).toBe("Accounts · Kiro Proxy"));
  });

  it("follows the UI language", async () => {
    await renderApp("/backups", { lang: "zh" });
    await waitFor(() => expect(document.title).toBe("备份 · Kiro Proxy"));
  });

  it("names the first-run page", async () => {
    // Mock mode has a pending first run, so signed-out visits land on /setup.
    await renderApp("/login", { authed: false });
    await waitFor(() => expect(document.title).toBe("Setup · Kiro Proxy"));
  });
});
