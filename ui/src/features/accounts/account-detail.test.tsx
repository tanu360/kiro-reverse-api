import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { resetProxyPoolMock, seedProxyPoolMock } from "@/features/proxy-pool/mocks";
import type { Account } from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl, jsonError } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { AccountDetailSheet } from "./account-detail-sheet";
import { isApiKeyAccount, supportsKiroProfiles } from "./account-model";

function accountBy(predicate: (account: Account) => boolean): Account {
  const account = mockDb.accounts.find(predicate);
  if (!account) throw new Error("fixture missing");
  return account;
}

const dana = () => accountBy((a) => a.email.startsWith("dana."));
const apiKeyAccount = () => accountBy((a) => a.authMethod === "api_key");
const notCapable = () => accountBy((a) => a.overageCapability === "NOT_OVERAGE_CAPABLE");
const noProfiles = () =>
  accountBy((a) => !isApiKeyAccount(a) && !supportsKiroProfiles(a) && !a.profileArnPinned);

function capture(method: "get" | "post" | "put", path: string): unknown[] {
  const bodies: unknown[] = [];
  mockServer.use(
    http[method](apiUrl(path), async ({ request }) => {
      bodies.push(method === "get" ? null : await request.clone().json());
      return undefined;
    }),
  );
  return bodies;
}

async function openSheet(account: Account) {
  const view = renderWithProviders(
    <AccountDetailSheet accountId={account.id} onOpenChange={() => {}} open />,
  );
  const sheet = await screen.findByRole("dialog");
  await within(sheet).findByRole("region", { name: "Account" });
  return { ...view, sheet };
}

function section(sheet: HTMLElement, title: string): HTMLElement {
  return within(sheet).getByRole("region", { name: title });
}

/** The row being edited in place, if any. */
function editingRow(sheet: HTMLElement): HTMLElement | null {
  return sheet.querySelector<HTMLElement>('[data-slot="inline-edit-row"][data-editing]');
}

/** Opens a row's inline edit ("Edit Machine ID") and returns the row in its edit view. */
async function openEditor(
  sheet: HTMLElement,
  user: Awaited<ReturnType<typeof openSheet>>["user"],
  title: string,
): Promise<HTMLElement> {
  await user.click(within(sheet).getByRole("button", { name: `Edit ${title}` }));
  return waitFor(() => {
    const row = editingRow(sheet);
    if (!row) throw new Error("no row in edit view");
    return row;
  });
}

