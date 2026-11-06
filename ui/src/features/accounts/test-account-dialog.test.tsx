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

/** A code well (the reply or the error) by its caption. */
function well(dialog: HTMLElement, caption: string): HTMLElement {
  const figure = within(dialog).getByText(caption, { selector: "figcaption" }).closest("figure");
  if (!figure) throw new Error(`no ${caption} well`);
  return figure;
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
    expect(ok).toHaveTextContent(/da\*\*\*@no\*\*\*\.com OK \(\d+\.\d s\) Reply: ok/);
    expect(ok).toHaveAttribute("data-type", "ok");
    expect(details).toHaveTextContent("stop reason none | in/out 13/2");
    expect(warn).toHaveAttribute("data-type", "warn");
    expect(warn).toHaveTextContent("The stream carried no stop reason.");
    // The result panel repeats the warning next to the "none" stop reason.
    const result = within(dialog)
      .getByRole("heading", { name: "Result" })
      .closest("[data-slot=card]");
    expect(within(result as HTMLElement).getByText("none")).toBeInTheDocument();
    expect(within(result as HTMLElement).getByRole("alert")).toHaveTextContent(
      "The stream carried no stop reason.",
    );
  });

  it("shows the latest run as a result: status, time, reply and token counts", async () => {
    const { dialog, user } = await openDialog(accountBy((a) => a.email.startsWith("dana.")));
    expect(within(dialog).getByText("No test run yet")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Test" }));

    expect(await within(dialog).findByText("Succeeded")).toBeInTheDocument();
    expect(within(dialog).queryByText("No test run yet")).not.toBeInTheDocument();
    expect(within(dialog).getByText(/^\d+\.\d s$/)).toBeInTheDocument();
    const reply = well(dialog, "Reply");
    expect(reply).toHaveTextContent("ok");
    expect(within(reply).getByRole("button", { name: "Copy reply" })).toBeInTheDocument();
    const figures = (label: string) =>
      within(dialog).getByText(label, { selector: "dt" }).nextElementSibling;
    expect(figures("Stop reason")).toHaveTextContent("end_turn");
    expect(figures("Tokens in / out")).toHaveTextContent("13 / 2");
    expect(figures("Context")).toHaveTextContent("0.0%");
  });

  it("shows a failed run with its error", async () => {
    const { dialog, user } = await openDialog(accountBy((a) => a.banStatus === "BANNED"));
    await user.click(within(dialog).getByRole("button", { name: "Test" }));
    expect(await within(dialog).findByText("Failed")).toBeInTheDocument();
    expect(well(dialog, "Error")).toHaveTextContent(/AccessDenied/);
  });

  it("logs a failure line for a failing account", async () => {
    const { dialog, user } = await openDialog(accountBy((a) => a.banStatus === "BANNED"));
    await user.click(within(dialog).getByRole("button", { name: "Test" }));
    await waitFor(() => expect(logLines(dialog)).toHaveLength(2));
    const failure = logLines(dialog)[1];
    expect(failure).toHaveAttribute("data-type", "err");
    expect(failure).toHaveTextContent(/jl\*\*\*@pr\*\*\*\.com Failed \(\d+\.\d s\): AccessDenied/);
  });

  it(`keeps at most ${MAX_LOG_LINES} log lines`, async () => {
    const { dialog, user } = await openDialog(accountBy((a) => a.email.startsWith("dana.")));
    const run = within(dialog).getByRole("button", { name: "Test" });
    // Three lines per successful run: 34 runs write 102 lines.
    for (let i = 0; i < 34; i++) {
      await user.click(run);
      // The button stays focusable while it runs (loading), so wait for the busy state to end.
      await waitFor(() => expect(run).not.toHaveAttribute("aria-busy"));
    }
    await waitFor(() => expect(logLines(dialog)).toHaveLength(MAX_LOG_LINES));
    // The oldest lines are dropped: the log now starts with a details line of run 1.
    expect(logLines(dialog)[0]).toHaveTextContent("stop reason end_turn");
  });

  it("names the button that opens the model list", async () => {
    const { dialog } = await openDialog(accountBy((a) => a.email.startsWith("dana.")));
    expect(within(dialog).getByRole("button", { name: "Show models" })).toBeInTheDocument();
  });

  it("lists every cached model while the field holds a whole model id", async () => {
    const { dialog, user } = await openDialog(accountBy((a) => a.email.startsWith("dana.")));
    expect(within(dialog).getByRole("combobox", { name: "Test model" })).toHaveValue(
      "claude-sonnet-4.6",
    );
    await user.click(within(dialog).getByRole("button", { name: "Show models" }));
    expect(await screen.findAllByRole("option")).toHaveLength(6);
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
