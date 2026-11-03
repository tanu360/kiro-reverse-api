import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { AlertDialog, AlertDialogPopup, AlertDialogTitle } from "./alert-dialog";
import { Dialog, DialogPopup, DialogTitle } from "./dialog";
import { Drawer, DrawerPopup, DrawerTitle } from "./drawer";
import { Sheet, SheetPopup, SheetTitle } from "./sheet";

function Page({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a href="#main">Skip to content</a>
      <button type="button">Behind the backdrop</button>
      {children}
    </>
  );
}

const cases = [
  {
    name: "Dialog",
    ui: (
      <Dialog open>
        <DialogPopup>
          <DialogTitle>Test account</DialogTitle>
          <input aria-label="Model" />
          <button type="button">Run test</button>
        </DialogPopup>
      </Dialog>
    ),
    // DialogPopup renders its Close button after the content.
    last: "Close",
  },
  {
    name: "Sheet",
    ui: (
      <Sheet open>
        <SheetPopup>
          <SheetTitle>Account details</SheetTitle>
          <input aria-label="Model" />
          <button type="button">Run test</button>
        </SheetPopup>
      </Sheet>
    ),
    last: "Close",
  },
  {
    name: "AlertDialog",
    ui: (
      <AlertDialog open>
        <AlertDialogPopup>
          <AlertDialogTitle>Delete account?</AlertDialogTitle>
          <input aria-label="Model" />
          <button type="button">Run test</button>
        </AlertDialogPopup>
      </AlertDialog>
    ),
    last: "Run test",
  },
  {
    name: "Drawer",
    ui: (
      <Drawer open>
        <DrawerPopup>
          <DrawerTitle>Add account</DrawerTitle>
          <input aria-label="Model" />
          <button type="button">Run test</button>
        </DrawerPopup>
      </Drawer>
    ),
    last: "Run test",
  },
];

describe("modal popups keep keyboard focus inside", () => {
  for (const { name, ui, last } of cases) {
    it(`${name}: Tab from the last control wraps to the first, Shift+Tab wraps back`, async () => {
      const { user } = renderWithProviders(<Page>{ui}</Page>);
      const dialog = await screen.findByRole(name === "AlertDialog" ? "alertdialog" : "dialog");
      const first = screen.getByRole("textbox", { name: "Model" });
      const lastControl = screen.getByRole("button", { name: last });

      lastControl.focus();
      await user.tab();
      expect(document.activeElement).toBe(first);
      expect(dialog.contains(document.activeElement)).toBe(true);

      await user.tab({ shift: true });
      expect(document.activeElement).toBe(lastControl);

      // Holding Tab down cycles inside the popup and never reaches the page behind it.
      for (let i = 0; i < 6; i += 1) {
        await user.tab();
        expect(dialog.contains(document.activeElement)).toBe(true);
      }
    });
  }
});
