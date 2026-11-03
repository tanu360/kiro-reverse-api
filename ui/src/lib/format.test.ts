import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatCompact,
  formatCredits,
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
    expect(formatDurationMs(999, true)).toBe("999 ms");
    expect(formatDurationMs(1840, true)).toBe("1.84 s");
    expect(formatDurationMs(12_500, true)).toBe("12.5 s");
    expect(formatDurationMs(125_000, true)).toBe("2m 5s");
  });

  it("shows — for legacy rows and 0 ms for real instant requests", () => {
    expect(formatDurationMs(undefined, false)).toBe("—");
    expect(formatDurationMs(0, true)).toBe("0 ms");
  });
});

describe("other formatters", () => {
  it("formats bytes with one decimal", () => {
    expect(formatBytes(48_213)).toBe("47.1 KB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("formats numbers, fractions, credits and dollars", () => {
    expect(formatNumber(1_234_567.9)).toBe("1,234,567");
    expect(formatFraction(0.1234)).toBe("12.3%");
    expect(formatCredits(1.2)).toBe("1.20");
    expect(formatCredits(1.25, 1)).toBe("1.3");
    expect(formatUsd(1.2)).toBe("$1.20");
  });

  it("formats uptime", () => {
    expect(formatUptime(3 * 86_400 + 4 * 3600 + 59, "en")).toBe("3 d 4 h");
    expect(formatUptime(4 * 3600 + 12 * 60, "en")).toBe("4 h 12 min");
    expect(formatUptime(12 * 60 + 30, "en")).toBe("12 min");
    expect(formatUptime(4 * 3600 + 12 * 60, "zh")).toBe("4 小时 12 分钟");
  });

  it("formats relative time", () => {
    const now = 1_800_000_000_000;
    expect(formatRelativeTime(now / 1000 - 5 * 60, "en", now)).toBe("5 minutes ago");
    expect(formatRelativeTime(now / 1000 + 3 * 86_400, "en", now)).toBe("in 3 days");
    expect(formatRelativeTime(now / 1000 - 86_400, "en", now)).toBe("yesterday");
  });
});
