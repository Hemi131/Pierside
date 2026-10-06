// Distinct hues, ordered for maximum contrast between neighbours, readable on light and dark backgrounds.
const PALETTE = ["#3b82f6", "#16a34a", "#ea580c", "#c026d3", "#0891b2", "#dc2626", "#7c3aed", "#ca8a04", "#db2777", "#0d9488", "#4f46e5", "#65a30d"];

/**
 * Stable colours for a set of service names: assigned in sorted order, so each service keeps its
 * colour as long as the project's service set doesn't change (and neighbours never share a hue).
 */
export function serviceColors(names: Iterable<string>): Map<string, string> {
  const sorted = [...new Set(names)].sort();
  return new Map(sorted.map((n, i) => [n, PALETTE[i % PALETTE.length]]));
}
