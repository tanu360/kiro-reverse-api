import { screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { PasswordField } from "./password-field";

function Harness() {
  const [value, setValue] = useState("");
  return <PasswordField onChange={setValue} value={value} />;
}

describe("PasswordField", () => {
  it("shows and hides the password with the shared eye toggle", async () => {
    const { user } = renderWithProviders(<Harness />);
    const toggle = await screen.findByRole("button", { name: "Show password" });
    // The shared PasswordInput's toggle: an action button whose name flips, with no pressed
    // state to contradict it (its touch target comes from the Button's coarse-pointer hit
    // area, not from a class here).
    expect(toggle).not.toHaveAttribute("aria-pressed");
    expect(toggle).not.toHaveClass("max-md:size-10");
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    await user.click(toggle);
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");
    const hide = screen.getByRole("button", { name: "Hide password" });
    expect(hide).toBe(toggle);
    expect(hide).not.toHaveAttribute("aria-pressed");
    await user.click(hide);
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Show password" })).toBe(toggle);
  });
});
