import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { BatchTagDialog } from "./batch-tag-dialog";

function captureBatch(): unknown[] {
  const bodies: unknown[] = [];
  mockServer.use(
    http.post(apiUrl("/accounts/batch"), async ({ request }) => {
      bodies.push(await request.clone().json());
      return undefined;
    }),
  );
  return bodies;
}

function renderDialog(ids: string[]) {
  const onDone = vi.fn();
  const view = renderWithProviders(
    <BatchTagDialog
      accounts={mockDb.accounts}
      ids={ids}
      onDone={onDone}
      onOpenChange={() => {}}
      open
    />,
    { privacy: true },
  );
  return { ...view, onDone };
}

describe("BatchTagDialog", () => {
  it("adds a tag with Enter and removes it from the button, then hands back", async () => {
    const bodies = captureBatch();
    const [first, second] = mockDb.accounts;
    const ids = [first.id, second.id];
    const { user, onDone } = renderDialog(ids);
    const dialog = await screen.findByRole("dialog", { name: "Tag 2 accounts" });
    const input = within(dialog).getByRole("textbox", { name: "Tag" });
    await waitFor(() => expect(input).toHaveFocus());

    await user.type(input, "  vip {Enter}");
    expect(await screen.findByText("Tagged 2 accounts.")).toBeInTheDocument();
    expect(bodies).toEqual([{ ids, action: "addTag", tag: "vip" }]);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(first.tags).toEqual(["vip"]);

    await user.type(input, "VIP");
    await user.click(within(dialog).getByRole("button", { name: "Remove tag" }));
    expect(await screen.findByText("Removed the tag from 2 accounts.")).toBeInTheDocument();
    expect(bodies[1]).toEqual({ ids, action: "removeTag", tag: "VIP" });
    expect(first.tags).toEqual([]);
  });

  it("offers the tags in use as quick picks", async () => {
    const [first] = mockDb.accounts;
    first.tags = ["team-a"];
    const { user } = renderDialog([first.id]);
    const dialog = await screen.findByRole("dialog", { name: "Tag 1 account" });
    const picks = within(dialog).getByRole("group", { name: "Tags in use" });
    await user.click(within(picks).getByRole("button", { name: "team-a" }));
    expect(within(dialog).getByRole("textbox", { name: "Tag" })).toHaveValue("team-a");
  });

  it("keeps a picked email tag masked in the field under privacy, and sends it whole", async () => {
    const bodies = captureBatch();
    const [first] = mockDb.accounts;
    first.tags = ["ops@example.com"];
    const { user } = renderDialog([first.id]);
    const dialog = await screen.findByRole("dialog", { name: "Tag 1 account" });
    const picks = within(dialog).getByRole("group", { name: "Tags in use" });
    await user.click(within(picks).getByRole("button", { name: /^op\S+@\S+\.com$/ }));
    const input = within(dialog).getByRole("textbox", { name: "Tag" });
    expect(input).not.toHaveValue("ops@example.com");
    expect((input as HTMLInputElement).value).toMatch(/^op\S+@\S+\.com$/);
    await user.click(within(dialog).getByRole("button", { name: "Remove tag" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ ids: [first.id], action: "removeTag", tag: "ops@example.com" });
  });

  async function pickMaskedTag() {
    const [first] = mockDb.accounts;
    first.tags = ["ops@example.com"];
    const view = renderDialog([first.id]);
    const dialog = await screen.findByRole("dialog", { name: "Tag 1 account" });
    const picks = within(dialog).getByRole("group", { name: "Tags in use" });
    await view.user.click(within(picks).getByRole("button", { name: /^op\S+@\S+\.com$/ }));
    const input = within(dialog).getByRole("textbox", { name: "Tag" }) as HTMLInputElement;
    expect(input.value).toBe("op***@ex***.com");
    return { ...view, dialog, input };
  }

  it("edits the tag itself, not its masked text, when the end of a masked pick is edited", async () => {
    const { user, input } = await pickMaskedTag();
    await user.type(input, "{Backspace}");
    expect(input).toHaveValue("ops@example.co");
    await user.type(input, "m");
    expect(input).toHaveValue("ops@example.com");
  });

  it("types over a masked pick that is selected whole, without losing a key", async () => {
    const { user, input } = await pickMaskedTag();
    await user.keyboard("{Control>}a{/Control}zz");
    expect(input).toHaveValue("zz");
    expect(document.body.innerHTML).not.toContain("ops@example.com");
  });

  it("pastes over a masked pick that is selected whole", async () => {
    const bodies = captureBatch();
    const { user, dialog, input } = await pickMaskedTag();
    await user.keyboard("{Control>}a{/Control}");
    await user.paste("ci");
    expect(input).toHaveValue("ci");
    await user.click(within(dialog).getByRole("button", { name: "Add tag" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ action: "addTag", tag: "ci" });
  });

  it("names an account that already has the most tags in the result toast", async () => {
    const [full, other] = mockDb.accounts;
    full.tags = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const { user } = renderDialog([full.id, other.id]);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Tag" }), "new");
    await user.click(within(dialog).getByRole("button", { name: "Add tag" }));
    expect(await screen.findByText("Tagged 1 account.")).toBeInTheDocument();
    expect(await screen.findByText(/Already has 10 tags/)).toBeInTheDocument();
  });

  it("asks for one tag and sends nothing for an empty or comma-separated value", async () => {
    const bodies = captureBatch();
    const { user, onDone } = renderDialog([mockDb.accounts[0].id]);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Add tag" }));
    expect(await within(dialog).findByText("Enter a tag.")).toBeInTheDocument();
    await user.type(within(dialog).getByRole("textbox", { name: "Tag" }), "a, b");
    await user.click(within(dialog).getByRole("button", { name: "Remove tag" }));
    expect(await within(dialog).findByText("Enter one tag at a time.")).toBeInTheDocument();
    expect(bodies).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("keeps the dialog open when the request fails", async () => {
    mockServer.use(
      http.post(apiUrl("/accounts/batch"), () =>
        HttpResponse.json({ error: "tag is required" }, { status: 400 }),
      ),
    );
    const { user, onDone } = renderDialog([mockDb.accounts[0].id]);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Tag" }), "x{Enter}");
    expect((await screen.findAllByText("tag is required")).length).toBeGreaterThan(0);
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