describe("AccountDetailSheet", () => {
  it("titles the sheet with the email over the nickname, plan and sign-in line", async () => {
    const account = dana();
    const { sheet } = await openSheet(account);
    // Masked by the default privacy mode, as in the list.
    expect(sheet).toHaveAccessibleName("da***@no***.com");
    expect(sheet).toHaveAccessibleDescription(`${account.nickname} · Pro · Enterprise`);
    const facts = section(sheet, "Account");
    // The email is the title, and the plan and sign-in the meta line: neither is a fact again.
    expect(within(facts).queryByText("Email")).not.toBeInTheDocument();
    expect(within(facts).queryByText("Pro")).not.toBeInTheDocument();
    expect(within(facts).getByRole("button", { name: "Copy User ID" })).toBeInTheDocument();
  });

  it("puts the row's actions under the title", async () => {
    const account = dana();
    const { sheet, user } = await openSheet(account);
    expect(within(sheet).getByRole("button", { name: "Refresh token" })).toBeInTheDocument();
    expect(within(sheet).getByRole("switch", { name: "Enable da***@no***.com" })).toBeChecked();
    await user.click(within(sheet).getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("menuitem", { name: "Copy JSON" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(within(sheet).getByRole("button", { name: "Test" }));
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(2));
  });

  it("shows a field error for an invalid machine ID and sends nothing", async () => {
    const puts = capture("put", "/accounts/:id");
    const { sheet, user } = await openSheet(dana());
    const row = await openEditor(sheet, user, "Machine ID");
    const input = within(row).getByPlaceholderText("UUID");
    await user.clear(input);
    await user.type(input, "not-a-uuid");
    await user.click(within(row).getByRole("button", { name: "Save" }));
    expect(
      await within(row).findByText("Enter a UUID or 32 hex characters, or leave the field empty."),
    ).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(puts).toEqual([]);
  });

  it("fills the machine ID from the dice button", async () => {
    const { sheet, user } = await openSheet(dana());
    const row = await openEditor(sheet, user, "Machine ID");
    const input = within(row).getByPlaceholderText("UUID") as HTMLInputElement;
    await user.clear(input);
    await user.click(within(row).getByRole("button", { name: "Generate random machine ID" }));
    await waitFor(() =>
      expect(input.value).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      ),
    );
  });

  it("saves the weight as a JSON number and closes the edit", async () => {
    const puts = capture("put", "/accounts/:id");
    const { sheet, user } = await openSheet(dana());
    const row = await openEditor(sheet, user, "Weight");
    const input = within(row).getByRole("textbox", { name: "Weight" });
    // The edit starts in the field.
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, "4{Enter}");
    await waitFor(() => expect(puts).toEqual([{ weight: 4 }]));
    expect(await screen.findByText("The change was saved.")).toBeInTheDocument();
    await waitFor(() => expect(editingRow(sheet)).toBeNull());
    // Focus goes back to the row.
    expect(within(sheet).getByRole("button", { name: "Edit Weight" })).toHaveFocus();
  });

  it("drops an edit on Cancel and starts the next one from the saved value", async () => {
    const puts = capture("put", "/accounts/:id");
    const account = dana();
    const { sheet, user } = await openSheet(account);
    let row = await openEditor(sheet, user, "Nickname");
    const input = within(row).getByPlaceholderText("Team primary");
    await user.clear(input);
    await user.type(input, "Scratch");
    await user.click(within(row).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(editingRow(sheet)).toBeNull());
    row = await openEditor(sheet, user, "Nickname");
    expect(within(row).getByPlaceholderText("Team primary")).toHaveValue(account.nickname);
    expect(puts).toEqual([]);
  });

  it("drops an edit on Escape and keeps the sheet open", async () => {
    const puts = capture("put", "/accounts/:id");
    const { sheet, user } = await openSheet(dana());
    const row = await openEditor(sheet, user, "Account proxy");
    await user.type(within(row).getByPlaceholderText("socks5://host:port"), "socks5://x:1");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(editingRow(sheet)).toBeNull());
    expect(sheet).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBe(sheet);
    expect(puts).toEqual([]);
  });

  it("shows the global proxy an account without its own uses, without its password", async () => {
    const account = accountBy((a) => !a.proxyURL);
    const { sheet } = await openSheet(account);
    const facts = section(sheet, "Account");
    // The seed's global proxy is socks5://user:p%40ss@127.0.0.1:1080.
    expect(await within(facts).findByText("socks5://user@127.0.0.1:1080")).toBeInTheDocument();
    expect(within(facts).getByText("Global")).toBeInTheDocument();
    expect(facts).not.toHaveTextContent("p%40ss");
  });

  it("shows Direct when there is no global proxy either", async () => {
    mockServer.use(http.get(apiUrl("/proxy"), () => HttpResponse.json({ proxyURL: "" })));
    const account = accountBy((a) => !a.proxyURL);
    const { sheet } = await openSheet(account);
    const facts = section(sheet, "Account");
    expect(await within(facts).findByText("Direct")).toBeInTheDocument();
    expect(within(facts).getByText("Global")).toBeInTheDocument();
  });

  it("says an empty account proxy means the pool while the pool is on", async () => {
    onTestFinished(resetProxyPoolMock);
    const first = await openSheet(dana());
    let row = await openEditor(first.sheet, first.user, "Account proxy");
    expect(within(row).getByText("Leave empty to use the global proxy.")).toBeInTheDocument();
    first.unmount();
    seedProxyPoolMock({
      mode: "on",
      proxies: [
        {
          id: "px_a",
          label: "Tokyo",
          url: "socks5://10.1.0.1:1080",
          username: "",
          password: "",
          createdAt: 0,
          health: { status: "ok", latencyMs: 90 },
        },
      ],
    });
    const { sheet, user } = await openSheet(dana());
    row = await openEditor(sheet, user, "Account proxy");
    expect(await within(row).findByText("Leave empty to use the proxy pool.")).toBeInTheDocument();
    expect(within(row).queryByText("Leave empty to use the global proxy.")).toBeNull();
  });

  it("reverts the overage switch when AWS fails", async () => {
    mockServer.use(
      http.post(apiUrl("/accounts/:id/overage"), () => jsonError(502, "upstream timeout")),
    );
    const { sheet, user } = await openSheet(dana());
    const toggle = within(section(sheet, "Overage (AWS)")).getByRole("switch", {
      name: "Enable overage upstream",
    });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect((await screen.findAllByText("upstream timeout")).length).toBeGreaterThan(0);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(toggle).not.toHaveAttribute("data-disabled");
  });

  it("disables the overage switch for an account that is not overage capable", async () => {
    const { sheet } = await openSheet(notCapable());
    const overage = section(sheet, "Overage (AWS)");
    expect(
      within(overage).getByRole("switch", { name: "Enable overage upstream" }),
    ).toHaveAttribute("data-disabled");
    expect(within(overage).getByText("Not available for this account")).toBeInTheDocument();
  });

  it("hides the Kiro profile section for sign-ins without profiles", async () => {
    const { sheet } = await openSheet(noProfiles());
    expect(within(sheet).queryByRole("region", { name: "Kiro profile" })).not.toBeInTheDocument();
  });

  it("hides the Kiro profile section for API key accounts", async () => {
    const { sheet } = await openSheet(apiKeyAccount());
    expect(within(sheet).queryByRole("region", { name: "Kiro profile" })).not.toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Edit Machine ID" })).toBeInTheDocument();
  });

  it("pins the selected profile and refetches the accounts list", async () => {
    const account = notCapable();
    const pins = capture("post", "/accounts/:id/profile");
    const { sheet, user, queryClient } = await openSheet(account);
    const profile = section(sheet, "Kiro profile");
    await user.click(within(profile).getByRole("button", { name: "Load Kiro profiles" }));
    const sandbox = await within(profile).findByRole("radio", { name: /Fabrikam Sandbox/ });
    // The current profile is selected first.
    expect(within(profile).getByRole("radio", { name: /Fabrikam Engineering/ })).toBeChecked();
    await user.click(sandbox);
    const lists: unknown[] = capture("get", "/accounts");
    await user.click(within(profile).getByRole("button", { name: "Use selected profile" }));

    const sandboxArn = "arn:aws:codewhisperer:us-east-1:381492027763:profile/HV4N8TQW2JDE";
    await waitFor(() => expect(pins).toEqual([{ profileArn: sandboxArn }]));
    expect(
      await screen.findByText("The account now uses the us-east-1 profile."),
    ).toBeInTheDocument();
    await waitFor(() => expect(lists.length).toBeGreaterThan(0));
    await waitFor(() =>
      expect(
        queryClient.getQueryData<Account[]>(["accounts", "list"])?.find((a) => a.id === account.id)
          ?.activeRegion,
      ).toBe("us-east-1"),
    );
  });

  it("lists the live models with auto first", async () => {
    const { sheet, user } = await openSheet(dana());
    const models = section(sheet, "Available models");
    await user.click(within(models).getByRole("button", { name: "Load models" }));
    const list = await within(models).findByRole("list", { name: "Available models" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("auto");
    expect(items[1]).toHaveTextContent("claude-haiku-4.5");
    expect(items[1]).toHaveTextContent("0.4× credits");
  });

  it("starts focus on the sheet, not an input that would open the phone keyboard", async () => {
    const { sheet } = await openSheet(dana());
    await waitFor(() => expect(sheet).toHaveFocus());
    expect(document.activeElement?.tagName).not.toBe("INPUT");
  });

  it("puts the credits meter first, with the reset date in the UI locale under it", async () => {
    const account = dana();
    const { sheet } = await openSheet(account);
    const [year, month, day] = account.nextResetDate.split("-").map(Number);
    const reset = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(
      new Date(Date.UTC(year, month - 1, day)),
    );
    // Plan credits lead the sheet in the meter, over the last day and the lifetime numbers.
    const statistics = section(sheet, "Statistics");
    expect(within(statistics).getByRole("meter", { name: "Plan credits" })).toBeInTheDocument();
    expect(within(statistics).getByText("450 / 1,000")).toBeInTheDocument();
    expect(within(statistics).getByText(new RegExp(`^Resets ${reset} · `))).toBeInTheDocument();
    expect(within(statistics).getByText("Last 24 hours")).toBeInTheDocument();
    // Same one-decimal credits as the list ("312.5", not "312.48").
    expect(within(statistics).getByText("312.5")).toBeInTheDocument();
  });
});

describe("AccountDetailSheet notes and tags", () => {
  it("saves multi-line notes and comma-separated tags from the sheet", async () => {
    const puts = capture("put", "/accounts/:id");
    const account = dana();
    const { sheet, user } = await openSheet(account);

    let row = await openEditor(sheet, user, "Notes");
    const notes = within(row).getByRole("textbox", { name: "Notes" });
    // Enter adds a line in the notes; Save stores them.
    await user.type(notes, "Owner: ops{Enter}rotate in May");
    expect(within(row).getByText("24 / 2,000 characters")).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts).toEqual([{ notes: "Owner: ops\nrotate in May" }]));
    await waitFor(() => expect(editingRow(sheet)).toBeNull());

    row = await openEditor(sheet, user, "Tags");
    await user.type(
      within(row).getByRole("textbox", { name: "Tags" }),
      "team-a, Backup ,TEAM-A{Enter}",
    );
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toEqual({ tags: ["team-a", "Backup"] });
    await waitFor(() => expect(editingRow(sheet)).toBeNull());
    const facts = section(sheet, "Account");
    expect(await within(facts).findByText("Backup")).toBeInTheDocument();
    expect(within(facts).getByText("team-a")).toBeInTheDocument();
  });

  it("refuses too many or too long tags and sends nothing", async () => {
    const puts = capture("put", "/accounts/:id");
    const { sheet, user } = await openSheet(dana());
    const row = await openEditor(sheet, user, "Tags");
    const input = within(row).getByRole("textbox", { name: "Tags" });
    await user.type(input, Array.from({ length: 11 }, (_, i) => `t${i}`).join(","));
    await user.click(within(row).getByRole("button", { name: "Save" }));
    expect(await within(row).findByText("Use at most 10 tags.")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    await user.clear(input);
    await user.type(input, "x".repeat(25));
    await user.click(within(row).getByRole("button", { name: "Save" }));
    expect(
      await within(row).findByText(`“${"x".repeat(25)}” is longer than 24 characters.`),
    ).toBeInTheDocument();
    expect(puts).toEqual([]);
  });

  it("masks emails in the notes under privacy mode, but edits the raw text", async () => {
    const account = dana();
    account.notes = "Owner: ops.team@example.com";
    account.tags = ["billing@example.com"];
    const view = renderWithProviders(
      <AccountDetailSheet accountId={account.id} onOpenChange={() => {}} open />,
      { privacy: true },
    );
    const sheet = await screen.findByRole("dialog");
    const facts = await within(sheet).findByRole("region", { name: "Account" });
    expect(within(facts).getByText("Owner: op***@ex***.com")).toBeInTheDocument();
    expect(within(facts).getByText("bi***@ex***.com")).toBeInTheDocument();
    expect(facts).not.toHaveTextContent("ops.team@example.com");

    const row = await openEditor(sheet, view.user, "Notes");
    expect(within(row).getByRole("textbox", { name: "Notes" })).toHaveValue(
      "Owner: ops.team@example.com",
    );
  });

  it("shows the notes as written with privacy off", async () => {
    const account = dana();
    account.notes = "Owner: ops.team@example.com";
    renderWithProviders(
      <AccountDetailSheet accountId={account.id} onOpenChange={() => {}} open />,
      { privacy: false },
    );
    const sheet = await screen.findByRole("dialog");
    const facts = await within(sheet).findByRole("region", { name: "Account" });
    expect(within(facts).getByText("Owner: ops.team@example.com")).toBeInTheDocument();
  });
});
