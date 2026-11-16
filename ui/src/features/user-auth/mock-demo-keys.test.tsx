import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_KEYS } from "@/features/user-panel/mocks";
import { renderWithProviders } from "@/test/render";
import { MockDemoKeys } from "./mock-demo-keys";

afterEach(() => vi.unstubAllEnvs());

describe("MockDemoKeys", () => {
  it("renders nothing outside mock mode", async () => {
    vi.stubEnv("VITE_MOCK", "");
    const { container } = renderWithProviders(<MockDemoKeys onPick={vi.fn()} />);
    // Give a stray import time to land: nothing may show up afterwards either.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("heading", { name: "Demo keys" })).not.toBeInTheDocument();
  });

  it("lists every demo key in mock mode and hands the picked one over", async () => {
    vi.stubEnv("VITE_MOCK", "1");
    const onPick = vi.fn();
    const { user } = renderWithProviders(<MockDemoKeys onPick={onPick} />);
    const section = (await screen.findByRole("heading", { name: "Demo keys" })).closest("section");
    if (!section) throw new Error("no section");
    const items = within(section).getAllByRole("listitem");
    expect(items).toHaveLength(DEMO_KEYS.length);
    expect(items[0]).toHaveTextContent("Active·Everyday traffic with a few failures");
    expect(items[1]).toHaveTextContent("Near its limits·Tokens 95%, credits 98%, calls 90%");

    await user.click(within(section).getByRole("button", { name: "Over its limit" }));
    expect(onPick).toHaveBeenCalledExactlyOnceWith("sk-demo-over-limit");
    await user.click(within(section).getByRole("button", { name: "Short session" }));
    expect(onPick).toHaveBeenLastCalledWith("sk-demo-short-session");
  });
});
