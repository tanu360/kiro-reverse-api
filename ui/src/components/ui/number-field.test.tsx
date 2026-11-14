import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "./number-field";

function Field(props: { min?: number; step?: number }) {
  return (
    <NumberField {...props}>
      <NumberFieldGroup>
        <NumberFieldInput aria-label="Amount" />
      </NumberFieldGroup>
    </NumberField>
  );
}

describe("NumberField", () => {
  it("takes digits only in a whole, non-negative field", async () => {
    const { user } = renderWithProviders(<Field min={0} step={1} />);
    const input = screen.getByRole("textbox", { name: "Amount" });
    await user.type(input, "a-1.2+b3");
    expect(input).toHaveValue("123");
  });

  it("keeps the decimal mark where the step has a fraction", async () => {
    const { user } = renderWithProviders(<Field min={0} step={0.01} />);
    const input = screen.getByRole("textbox", { name: "Amount" });
    await user.type(input, "-1.5x");
    expect(input).toHaveValue("1.5");
  });

  it("keeps the minus sign where the field can go below 0", async () => {
    const { user } = renderWithProviders(<Field step={1} />);
    const input = screen.getByRole("textbox", { name: "Amount" });
    await user.type(input, "-4");
    expect(input).toHaveValue("-4");
  });
});
