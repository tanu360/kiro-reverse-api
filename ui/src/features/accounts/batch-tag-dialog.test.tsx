import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { useState } from "react";
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

/** A result read out by the app's hidden live region (no toast). */
async function expectAnnounced(text: string): Promise<void> {
  const line = await screen.findByText(text);
  expect(line.closest('[data-slot="live-announcer"]')).not.toBeNull();
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

/** The dialog with an Open button, to close it and open it again. */
function ReopenHarness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open
      </button>
      <BatchTagDialog
        accounts={mockDb.accounts}
        ids={[mockDb.accounts[0].id]}
        onDone={() => {}}
        onOpenChange={setOpen}
        open={open}
      />
    </>
  );
}

describe("BatchTagDialog", () => {
  it("adds a tag with Enter and removes it from the button, then hands back", async () => {
    const bodies = captureBatch();
    const [first, second] = mockDb.accounts;
    const ids = [first.id, second.id];
    const { user, onDone } = renderDialog(ids);
    const dialog = await screen.findByRole("dialog", { name: "Edit tags for 2 accounts" });
    const input = within(dialog).getByRole("textbox", { name: "Tag" });
    await waitFor(() => expect(input).toHaveFocus());

    await user.type(input, "  vip {Enter}");
    await expectAnnounced("Tagged 2 accounts.");
    expect(bodies).toEqual([{ ids, action: "addTag", tag: "vip" }]);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith([]);
    expect(first.tags).toEqual(["vip"]);

    await user.type(input, "VIP");
    await user.click(within(dialog).getByRole("button", { name: "Remove tag" }));
    await expectAnnounced("Removed the tag from 2 accounts.");
    expect(bodies[1]).toEqual({ ids, action: "removeTag", tag: "VIP" });
    expect(first.tags).toEqual([]);
  });

  it("offers the tags in use as quick picks", async () => {
    const [first] = mockDb.accounts;
    first.tags = ["team-a"];
    const { user } = renderDialog([first.id]);
    const dialog = await screen.findByRole("dialog", { name: "Edit tags for 1 account" });
    const picks = within(dialog).getByRole("group", { name: "Tags in use" });
    await user.click(within(picks).getByRole("button", { name: "team-a" }));
    expect(within(dialog).getByRole("textbox", { name: "Tag" })).toHaveValue("team-a");
  });

  it("keeps a picked email tag masked in the field under privacy, and sends it whole", async () => {
    const bodies = captureBatch();
    const [first] = mockDb.accounts;
    first.tags = ["ops@example.com"];
    const { user } = renderDialog([first.id]);
    const dialog = await screen.findByRole("dialog", { name: "Edit tags for 1 account" });
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
    const dialog = await screen.findByRole("dialog", { name: "Edit tags for 1 account" });
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

  it("names an account that already has the most tags in the dialog and hands back only it", async () => {
    const [full, other] = mockDb.accounts;
    full.tags = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const { user, onDone } = renderDialog([full.id, other.id]);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Tag" }), "new");
    await user.click(within(dialog).getByRole("button", { name: "Add tag" }));
    const notice = await within(dialog).findByRole("alert");
    expect(notice).toHaveTextContent(/^Tagged 1 account\. .+: Already has 10 tags/);
    // The page keeps the dialog on the account that failed; the draft stays for another try.
    expect(onDone).toHaveBeenCalledWith([full.id]);
    expect(within(dialog).getByRole("textbox", { name: "Tag" })).toHaveValue("new");
  });

  it("says a failed request in the dialog, and Try again sends it again", async () => {
    let fail = true;
    mockServer.use(
      http.post(apiUrl("/accounts/batch"), () =>
        fail ? HttpResponse.json({ error: "boom" }, { status: 500 }) : undefined,
      ),
    );
    // Registered last, so it runs first and sees both requests.
    const bodies = captureBatch();
    const [first] = mockDb.accounts;
    const { user, onDone } = renderDialog([first.id]);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Tag" }), "vip{Enter}");
    const notice = await within(dialog).findByRole("alert");
    expect(notice).toHaveTextContent("boom");
    expect(onDone).not.toHaveBeenCalled();

    fail = false;
    await user.click(within(notice).getByRole("button", { name: "Try again" }));
    await expectAnnounced("Tagged 1 account.");
    expect(bodies).toHaveLength(2);
    expect(onDone).toHaveBeenCalledWith([]);
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Add tag" })).toHaveFocus();
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

  it("opens again with an empty field after an Escape", async () => {
    const { user } = renderWithProviders(<ReopenHarness />);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Tag" }), "a, b");
    await user.click(within(dialog).getByRole("button", { name: "Add tag" }));
    expect(await within(dialog).findByText("Enter one tag at a time.")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Open" }));
    const reopened = await screen.findByRole("dialog");
    expect(within(reopened).getByRole("textbox", { name: "Tag" })).toHaveValue("");
    expect(within(reopened).queryByText("Enter one tag at a time.")).not.toBeInTheDocument();
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
