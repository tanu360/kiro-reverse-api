import { screen, waitFor, within } from "@testing-library/react";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import type { Account } from "@/lib/api/types";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl, jsonError } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { AccountDetailSheet } from "./account-detail-sheet";

function accountBy(predicate: (account: Account) => boolean): Account {
  const account = mockDb.accounts.find(predicate);
  if (!account) throw new Error("fixture missing");
  return account;
}

const dana = () => accountBy((a) => a.email.startsWith("dana."));
const apiKeyAccount = () => accountBy((a) => a.authMethod === "api_key");
const notCapable = () => accountBy((a) => a.overageCapability === "NOT_OVERAGE_CAPABLE");

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
  await within(sheet).findByText("Basic info");
  return { ...view, sheet };
}

function section(sheet: HTMLElement, title: string): HTMLElement {
  return within(sheet).getByRole("region", { name: title });
}

/** Opens a row's Edit dialog ("Edit Machine ID") and returns the dialog. */
async function openEditor(
  sheet: HTMLElement,
  user: Awaited<ReturnType<typeof openSheet>>["user"],
  title: string,
): Promise<HTMLElement> {
  await user.click(within(sheet).getByRole("button", { name: `Edit ${title}` }));
  return screen.findByRole("dialog", { name: title });
}

describe("AccountDetailSheet", () => {
  it("titles the sheet with the email over the nickname, plan and sign-in line", async () => {
    const account = dana();
    const { sheet } = await openSheet(account);
    // Masked by the default privacy mode, as in the list.
    expect(sheet).toHaveAccessibleName("da***@no***.com");
    expect(sheet).toHaveAccessibleDescription(`${account.nickname} · Pro · Enterprise`);
    const basic = section(sheet, "Basic info");
    // The email is the title, not a row of the basic info.
    expect(within(basic).queryByText("Email")).not.toBeInTheDocument();
    expect(within(basic).getByRole("button", { name: "Copy User ID" })).toBeInTheDocument();
  });

  it("shows a field error for an invalid machine ID and sends nothing", async () => {
    const puts = capture("put", "/accounts/:id");
    const { sheet, user } = await openSheet(dana());
    const dialog = await openEditor(sheet, user, "Machine ID");
    const input = within(dialog).getByPlaceholderText("UUID");
    await user.clear(input);
    await user.type(input, "not-a-uuid");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      await within(dialog).findByText(
        "Enter a UUID or 32 hex characters, or leave the field empty.",
      ),
    ).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(puts).toEqual([]);
  });

  it("fills the machine ID from the dice button", async () => {
    const { sheet, user } = await openSheet(dana());
    const dialog = await openEditor(sheet, user, "Machine ID");
    const input = within(dialog).getByPlaceholderText("UUID") as HTMLInputElement;
    await user.clear(input);
    await user.click(within(dialog).getByRole("button", { name: "Generate random machine ID" }));
    await waitFor(() =>
      expect(input.value).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      ),
    );
  });

  it("saves the weight as a JSON number and closes the dialog", async () => {
    const puts = capture("put", "/accounts/:id");
    const { sheet, user } = await openSheet(dana());
    const dialog = await openEditor(sheet, user, "Weight");
    const input = within(dialog).getByRole("textbox", { name: "Weight" });
    await user.clear(input);
    await user.type(input, "4");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts).toEqual([{ weight: 4 }]));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Weight" })).not.toBeInTheDocument(),
    );
  });

  it("drops an edit on Cancel and starts the next one from the saved value", async () => {
    const puts = capture("put", "/accounts/:id");
    const account = dana();
    const { sheet, user } = await openSheet(account);
    let dialog = await openEditor(sheet, user, "Nickname");
    const input = within(dialog).getByPlaceholderText("Team primary");
    await user.clear(input);
    await user.type(input, "Scratch");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Nickname" })).not.toBeInTheDocument(),
    );
    dialog = await openEditor(sheet, user, "Nickname");
    expect(within(dialog).getByPlaceholderText("Team primary")).toHaveValue(account.nickname);
    expect(puts).toEqual([]);
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
    expect(await screen.findByText("Pinned to us-east-1")).toBeInTheDocument();
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

  it("shows the plan as the list does, the credits meter first and dates in the UI locale", async () => {
    const account = dana();
    const { sheet } = await openSheet(account);
    const subscription = section(sheet, "Subscription");
    expect(within(subscription).getByText("Pro")).toBeInTheDocument();
    expect(within(subscription).queryByText("KIRO PRO")).not.toBeInTheDocument();
    const [year, month, day] = account.nextResetDate.split("-").map(Number);
    const reset = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(
      new Date(Date.UTC(year, month - 1, day)),
    );
    expect(within(subscription).getByText(reset)).toBeInTheDocument();
    // Plan credits lead the sheet in the meter, over the lifetime numbers.
    const statistics = section(sheet, "Statistics");
    expect(within(statistics).getByRole("meter", { name: "Plan credits" })).toBeInTheDocument();
    expect(within(statistics).getByText("450 / 1,000")).toBeInTheDocument();
    expect(within(subscription).queryByText("450 / 1,000")).not.toBeInTheDocument();
    // Same one-decimal credits as the list ("312.5", not "312.48").
    expect(within(statistics).getByText("312.5")).toBeInTheDocument();
  });
});
