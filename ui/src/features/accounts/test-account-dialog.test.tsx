import { screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import type { Account } from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
import { makeTestResult } from "@/lib/mocks/fixtures";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { MAX_LOG_LINES, TestAccountDialog } from "./test-account-dialog";

const CACHED = [
  "claude-haiku-4.5",
  "claude-opus-4.6",
  "claude-opus-5",
  "claude-sonnet-4.5",
  "claude-sonnet-4.6",
  "claude-sonnet-5",
];

function accountBy(predicate: (account: Account) => boolean): Account {
  const account = mockDb.accounts.find(predicate);
  if (!account) throw new Error("fixture missing");
  return account;
}

const dana = () => accountBy((a) => a.email.startsWith("dana."));
const banned = () => accountBy((a) => a.banStatus === "BANNED");

async function openDialog(account: Account) {
  const view = renderWithProviders(
    <TestAccountDialog account={account} onOpenChange={() => {}} open />,
  );
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText(/^6 models cached/);
  return { ...view, dialog };
}

/** The picked models' rows, in order. */
function rowModels(dialog: HTMLElement): (string | null)[] {
  return [...dialog.querySelectorAll("button[data-model]")].map((row) =>
    row.getAttribute("data-model"),
  );
}

/** A picked model's row: a button that opens its response and steps. */
function row(dialog: HTMLElement, model: string): HTMLElement {
  const found = dialog.querySelector<HTMLElement>(`button[data-model="${model}"]`);
  if (!found) throw new Error(`no row for ${model}`);
  return found;
}

/** Opens the model picker from the request bar and returns its popup. */
async function openPicker(dialog: HTMLElement, user: UserEvent): Promise<HTMLElement> {
  await user.click(within(dialog).getByRole("button", { name: "Models to test" }));
  const search = await screen.findByRole("combobox", { name: "Search models, or type a name" });
  const popup = search.closest<HTMLElement>("[data-slot=popover-popup]");
  if (!popup) throw new Error("no picker popup");
  return popup;
}

/** The picker's model options, in order. */
function pickerModels(picker: HTMLElement): (string | null)[] {
  return [...picker.querySelectorAll("[role=option][data-model]")].map((option) =>
    option.getAttribute("data-model"),
  );
}

/** One model's option in the picker. */
function pickerOption(picker: HTMLElement, model: string): HTMLElement {
  const found = picker.querySelector<HTMLElement>(`[role=option][data-model="${model}"]`);
  if (!found) throw new Error(`no option for ${model}`);
  return found;
}

/** The models the server was asked to test, in the order the requests arrived. */
function recordTests(): string[] {
  const models: string[] = [];
  mockServer.use(
    http.post(apiUrl("/accounts/:id/test"), async ({ request }) => {
      const { model } = (await request.json()) as { model: string };
      models.push(model);
      return HttpResponse.json(makeTestResult(model));
    }),
  );
  return models;
}

function inspector(dialog: HTMLElement): HTMLElement {
  const found = dialog.querySelector<HTMLElement>("[data-slot=test-inspector]");
  if (!found) throw new Error("no open row");
  return found;
}

function stepLines(dialog: HTMLElement): HTMLElement[] {
  return within(within(inspector(dialog)).getByRole("log")).getAllByRole("listitem");
}

describe("TestAccountDialog", () => {
  it("starts with the default model picked and no row open", async () => {
    const { dialog } = await openDialog(dana());
    expect(rowModels(dialog)).toEqual(["claude-sonnet-4.6"]);
    expect(row(dialog, "claude-sonnet-4.6")).toHaveTextContent("Not run");
    expect(within(dialog).getByRole("button", { name: "Models to test" })).toHaveTextContent(
      "claude-sonnet-4.6",
    );
    expect(within(dialog).getByRole("button", { name: "Test 1" })).toBeEnabled();
    expect(dialog.querySelector("[data-slot=test-inspector]")).toBeNull();
  });

  it("lists every cached model in the picker, and a pick adds its row", async () => {
    const { dialog, user } = await openDialog(dana());
    const picker = await openPicker(dialog, user);
    expect(pickerModels(picker)).toEqual(CACHED);
    // One maker: no maker chips, one group named after it.
    expect(within(picker).queryByRole("group", { name: "Model makers" })).not.toBeInTheDocument();
    expect(within(picker).getByRole("group", { name: "Claude" })).toBeInTheDocument();
    expect(pickerOption(picker, "claude-sonnet-4.6")).toHaveAttribute("aria-selected", "true");
    expect(pickerOption(picker, "claude-opus-5")).toHaveAttribute("aria-selected", "false");
    expect(within(picker).getByText("1 selected")).toBeInTheDocument();

    await user.click(pickerOption(picker, "claude-opus-5"));
    expect(pickerOption(picker, "claude-opus-5")).toHaveAttribute("aria-selected", "true");
    expect(rowModels(dialog)).toEqual(["claude-opus-5", "claude-sonnet-4.6"]);
    expect(within(dialog).getByRole("button", { name: "Test 2" })).toBeInTheDocument();
  });

  it("moves through the picker with the arrow keys and picks with Enter", async () => {
    const { dialog, user } = await openDialog(dana());
    const picker = await openPicker(dialog, user);
    const search = within(picker).getByRole("combobox");
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute("aria-activedescendant", pickerOption(picker, CACHED[0]).id);
    await user.keyboard("{ArrowDown}");
    expect(search).toHaveAttribute("aria-activedescendant", pickerOption(picker, CACHED[1]).id);
    await user.keyboard("{Enter}");
    expect(pickerOption(picker, CACHED[1])).toHaveAttribute("aria-selected", "true");
    expect(rowModels(dialog)).toEqual([CACHED[1], "claude-sonnet-4.6"]);
    await user.keyboard("{End}");
    expect(search).toHaveAttribute("aria-activedescendant", pickerOption(picker, CACHED[5]).id);
    await user.keyboard("{Home}");
    expect(search).toHaveAttribute("aria-activedescendant", pickerOption(picker, CACHED[0]).id);
  });

  it("keeps the keyboard in the search field after a click in the picker", async () => {
    const { dialog, user } = await openDialog(dana());
    const picker = await openPicker(dialog, user);
    const search = within(picker).getByRole("combobox");
    await user.click(pickerOption(picker, "claude-opus-5"));
    expect(search).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(search).toHaveAttribute(
      "aria-activedescendant",
      pickerOption(picker, "claude-sonnet-4.5").id,
    );
    await user.click(within(picker).getByRole("button", { name: "Clear" }));
    expect(search).toHaveFocus();
    await user.keyboard("{ArrowUp}{Enter}");
    expect(pickerOption(picker, "claude-opus-5")).toHaveAttribute("aria-selected", "true");
  });

  it("groups the models by maker, with a chip per maker", async () => {
    mockServer.use(
      http.get(apiUrl("/accounts/:id/models/cached"), () =>
        HttpResponse.json({
          success: true,
          models: ["claude-sonnet-4.6", "deepseek-3.2", "qwen3-coder-next", "mystery-1"],
        }),
      ),
    );
    const { user } = renderWithProviders(
      <TestAccountDialog account={dana()} onOpenChange={() => {}} open />,
    );
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/^4 models cached/);
    const picker = await openPicker(dialog, user);
    const groups = within(within(picker).getByRole("listbox")).getAllByRole("group");
    // Unknown names go last.
    expect([...groups].map((group) => group.getAttribute("aria-label"))).toEqual([
      "Claude",
      "DeepSeek",
      "Qwen",
      "Other",
    ]);
    const chips = within(within(picker).getByRole("group", { name: "Model makers" })).getAllByRole(
      "button",
    );
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "All4",
      "Claude1",
      "DeepSeek1",
      "Qwen1",
      "Other1",
    ]);
    await user.click(chips[2]);
    expect(chips[2]).toHaveAttribute("aria-pressed", "true");
    expect(pickerModels(picker)).toEqual(["deepseek-3.2"]);
  });

  it("filters the picker by what is typed", async () => {
    const { dialog, user } = await openDialog(dana());
    const picker = await openPicker(dialog, user);
    await user.type(within(picker).getByRole("combobox"), "opus");
    expect(pickerModels(picker)).toEqual(["claude-opus-4.6", "claude-opus-5"]);
  });

  it("tests the picked model and opens its response only when its row is tapped", async () => {
    const tested = recordTests();
    const { dialog, user } = await openDialog(dana());
    await user.click(within(dialog).getByRole("button", { name: "Test 1" }));

    await waitFor(() => expect(row(dialog, "claude-sonnet-4.6")).toHaveTextContent("Succeeded"));
    expect(tested).toEqual(["claude-sonnet-4.6"]);
    expect(row(dialog, "claude-sonnet-4.6")).toHaveTextContent(/\d+\.\ds/);
    expect(within(dialog).getByText("1 ok")).toBeInTheDocument();
    // Nothing opens on its own.
    expect(dialog.querySelector("[data-slot=test-inspector]")).toBeNull();

    await user.click(row(dialog, "claude-sonnet-4.6"));
    expect(row(dialog, "claude-sonnet-4.6")).toHaveAttribute("aria-expanded", "true");
    const panel = inspector(dialog);
    expect(within(panel).getByRole("tab", { name: "Response" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(panel).toHaveTextContent('"reply": "ok"');
    expect(panel).toHaveTextContent('"stopReason": "end_turn"');
    expect(panel).not.toHaveTextContent('"success"');
    expect(within(panel).getByRole("button", { name: "Copy response" })).toBeInTheDocument();
  });

  it("tests every picked model in one go, from the picker's own button", async () => {
    const tested = recordTests();
    const { dialog, user } = await openDialog(dana());
    const picker = await openPicker(dialog, user);
    await user.click(within(picker).getByRole("button", { name: "Select all" }));
    expect(rowModels(dialog)).toEqual(CACHED);
    await user.click(within(picker).getByRole("button", { name: "Test 6" }));
    await waitFor(() => expect(screen.queryByRole("combobox")).not.toBeInTheDocument());

    await waitFor(() => {
      for (const model of CACHED) expect(row(dialog, model)).toHaveTextContent("Succeeded");
    });
    expect([...tested].sort()).toEqual(CACHED);
    expect(within(dialog).getByText("6 ok")).toBeInTheDocument();
    expect(within(dialog).getByText("0 failed")).toBeInTheDocument();
  });

  it("clears every pick and disables the run button", async () => {
    const { dialog, user } = await openDialog(dana());
    const picker = await openPicker(dialog, user);
    await user.click(within(picker).getByRole("button", { name: "Clear" }));
    expect(rowModels(dialog)).toEqual([]);
    expect(within(dialog).getByText("Pick one or more models above.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Test 0" })).toBeDisabled();
  });

  it("shows a failed model's error under its row, and as JSON once tapped", async () => {
    const { dialog, user } = await openDialog(banned());
    await user.click(within(dialog).getByRole("button", { name: "Test 1" }));

    await waitFor(() => expect(row(dialog, "claude-sonnet-4.6")).toHaveTextContent("Failed"));
    expect(row(dialog, "claude-sonnet-4.6")).toHaveTextContent(/\d+\.\ds/);
    expect(row(dialog, "claude-sonnet-4.6")).toHaveTextContent(/AccessDeniedException/);
    expect(within(dialog).getByText("1 failed")).toBeInTheDocument();

    await user.click(row(dialog, "claude-sonnet-4.6"));
    const panel = inspector(dialog);
    expect(panel).toHaveTextContent(/"error": "AccessDenied/);
    expect(within(panel).getByRole("button", { name: "Copy error" })).toBeInTheDocument();
  });

  it("opens one row at a time, and a second tap closes it", async () => {
    const { dialog, user } = await openDialog(dana());
    const picker = await openPicker(dialog, user);
    await user.click(pickerOption(picker, "claude-opus-5"));
    await user.keyboard("{Escape}");

    await user.click(row(dialog, "claude-opus-5"));
    expect(row(dialog, "claude-opus-5")).toHaveAttribute("aria-expanded", "true");
    expect(within(inspector(dialog)).getByText("Not run yet")).toBeInTheDocument();

    await user.click(row(dialog, "claude-sonnet-4.6"));
    expect(row(dialog, "claude-opus-5")).toHaveAttribute("aria-expanded", "false");
    expect(row(dialog, "claude-sonnet-4.6")).toHaveAttribute("aria-expanded", "true");
    expect(dialog.querySelectorAll("[data-slot=test-inspector]")).toHaveLength(1);

    await user.click(row(dialog, "claude-sonnet-4.6"));
    expect(dialog.querySelector("[data-slot=test-inspector]")).toBeNull();
  });

  it("logs a model's steps, with a warning when the stop reason is missing", async () => {
    mockServer.use(
      http.post(apiUrl("/accounts/:id/test"), async ({ request }) => {
        const { model } = (await request.json()) as { model: string };
        return HttpResponse.json({ ...makeTestResult(model), stopReason: "" });
      }),
    );
    const { dialog, user } = await openDialog(dana());
    await user.click(within(dialog).getByRole("button", { name: "Test 1" }));
    await waitFor(() => expect(row(dialog, "claude-sonnet-4.6")).toHaveTextContent("Succeeded"));

    await user.click(row(dialog, "claude-sonnet-4.6"));
    // The response flags it; the steps explain it.
    expect(within(inspector(dialog)).getByText("No stop reason")).toBeInTheDocument();
    await user.click(within(inspector(dialog)).getByRole("tab", { name: /Steps/ }));
    expect(stepLines(dialog)).toHaveLength(4);
    const [start, ok, details, warn] = stepLines(dialog);
    expect(start).toHaveTextContent("da***@no***.com · claude-sonnet-4.6 · Global proxy");
    expect(ok).toHaveTextContent(/da\*\*\*@no\*\*\*\.com OK \(\d+\.\ds\) Reply: ok/);
    expect(ok).toHaveAttribute("data-type", "ok");
    expect(details).toHaveTextContent("stop reason none | in/out 13/2");
    expect(warn).toHaveAttribute("data-type", "warn");
    expect(warn).toHaveTextContent("The stream carried no stop reason.");
    // The model id stays on one line.
    const model = within(start).getByText("claude-sonnet-4.6");
    expect(model.tagName).toBe("SPAN");
    expect(model).toHaveClass("whitespace-nowrap");
  });

  it("logs a failure step for a failing account", async () => {
    const { dialog, user } = await openDialog(banned());
    await user.click(within(dialog).getByRole("button", { name: "Test 1" }));
    await waitFor(() => expect(row(dialog, "claude-sonnet-4.6")).toHaveTextContent("Failed"));
    await user.click(row(dialog, "claude-sonnet-4.6"));
    await user.click(within(inspector(dialog)).getByRole("tab", { name: /Steps/ }));
    const failure = stepLines(dialog)[1];
    expect(failure).toHaveAttribute("data-type", "err");
    expect(failure).toHaveTextContent(/jl\*\*\*@pr\*\*\*\.com Failed \(\d+\.\ds\): AccessDenied/);
  });

  it(`keeps at most ${MAX_LOG_LINES} steps per model`, async () => {
    const { dialog, user } = await openDialog(dana());
    const run = within(dialog).getByRole("button", { name: "Test 1" });
    // Three steps per successful run: 34 runs write 102 steps.
    for (let i = 0; i < 34; i++) {
      await user.click(run);
      // The button stays focusable while it runs (loading), so wait for the busy state to end.
      await waitFor(() => expect(run).not.toHaveAttribute("aria-busy"));
    }
    await user.click(row(dialog, "claude-sonnet-4.6"));
    await user.click(within(inspector(dialog)).getByRole("tab", { name: /Steps/ }));
    await waitFor(() => expect(stepLines(dialog)).toHaveLength(MAX_LOG_LINES));
    // The oldest steps are dropped: the list now starts with a details step of run 1.
    expect(stepLines(dialog)[0]).toHaveTextContent("stop reason end_turn");
    // 34 full runs, each a click and a round trip: a busy machine needs more than the 5 s default.
  }, 15_000);

  it("adds a model that is not cached by its name, picked, and tests it as typed", async () => {
    const tested = recordTests();
    const { dialog, user } = await openDialog(dana());
    const picker = await openPicker(dialog, user);
    await user.type(within(picker).getByRole("combobox"), "my-custom-model");
    expect(
      within(picker).getByRole("option", { name: "Add “my-custom-model”" }),
    ).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(within(picker).getByRole("combobox")).toHaveValue("");
    expect(pickerOption(picker, "my-custom-model")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Escape}");

    expect(rowModels(dialog)).toEqual(["claude-sonnet-4.6", "my-custom-model"]);
    await user.click(within(dialog).getByRole("button", { name: "Test 2" }));
    await waitFor(() => expect(row(dialog, "my-custom-model")).toHaveTextContent("Succeeded"));
    expect([...tested].sort()).toEqual(["claude-sonnet-4.6", "my-custom-model"]);
  });

  it("offers the default model when the model list cannot load", async () => {
    mockServer.use(
      http.get(apiUrl("/accounts/:id/models/cached"), () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    renderWithProviders(<TestAccountDialog account={dana()} onOpenChange={() => {}} open />);
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText(/^Could not load the model list\. Enter a model name\./),
    ).toBeInTheDocument();
    expect(rowModels(dialog)).toEqual(["claude-sonnet-4.6"]);
    expect(within(dialog).getByRole("button", { name: "Test 1" })).toBeEnabled();
  });
});
