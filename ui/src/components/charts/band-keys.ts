/**
 * One band-scale key per bar, in order. A band domain keeps one band per distinct value, so two
 * bars with the same label (the hour that repeats when clocks go back) would share a band and
 * draw over each other. A repeat gets its occurrence appended; every other bar keys on its label,
 * so keys only change where labels repeat.
 */
export function bandKeys(labels: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const count = seen.get(label) ?? 0;
    seen.set(label, count + 1);
    return count === 0 ? label : `${label}\u0000${count}`;
  });
}
