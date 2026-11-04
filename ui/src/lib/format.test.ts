import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatCompact,
  formatCredits,
  formatCreditsExact,
  formatDurationMs,
  formatFraction,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatUptime,
  formatUsd,
} from "./format";

describe("formatCompact", () => {
  it("uses K/M/B with one decimal and drops .0", () => {
    expect(formatCompact(1000)).toBe("1K");
    expect(formatCompact(1234)).toBe("1.2K");
    expect(formatCompact(1_234_567)).toBe("1.2M");
    expect(formatCompact(2_000_000_000)).toBe("2B");
    expect(formatCompact(999)).toBe("999");
  });
});

describe("formatPercent", () => {
  it("uses 1 decimal from 10 % up and 2 below, trailing zeros dropped", () => {
    expect(formatPercent(1, 3)).toBe("33.3%");
    expect(formatPercent(1, 200)).toBe("0.5%");
    expect(formatPercent(1, 4)).toBe("25%");
    expect(formatPercent(0, 0)).toBe("0%");
  });
});

describe("formatDurationMs", () => {
  it("formats ms, seconds and minutes like the old UI", () => {
    expect(formatDurationMs(999, true)).toBe("999ms");
    expect(formatDurationMs(1840, true)).toBe("1.84s");
    expect(formatDurationMs(12_500, true)).toBe("12.5s");
    expect(formatDurationMs(125_000, true)).toBe("2m 5s");
    // Rounded before the unit is picked: never "60.0 s".
    expect(formatDurationMs(59_960, true)).toBe("1m 0s");
  });

  it("shows — for legacy rows and 0 ms for real instant requests", () => {
    expect(formatDurationMs(undefined, false)).toBe("—");
    expect(formatDurationMs(0, true)).toBe("0ms");
  });
});

describe("other formatters", () => {
  it("formats bytes with one decimal", () => {
    expect(formatBytes(48_213)).toBe("47.1 kB");
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    // Never "1,024.0 kB".
    expect(formatBytes(1_048_575)).toBe("1.0 MB");
  });

  it("formats numbers, fractions, credits and dollars", () => {
    expect(formatNumber(1_234_567.9)).toBe("1,234,567");
    expect(formatFraction(0.1234)).toBe("12.3%");
    expect(formatCredits(1.2)).toBe("1.20");
    expect(formatCredits(1.25, 1)).toBe("1.3");
    expect(formatUsd(1.2)).toBe("$1.20");
  });

  it("shows a tiny non-zero credit amount as below the smallest step, never as zero", () => {
    expect(formatCredits(0.0001)).toBe("<0.01");
    expect(formatCredits(0.004)).toBe("<0.01");
    expect(formatCredits(0.005)).toBe("0.01");
    expect(formatCredits(0.00001, 4)).toBe("<0.0001");
    expect(formatCredits(0.0001, 4)).toBe("0.0001");
    expect(formatCredits(0.0001, 2, "pt-BR")).toBe("<0,01");
    expect(formatCredits(0)).toBe("0.00");
    expect(formatCreditsExact(0.0001)).toBe("0.0001");
    expect(formatCreditsExact(0.000123456789)).toBe("0.000123457");
  });

  it("formats uptime", () => {
    expect(formatUptime(3 * 86_400 + 4 * 3600 + 59, "en")).toBe("3d 4h");
    expect(formatUptime(4 * 3600 + 12 * 60, "en")).toBe("4h 12m");
    expect(formatUptime(12 * 60 + 30, "en")).toBe("12m");
    expect(formatUptime(4 * 3600 + 12 * 60, "zh")).toBe("4小时 12分钟");
    expect(formatUptime(4 * 3600 + 12 * 60, "vi")).toBe("4 giờ 12 phút");
    expect(formatUptime(3 * 86_400 + 4 * 3600, "pt-BR")).toBe("3 dias 4 h");
  });

  it("formats relative time", () => {
    const now = 1_800_000_000_000;
    expect(formatRelativeTime(now / 1000 - 5 * 60, "en", now)).toBe("5 minutes ago");
    expect(formatRelativeTime(now / 1000 + 3 * 86_400, "en", now)).toBe("in 3 days");
    expect(formatRelativeTime(now / 1000 - 86_400, "en", now)).toBe("yesterday");
  });
});

describe("locale-aware formatting", () => {
  it("formats numbers, percents and money in Vietnamese and Brazilian Portuguese", () => {
    expect(formatNumber(1_234_567.9, "vi")).toBe("1.234.567");
    expect(formatNumber(1_234_567.9, "pt-BR")).toBe("1.234.567");
    expect(formatCompact(1234, "pt-BR")).toBe("1,2\u00a0mil");
    expect(formatCompact(1234, "zh")).toBe("1234");
    expect(formatPercent(1, 3, "vi")).toBe("33,3%");
    expect(formatCredits(1234.5, 2, "pt-BR")).toBe("1.234,50");
    expect(formatUsd(1.2, "pt-BR")).toBe("US$\u00a01,20");
    expect(formatBytes(48_213, "vi")).toBe("47,1 kB");
  });

  it("formats durations and relative time with the language's units", () => {
    const now = 1_800_000_000_000;
    expect(formatDurationMs(1840, true, "pt-BR")).toBe("1,84 s");
    expect(formatDurationMs(125_000, true, "vi")).toBe("2 phút 5 giây");
    expect(formatRelativeTime(now / 1000 - 5 * 60, "pt-BR", now)).toBe("há 5 minutos");
    expect(formatRelativeTime(now / 1000 - 5 * 60, "vi", now)).toBe("5 phút trước");
    expect(formatRelativeTime(now / 1000 - 5 * 60, "zh", now)).toBe("5分钟前");
  });

  it("formats the pseudo language like English", () => {
    expect(formatNumber(1234, "pseudo")).toBe("1,234");
  });
});
