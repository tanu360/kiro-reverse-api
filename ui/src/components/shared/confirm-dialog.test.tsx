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

function Harness({ results }: { results: boolean[] }) {
  const confirm = useConfirm();
  return (
    <>
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
  it("resolves true on confirm and focuses the confirm button", async () => {
    const results: boolean[] = [];
    const { user } = renderWithProviders(<Harness results={results} />);
    await user.click(screen.getByRole("button", { name: "Ask" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delete this account?");
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(results).toEqual([true]));
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
