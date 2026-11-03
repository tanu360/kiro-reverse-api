import { screen } from "@testing-library/react";
import { UsersIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { formatDelta, StatCard } from "./stat-card";

describe("StatCard", () => {
  it("renders the label, value and metrics", () => {
    renderWithProviders(
      <StatCard
        icon={UsersIcon}
        label="Accounts"
        metrics={[
          { label: "Available", value: "6 / 8" },
          { label: "Capacity used", value: "41%", wide: true },
        ]}
        value="8"
      />,
    );
    expect(screen.getByText("Accounts")).toBeInTheDocument();
    expect(screen.getByText("8")).toBeInTheDocument();
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(screen.getByText("6 / 8")).toBeInTheDocument();
    expect(screen.getByText("41%")).toBeInTheDocument();
  });

  it("shows a metric hint as a tooltip", async () => {
    const { user } = renderWithProviders(
      <StatCard
        icon={UsersIcon}
        label="Accounts"
        metrics={[{ label: "Plan credits", value: "120 / 500", hint: "Kiro-reported usage" }]}
        value="8"
      />,
    );
    expect(screen.queryByText("Kiro-reported usage")).not.toBeInTheDocument();
    await user.hover(screen.getByRole("button", { name: /Plan credits/ }));
    expect(await screen.findByText("Kiro-reported usage")).toBeInTheDocument();
  });

  it("formats a positive delta", () => {
    renderWithProviders(
      <StatCard
        delta={{ value: 0.125, label: "vs previous hour" }}
        icon={UsersIcon}
        label="Requests"
        value="1,024"
      />,
    );
    expect(screen.getByText("+12.5%")).toBeInTheDocument();
    expect(screen.getByText("vs previous hour")).toBeInTheDocument();
  });

  it("uses the destructive tone for a drop when up is good", () => {
    renderWithProviders(
      <StatCard
        delta={{ value: -0.2, label: "vs previous hour", goodWhen: "up" }}
        icon={UsersIcon}
        label="Success"
        value="900"
      />,
    );
    const badge = screen.getByText("-20%").closest('[data-slot="badge"]');
    expect(badge).toHaveAttribute("data-tone", "bad");
    expect(badge?.className).toMatch(/destructive/);
  });

  it("treats a drop as good when down is good", () => {
    renderWithProviders(
      <StatCard
        delta={{ value: -0.2, label: "vs previous hour", goodWhen: "down" }}
        icon={UsersIcon}
        label="Failed"
        value="12"
      />,
    );
    const badge = screen.getByText("-20%").closest('[data-slot="badge"]');
    expect(badge).toHaveAttribute("data-tone", "good");
    expect(badge?.className).not.toMatch(/destructive/);
  });

  it("renders the skeleton while loading", () => {
    const { container } = renderWithProviders(
      <StatCard icon={UsersIcon} label="Accounts" loading value="8" />,
    );
    expect(container.querySelector('[data-slot="stat-card-skeleton"]')).toBeInTheDocument();
    expect(screen.queryByText("Accounts")).not.toBeInTheDocument();
  });
});

describe("formatDelta", () => {
  it("formats fractions as signed percentages", () => {
    expect(formatDelta(0.125)).toBe("+12.5%");
    expect(formatDelta(-0.2)).toBe("-20%");
    expect(formatDelta(0)).toBe("0%");
    expect(formatDelta(0.3333)).toBe("+33.3%");
  });
});
