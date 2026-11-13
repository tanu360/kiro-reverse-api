import { act, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { toast } from "@/lib/toast";
import { renderWithProviders } from "@/test/render";
import { Button } from "./button";
import { Dialog, DialogFooter, DialogPanel, DialogPopup, DialogTitle } from "./dialog";
import { Sheet, SheetPanel, SheetPopup, SheetTitle } from "./sheet";

afterEach(() => {
  act(() => toast.dismiss());
});

function FormDialog({ title = "Edit proxy" }: { title?: string }) {
  return (
    <Dialog open>
      <DialogPopup>
        {/* The footer sits in a form, as in the proxy dialogs. */}
        <form>
          <DialogTitle>{title}</DialogTitle>
          <DialogPanel>
            <input aria-label="Host" />
          </DialogPanel>
          <DialogFooter>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

describe("ModalNotice", () => {
  it("shows an error toast raised while a dialog is open over the dialog's buttons", async () => {
    renderWithProviders(<FormDialog />);
    const dialog = await screen.findByRole("dialog", { name: "Edit proxy" });

    act(() => {
      toast.error("Could not save settings.", { description: "The host holds a port." });
    });

    const notice = within(dialog).getByRole("alert");
    expect(notice).toHaveTextContent("Could not save settings.The host holds a port.");
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(notice.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("clears the line when the user types in the dialog", async () => {
    const { user } = renderWithProviders(<FormDialog />);
    const dialog = await screen.findByRole("dialog", { name: "Edit proxy" });
    act(() => {
      toast.warning("Check the host.");
    });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Check the host.");

    await user.type(within(dialog).getByLabelText("Host"), "a");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps success toasts and background toasts out of the dialog", async () => {
    renderWithProviders(<FormDialog />);
    const dialog = await screen.findByRole("dialog", { name: "Edit proxy" });
    act(() => {
      toast.success("Saved.");
      toast.warning("Self-heal stopped.", { background: true });
    });
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the error of a loading toast only in the dialog it started in", async () => {
    const outside = toast.loading("Deleting 2 accounts…");
    renderWithProviders(<FormDialog />);
    const dialog = await screen.findByRole("dialog", { name: "Edit proxy" });
    act(() => {
      toast.update(outside, { type: "error", title: "Could not delete 2 accounts." });
    });
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();

    const inside = toast.loading("Testing…");
    act(() => {
      toast.update(inside, { type: "error", title: "The test failed." });
    });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("The test failed.");
  });

  it("puts the line at the end of a modal without a footer", async () => {
    renderWithProviders(
      <Sheet open>
        <SheetPopup>
          <SheetTitle>Account details</SheetTitle>
          <SheetPanel>
            <p>Details</p>
          </SheetPanel>
        </SheetPopup>
      </Sheet>,
    );
    const sheet = await screen.findByRole("dialog", { name: "Account details" });
    act(() => {
      toast.error("Could not save the nickname.");
    });
    expect(within(sheet).getByRole("alert")).toHaveTextContent("Could not save the nickname.");
  });

  it("shows it in the newest of two open modals only", async () => {
    renderWithProviders(
      <Sheet open>
        <SheetPopup>
          <SheetTitle>Account details</SheetTitle>
          <FormDialog title="Edit nickname" />
        </SheetPopup>
      </Sheet>,
    );
    const dialog = await screen.findByRole("dialog", { name: "Edit nickname" });
    // The sheet under the nested dialog is hidden from the accessibility tree.
    const sheet = document.querySelector<HTMLElement>("[data-slot=sheet-popup]");
    if (!sheet) throw new Error("sheet not rendered");
    act(() => {
      toast.error("Could not save the nickname.");
    });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Could not save the nickname.");
    expect(sheet.querySelector("[data-slot=modal-notice]")).toBeNull();
  });
});
