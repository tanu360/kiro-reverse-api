import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "@/lib/clipboard";
import { saveJson } from "@/lib/download";
import { mockDb } from "@/lib/mocks/db";
import { renderWithProviders } from "@/test/render";
import { ExportDialog } from "./export-dialog";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));
vi.mock("@/lib/download", () => ({ saveJson: vi.fn() }));

afterEach(() => {
  vi.mocked(copyText).mockClear();
  vi.mocked(saveJson).mockClear();
});

async function openExport() {
  const view = renderWithProviders(
    <ExportDialog accounts={mockDb.accounts} onOpenChange={() => {}} open />,
  );
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText(`${mockDb.accounts.length} selected`);
  return { ...view, dialog };
}

describe("ExportDialog", () => {
  it("warns and copies nothing when no account is selected", async () => {
    const { dialog, user } = await openExport();
    await user.click(within(dialog).getByRole("button", { name: "Deselect all" }));
    expect(within(dialog).getByText("0 selected")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Copy JSON" }));
    expect(await screen.findByText("Select at least one account.")).toBeInTheDocument();
    expect(copyText).not.toHaveBeenCalled();
  });

  it("copies only the API key, region and auth method for an api_key account", async () => {
    const apiKeyAccount = mockDb.accounts.find((a) => a.authMethod === "api_key");
    if (!apiKeyAccount) throw new Error("fixture missing");
    const { dialog, user } = await openExport();
    await user.click(within(dialog).getByRole("button", { name: "Deselect all" }));
    await user.click(within(dialog).getByRole("checkbox", { name: /^api-key-/ }));
    await user.click(within(dialog).getByRole("button", { name: "Copy JSON" }));

    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(1));
    const text = await vi.mocked(copyText).mock.calls[0][0];
    expect(JSON.parse(text)).toEqual([
      {
        kiroApiKey: mockDb.secrets[apiKeyAccount.id].accessToken,
        region: "us-east-1",
        authMethod: "api_key",
      },
    ]);
    expect(await screen.findByText("Credentials copied")).toBeInTheDocument();
  });

  it("downloads the full export as kiro-accounts-<date>.json", async () => {
    const { dialog, user } = await openExport();
    await user.click(within(dialog).getByRole("button", { name: "Download JSON" }));
    await waitFor(() => expect(saveJson).toHaveBeenCalledTimes(1));
    const [data, filename] = vi.mocked(saveJson).mock.calls[0];
    expect(filename).toMatch(/^kiro-accounts-\d{4}-\d{2}-\d{2}\.json$/);
    expect((data as { accounts: unknown[] }).accounts).toHaveLength(mockDb.accounts.length);
  });

  it("focuses the JSON once Show JSON renders it, so it is in view on phones", async () => {
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    const { dialog, user } = await openExport();
    await user.click(within(dialog).getByRole("button", { name: "Show JSON" }));
    const json = await within(dialog).findByRole("textbox", { name: "Export JSON" });
    await waitFor(() => expect(json).toHaveFocus());
    expect(scrolled.mock.contexts).toContain(json);
    scrolled.mockRestore();
  });
});
