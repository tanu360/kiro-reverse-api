import { describe, expect, it } from "vitest";
import { bucketLabel, bucketTitle } from "./time-buckets";

describe("time bucket labels", () => {
  // Midnight on 10 March 2026 in India (+05:30) is 18:30 UTC on the 9th.
  const istMidnight = Date.UTC(2026, 2, 9, 18, 30) / 1000;

  it("labels hours and days in the offset the server bucketed with", () => {
    expect(bucketLabel(istMidnight, "hour", 330, "en")).toMatch(/^12:00\sAM$/u);
    expect(bucketLabel(istMidnight, "day", 330, "en")).toBe("Mar 10");
    // The same instant in UTC is still the 9th.
    expect(bucketLabel(istMidnight, "day", 0, "en")).toBe("Mar 9");
  });

  it("titles an hour with its span and a day with its weekday", () => {
    expect(bucketTitle(istMidnight, "hour", 3600, 330, "en")).toMatch(/^12:00\sAM–1:00\sAM$/u);
    expect(bucketTitle(istMidnight, "day", 86400, 330, "en")).toBe("Tue, Mar 10");
  });

  it("labels the all-time weeks, months and years", () => {
    // Monday 9 March 2026, local midnight at UTC-05:00.
    const monday = Date.UTC(2026, 2, 9, 5) / 1000;
    expect(bucketLabel(monday, "week", -300, "en")).toBe("Mar 9");
    expect(bucketTitle(monday, "week", 604800, -300, "en")).toMatch(/^Mar 9\s–\s15, 2026$/u);
    // A week that runs into April names both months.
    const late = Date.UTC(2026, 2, 30, 5) / 1000;
    expect(bucketTitle(late, "week", 604800, -300, "en")).toMatch(/^Mar 30\s–\sApr 5, 2026$/u);

    const march = Date.UTC(2026, 2, 1) / 1000;
    expect(bucketLabel(march, "month", 0, "en")).toBe("Mar 2026");
    expect(bucketTitle(march, "month", 0, 0, "en")).toBe("March 2026");
    expect(bucketLabel(march, "year", 0, "en")).toBe("2026");
    expect(bucketTitle(march, "year", 0, 0, "en")).toBe("2026");
  });

  it("follows the language", () => {
    const march = Date.UTC(2026, 2, 1) / 1000;
    expect(bucketLabel(march, "month", 0, "zh")).toBe("2026年3月");
    expect(bucketTitle(march, "month", 0, 0, "pt-BR")).toBe("março de 2026");
    expect(bucketLabel(march, "day", 0, "vi")).toMatch(/1.*3|3.*1/u);
  });
});
