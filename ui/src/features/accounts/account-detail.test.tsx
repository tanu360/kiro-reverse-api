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

describe("AccountDetailSheet", () => {
  it("shows a field error for an invalid machine ID and sends nothing", async () => {
    const puts = capture("put", "/accounts/:id");
    const { sheet, user } = await openSheet(dana());
    const machine = section(sheet, "Machine ID");
    const input = within(machine).getByPlaceholderText("UUID");
    await user.clear(input);
    await user.type(input, "not-a-uuid");
    await user.click(within(machine).getByRole("button", { name: "Save" }));
    expect(
      await within(machine).findByText(
        "Enter a UUID or 32 hex characters, or leave the field empty.",
      ),
    ).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(puts).toEqual([]);
  });

  it("fills the machine ID from Generate", async () => {
    const { sheet, user } = await openSheet(dana());
    const machine = section(sheet, "Machine ID");
    const input = within(machine).getByPlaceholderText("UUID") as HTMLInputElement;
    await user.clear(input);
    await user.click(within(machine).getByRole("button", { name: "Generate" }));
    await waitFor(() =>
      expect(input.value).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      ),
    );
  });

  it("saves the weight as a JSON number", async () => {
    const puts = capture("put", "/accounts/:id");
    const { sheet, user } = await openSheet(dana());
    const weight = section(sheet, "Weight");
    const input = within(weight).getByRole("textbox", { name: "Weight" });
    await user.clear(input);
    await user.type(input, "4");
    await user.click(within(weight).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts).toEqual([{ weight: 4 }]));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
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
    expect(within(overage).getByText("Not overage capable")).toBeInTheDocument();
  });

  it("hides the Kiro profile section for API key accounts", async () => {
    const { sheet } = await openSheet(apiKeyAccount());
    expect(within(sheet).queryByRole("region", { name: "Kiro profile" })).not.toBeInTheDocument();
    expect(within(sheet).getByRole("region", { name: "Machine ID" })).toBeInTheDocument();
  });

  it("pins the selected profile and refetches the accounts list", async () => {
    const account = notCapable();
    const pins = capture("post", "/accounts/:id/profile");
    const { sheet, user, queryClient } = await openSheet(account);
    const profile = section(sheet, "Kiro profile");
    await user.click(within(profile).getByRole("button", { name: "Load profiles" }));
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
    await user.click(within(models).getByRole("button", { name: "Load" }));
    const list = await within(models).findByRole("list", { name: "Available models" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("auto");
    expect(items[1]).toHaveTextContent("claude-haiku-4.5");
    expect(items[1]).toHaveTextContent("0.4x credit");
  });
});
