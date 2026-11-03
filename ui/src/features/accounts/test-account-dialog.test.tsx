import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import type { Account } from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
import { makeTestResult } from "@/lib/mocks/fixtures";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { MAX_LOG_LINES, TestAccountDialog } from "./test-account-dialog";

function accountBy(predicate: (account: Account) => boolean): Account {
  const account = mockDb.accounts.find(predicate);
  if (!account) throw new Error("fixture missing");
  return account;
}

async function openDialog(account: Account) {
  const view = renderWithProviders(
    <TestAccountDialog account={account} onOpenChange={() => {}} open />,
  );
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("6 models cached");
  return { ...view, dialog };
}

function logLines(dialog: HTMLElement): HTMLElement[] {
  return within(within(dialog).getByRole("log")).getAllByRole("listitem");
}

describe("TestAccountDialog", () => {
  it("loads the cached models into the model field", async () => {
    const { dialog, user } = await openDialog(accountBy((a) => a.email.startsWith("dana.")));
    const input = within(dialog).getByRole("combobox", { name: "Test model" });
    expect(input).toHaveValue("claude-sonnet-4.6");
    await user.clear(input);
    await user.type(input, "claude-opus");
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "claude-opus-4.6",
      "claude-opus-5",
    ]);
  });

  it("logs the start, the reply and a warning when the stop reason is missing", async () => {
    mockServer.use(
      http.post(apiUrl("/accounts/:id/test"), async ({ request }) => {
        const { model } = (await request.json()) as { model: string };
        return HttpResponse.json({ ...makeTestResult(model), stopReason: "" });
      }),
    );
    const { dialog, user } = await openDialog(accountBy((a) => a.email.startsWith("dana.")));
    expect(within(dialog).getByText("No test run yet")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Test" }));

    await waitFor(() => expect(logLines(dialog)).toHaveLength(4));
    const [start, ok, details, warn] = logLines(dialog);
    expect(start).toHaveTextContent("da***@no***.com · claude-sonnet-4.6 · Global proxy");
    expect(ok).toHaveTextContent(/✓ da\*\*\*@no\*\*\*\.com OK \(\d+\.\d s\) Reply: ok/);
    expect(ok).toHaveAttribute("data-type", "ok");
    expect(details).toHaveTextContent("stop reason none | in/out 13/2");
    expect(warn).toHaveAttribute("data-type", "warn");
    expect(warn).toHaveTextContent("The stream carried no stop reason.");
  });

  it("logs a failure line for a failing account", async () => {
    const { dialog, user } = await openDialog(accountBy((a) => a.banStatus === "BANNED"));
    await user.click(within(dialog).getByRole("button", { name: "Test" }));
    await waitFor(() => expect(logLines(dialog)).toHaveLength(2));
    const failure = logLines(dialog)[1];
    expect(failure).toHaveAttribute("data-type", "err");
    expect(failure).toHaveTextContent(
      /✗ jl\*\*\*@pr\*\*\*\.com Failed \(\d+\.\d s\): AccessDenied/,
    );
  });

  it(`keeps at most ${MAX_LOG_LINES} log lines`, async () => {
    const { dialog, user } = await openDialog(accountBy((a) => a.email.startsWith("dana.")));
    const run = within(dialog).getByRole("button", { name: "Test" });
    // Three lines per successful run: 34 runs write 102 lines.
    for (let i = 0; i < 34; i++) {
      await user.click(run);
      await waitFor(() => expect(run).toBeEnabled());
    }
    await waitFor(() => expect(logLines(dialog)).toHaveLength(MAX_LOG_LINES));
    // The oldest lines are dropped: the log now starts with a details line of run 1.
    expect(logLines(dialog)[0]).toHaveTextContent("stop reason end_turn");
  });

  it("names the button that opens the model list", async () => {
    const { dialog } = await openDialog(accountBy((a) => a.email.startsWith("dana.")));
    expect(within(dialog).getByRole("button", { name: "Show models" })).toBeInTheDocument();
  });

  it("keeps the model id on one line in the log", async () => {
    const { dialog, user } = await openDialog(accountBy((a) => a.email.startsWith("dana.")));
    await user.click(within(dialog).getByRole("button", { name: "Test" }));
    await waitFor(() => expect(logLines(dialog).length).toBeGreaterThan(0));
    const model = within(logLines(dialog)[0]).getByText("claude-sonnet-4.6");
    expect(model.tagName).toBe("SPAN");
    expect(model).toHaveClass("whitespace-nowrap");
  });
});
