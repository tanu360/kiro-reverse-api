import { describe, expect, it } from "vitest";
import "@/components/ui/messages";
import { translate } from "@/lib/i18n";
import { describeSparkline } from "./sparkline-geometry";

describe("describeSparkline", () => {
  it("keeps the English summary as the default", () => {
    expect(describeSparkline([2, 4, 9])).toBe("3 points, from 2 to 9, up 350%");
    expect(describeSparkline([])).toBe("No data");
  });

  it("reads the summary in the UI language", () => {
    const zh = (key: string, params?: Record<string, string | number>) =>
      translate("zh", "ui", key, params);
    expect(describeSparkline([2, 4, 9], zh, "zh-CN")).toBe("3 个数据点，从 2 到 9，上升 350%");
    expect(describeSparkline([8, 4], zh, "zh-CN")).toBe("2 个数据点，从 8 到 4，下降 50%");
    expect(describeSparkline([], zh, "zh-CN")).toBe("暂无数据");
  });
});
