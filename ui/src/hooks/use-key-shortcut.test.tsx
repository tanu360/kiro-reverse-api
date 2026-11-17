import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { scopedShortcuts, useKeyShortcut } from "./use-key-shortcut";

function Page({ onSlash }: { onSlash: () => void }) {
  useKeyShortcut(["/"], onSlash);
  return (
    <div>
      <input aria-label="Search" />
      <button type="button">Plain</button>
    </div>
  );
}

describe("useKeyShortcut", () => {
  it("fires on its key, not in a text field, with a modifier or under an open dialog", () => {
    const onSlash = vi.fn();
    const { container } = render(<Page onSlash={onSlash} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Plain" }), { key: "/" });
    expect(onSlash).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search" }), { key: "/" });
    fireEvent.keyDown(document.body, { key: "/", ctrlKey: true });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    container.append(dialog);
    fireEvent.keyDown(document.body, { key: "/" });
    expect(onSlash).toHaveBeenCalledTimes(1);
  });
});

describe("scopedShortcuts", () => {
  it("maps keys inside its element and skips widgets that own them", () => {
    const next = vi.fn();
    const previous = vi.fn();
    render(
      <div
        aria-label="Sheet"
        data-testid="scope"
        onKeyDown={scopedShortcuts([
          { keys: ["ArrowLeft", "k"], run: previous },
          { keys: ["ArrowRight", "j"], run: next },
        ])}
        role="dialog"
        tabIndex={-1}
      >
        <div role="tablist">
          <button role="tab" type="button">
            Tab
          </button>
        </div>
      </div>,
    );
    const scope = screen.getByTestId("scope");
    fireEvent.keyDown(scope, { key: "J" });
    fireEvent.keyDown(scope, { key: "ArrowLeft" });
    fireEvent.keyDown(scope, { key: "ArrowRight", metaKey: true });
    fireEvent.keyDown(screen.getByRole("tab"), { key: "ArrowRight" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledTimes(1);
  });
});
