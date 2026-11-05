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
    // The shared PasswordInput's toggle: a pressed-state icon-sm button (its touch target comes
    // from the Button's coarse-pointer hit area, not from a class here).
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).not.toHaveClass("max-md:size-10");
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    await user.click(toggle);
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
