import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { type ConfirmOptions, useConfirm } from "./confirm-dialog";

const OPTIONS: ConfirmOptions = {
  title: "Delete this account?",
  description: "This cannot be undone.",
  confirmLabel: "Delete",
  cancelLabel: "Cancel",
  variant: "danger",
};

function Harness({ results, options = OPTIONS }: { results: boolean[]; options?: ConfirmOptions }) {
  const confirm = useConfirm();
  return (
    <>
      <button
        onClick={() => void confirm(options).then((value) => results.push(value))}
        type="button"
      >
        Ask with options
      </button>
      <button
        onClick={() => void confirm(OPTIONS).then((value) => results.push(value))}
        type="button"
      >
        Ask
      </button>
      <button
        onClick={() => {
          void confirm(OPTIONS).then((value) => results.push(value));
          void confirm({ ...OPTIONS, title: "Second?" }).then((value) => results.push(value));
        }}
        type="button"
      >
        Ask twice
      </button>
    </>
  );
}

describe("useConfirm", () => {
  it("opens a danger confirm on Cancel from the keyboard, so Enter does not run the action", async () => {
    const results: boolean[] = [];
    const { user } = renderWithProviders(<Harness results={results} />);
    screen.getByRole("button", { name: "Ask" }).focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delete this account?");
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(results).toEqual([false]));
  });

  it("opens on the dialog itself after a click, so no button shows a ring", async () => {
    const results: boolean[] = [];
    const { user } = renderWithProviders(<Harness results={results} />);
    await user.click(screen.getByRole("button", { name: "Ask" }));
    const dialog = await screen.findByRole("alertdialog");
    await waitFor(() => expect(dialog).toHaveFocus());
    // Enter on the dialog runs nothing; Tab reaches Cancel first.
    await user.keyboard("{Enter}");
    expect(results).toEqual([]);
    await user.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("resolves true on confirm", async () => {
    const results: boolean[] = [];
    const { user } = renderWithProviders(<Harness results={results} />);
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(results).toEqual([true]));
  });

  it("opens a default confirm on its confirm button", async () => {
    const results: boolean[] = [];
    const { user } = renderWithProviders(
      <Harness
        options={{ title: "Sign out?", confirmLabel: "Sign out", variant: "default" }}
        results={results}
      />,
    );
    screen.getByRole("button", { name: "Ask with options" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign out" })).toHaveFocus());
  });

  it("sets the target apart inside the title", async () => {
    const results: boolean[] = [];
    const { user } = renderWithProviders(
      <Harness
        options={{ ...OPTIONS, title: "Delete ada@example.com?", target: "ada@example.com" }}
        results={results}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Ask with options" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveAccessibleName("Delete ada@example.com?");
    expect(dialog.querySelector('[data-slot="confirm-target"]')).toHaveTextContent(
      "ada@example.com",
    );
  });

  it("resolves false on Cancel", async () => {
    const results: boolean[] = [];
    const { user } = renderWithProviders(<Harness results={results} />);
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(results).toEqual([false]));
  });

  it("resolves false on Escape", async () => {
    const results: boolean[] = [];
    const { user } = renderWithProviders(<Harness results={results} />);
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(results).toEqual([false]));
  });

  it("resolves false on a backdrop click", async () => {
    const results: boolean[] = [];
    const { user } = renderWithProviders(<Harness results={results} />);
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await screen.findByRole("alertdialog");
    const viewport = document.querySelector<HTMLElement>('[data-slot="alert-dialog-viewport"]');
    if (!viewport) throw new Error("viewport not rendered");
    await user.click(viewport);
    await waitFor(() => expect(results).toEqual([false]));
  });

  it("resolves the first confirm with false when a second one opens", async () => {
    const results: boolean[] = [];
    const { user } = renderWithProviders(<Harness results={results} />);
    await user.click(screen.getByRole("button", { name: "Ask twice" }));
    await waitFor(() => expect(results).toEqual([false]));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Second?");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(results).toEqual([false, true]));
  });
});
