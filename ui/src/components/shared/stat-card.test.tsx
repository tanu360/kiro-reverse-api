import { UsersIcon } from "@hugeicons/core-free-icons";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { formatDelta, StatGroup, StatTile } from "./stat-card";

describe("StatCard", () => {
  it("renders the label, value and metrics", () => {
    renderWithProviders(
      <StatTile
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
      <StatTile
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

  it("opens a metric hint with a click or tap, which a hover tooltip never does", async () => {
    const { user } = renderWithProviders(
      <StatTile
        icon={UsersIcon}
        label="Accounts"
        metrics={[{ label: "Plan credits", value: "120 / 500", hint: "Kiro-reported usage" }]}
        value="8"
      />,
    );
    const trigger = screen.getByRole("button", { name: /Plan credits/ });
    // A touch tap has no hover phase: pointer down/up plus click only.
    await user.pointer({ keys: "[TouchA]", target: trigger });
    expect(await screen.findByText("Kiro-reported usage")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("formats a positive delta", () => {
    renderWithProviders(
      <StatTile
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
      <StatTile
        delta={{ value: -0.2, label: "vs previous hour", goodWhen: "up" }}
        icon={UsersIcon}
        label="Success"
        value="900"
      />,
    );
    const delta = screen.getByText("-20%").closest('[data-slot="stat-delta"]');
    expect(delta).toHaveAttribute("data-tone", "bad");
    expect(screen.getByText("-20%").className).toMatch(/destructive/);
  });

  it("treats a drop as good when down is good", () => {
    renderWithProviders(
      <StatTile
        delta={{ value: -0.2, label: "vs previous hour", goodWhen: "down" }}
        icon={UsersIcon}
        label="Failed"
        value="12"
      />,
    );
    const delta = screen.getByText("-20%").closest('[data-slot="stat-delta"]');
    expect(delta).toHaveAttribute("data-tone", "good");
    expect(screen.getByText("-20%").className).toMatch(/success/);
  });

  it("renders the skeleton while loading", () => {
    const { container } = renderWithProviders(
      <StatTile icon={UsersIcon} label="Accounts" loading value="8" />,
    );
    expect(container.querySelector('[data-slot="stat-card-skeleton"]')).toBeInTheDocument();
    expect(screen.queryByText("Accounts")).not.toBeInTheDocument();
  });
});

describe("StatTile", () => {
  it("keeps the value in the text colour on a danger tile", () => {
    renderWithProviders(<StatTile icon={UsersIcon} label="Failed" tone="danger" value="12" />);
    const value = screen.getByText("12");
    expect(value).toHaveAttribute("data-slot", "stat-value");
    expect(value.className).not.toMatch(/destructive/);
    expect(value.className).toMatch(/tabular-nums/);
  });

  it("reserves the trend slot and hides it from assistive tech", () => {
    renderWithProviders(
      <StatTile icon={UsersIcon} label="Requests" trend={<svg data-testid="bars" />} value="8" />,
    );
    const slot = screen.getByTestId("bars").closest('[data-slot="stat-trend"]');
    expect(slot).toHaveAttribute("aria-hidden", "true");
  });

  it("puts an aside trend in its own column slot, beside the value and the delta", () => {
    renderWithProviders(
      <StatTile
        delta={{ value: 0.1, label: "vs previous hour" }}
        label="Requests"
        trend={<svg data-testid="bars" />}
        trendPlacement="aside"
        value="8"
      />,
    );
    const slot = screen.getByTestId("bars").closest('[data-slot="stat-trend"]');
    expect(slot).toHaveAttribute("data-placement", "aside");
    expect(slot).toHaveAttribute("aria-hidden", "true");
    expect(slot).toHaveClass("h-12");
    // The value keeps clear of the column wherever the column sits beside it.
    expect(screen.getByText("8").className).toMatch(/stat-row:pr-/);
  });

  it("keeps the inline trend slot by default", () => {
    renderWithProviders(<StatTile label="Requests" trend={<svg data-testid="bars" />} value="8" />);
    const slot = screen.getByTestId("bars").closest('[data-slot="stat-trend"]');
    expect(slot).not.toHaveAttribute("data-placement");
    expect(slot).toHaveClass("h-7");
    expect(screen.getByText("8").className).not.toMatch(/stat-row/);
  });

  it("keeps the value's line height at its font size", () => {
    renderWithProviders(<StatTile label="Requests" value="8" />);
    expect(screen.getByText("8")).toHaveClass("text-display", "leading-none");
  });

  it("reserves the aside slot in the loading skeleton", () => {
    const { container } = renderWithProviders(
      <StatTile label="Requests" loading trendPlacement="aside" value="8" />,
    );
    const skeleton = container.querySelector('[data-slot="stat-card-skeleton"]');
    const slot = skeleton?.querySelector('[data-placement="aside"]');
    expect(slot).toHaveClass("h-12");
  });

  it("shows a label hint", async () => {
    const { user } = renderWithProviders(
      <StatTile hint="Accounts that served a request" label="Active accounts" value="3 / 8" />,
    );
    await user.hover(screen.getByRole("button", { name: /Active accounts/ }));
    expect(await screen.findByText("Accounts that served a request")).toBeInTheDocument();
  });
});

describe("StatGroup", () => {
  it("joins KPI tiles into one card by default", () => {
    const { container } = renderWithProviders(
      <StatGroup aria-label="Totals">
        <StatTile icon={UsersIcon} label="Accounts" value="8" />
        <StatTile icon={UsersIcon} label="Requests" value="1,024" />
      </StatGroup>,
    );
    const card = container.querySelector('[data-slot="stat-group-card"]');
    expect(card).toHaveAttribute("aria-label", "Totals");
    expect(card?.querySelectorAll('[data-slot="stat-tile"]')).toHaveLength(2);
    expect(container.querySelector('[data-slot="stat-card"]')).not.toBeInTheDocument();
  });

  it("draws live tiles as separate cards by default", () => {
    const { container } = renderWithProviders(
      <StatGroup columns="live">
        <StatTile label="Requests/min" size="kpi" value="12" />
        <StatTile label="Error rate" size="kpi" value="0%" />
      </StatGroup>,
    );
    expect(container.querySelector('[data-slot="stat-group-card"]')).not.toBeInTheDocument();
    const group = container.querySelector('[data-slot="stat-group"]');
    expect(group).not.toHaveAttribute("data-joined");
    expect(group?.querySelectorAll('[data-slot="stat-tile"]')).toHaveLength(2);
  });

  it("follows an explicit joined switch", () => {
    const { container } = renderWithProviders(
      <StatGroup columns="live" joined>
        <StatTile label="Requests/min" size="kpi" value="12" />
      </StatGroup>,
    );
    expect(container.querySelector('[data-slot="stat-group-card"]')).toBeInTheDocument();
  });

  it("renders a loading tile in place inside the group", () => {
    const { container } = renderWithProviders(
      <StatGroup>
        <StatTile label="Accounts" loading value="8" />
      </StatGroup>,
    );
    const group = container.querySelector('[data-slot="stat-group"]');
    expect(group?.querySelector('[data-slot="stat-card-skeleton"]')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="stat-card"]')).not.toBeInTheDocument();
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
