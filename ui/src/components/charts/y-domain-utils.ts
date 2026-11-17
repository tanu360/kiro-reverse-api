export type YDomain = [number, number];

interface NumericExtents {
  minValue: number;
  maxValue: number;
}

/** Min / max over every numeric `dataKeys` value. `{ 0, 100 }` when none are numeric. */
function collectNumericExtents(
  data: Record<string, unknown>[],
  dataKeys: string[],
): NumericExtents {
  let minValue = Number.POSITIVE_INFINITY;
  let maxValue = Number.NEGATIVE_INFINITY;

  for (const d of data) {
    for (const key of dataKeys) {
      const value = d[key];
      if (typeof value === "number") {
        if (value < minValue) {
          minValue = value;
        }
        if (value > maxValue) {
          maxValue = value;
        }
      }
    }
  }

  if (minValue === Number.POSITIVE_INFINITY) {
    return { minValue: 0, maxValue: 100 };
  }

  return { minValue, maxValue };
}

/**
 * Value extents for bar series. Stacked bars use the running totals (always
 * including the zero baseline) so the domain reaches every segment end;
 * grouped bars use the individual values.
 */
export function collectBarValueExtents(
  data: Record<string, unknown>[],
  dataKeys: string[],
  stacked: boolean,
): NumericExtents {
  if (!stacked) {
    return collectNumericExtents(data, dataKeys);
  }
  let minValue = 0;
  let maxValue = 0;
  for (const d of data) {
    let sum = 0;
    for (const key of dataKeys) {
      const value = d[key];
      if (typeof value === "number") {
        sum += value;
        minValue = Math.min(minValue, sum);
        maxValue = Math.max(maxValue, sum);
      }
    }
  }
  return { minValue, maxValue };
}

/**
 * Bar value-axis domain. Bars grow from zero, so the domain always includes
 * 0: `[0, max * 1.1]` while every value is >= 0 (falls back to `[0, 110]`
 * when there is no positive value), and a padded min..max stretched to
 * include zero once any value is negative.
 */
export function resolveBarValueDomain({ minValue, maxValue }: NumericExtents): YDomain {
  if (minValue >= 0) {
    return [0, (maxValue > 0 ? maxValue : 100) * 1.1];
  }

  const padding = (maxValue - minValue) * 0.05 || 1;
  return [Math.min(0, minValue - padding), Math.max(0, maxValue + padding)];
}
