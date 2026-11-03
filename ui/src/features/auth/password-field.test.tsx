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
  it("gives the show/hide toggle a 40 px touch target below md", async () => {
    const { user } = renderWithProviders(<Harness />);
    const toggle = await screen.findByRole("button", { name: "Show password" });
    // icon-sm is 32 px on phones; the touch rule needs 40 px there and keeps icon-sm from md.
    expect(toggle).toHaveClass("max-md:size-10");
    await user.click(toggle);
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveClass("max-md:size-10");
  });
});
