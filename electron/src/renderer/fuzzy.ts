// Subsequence fuzzy matching for the command palette, as macOS Vibex has it (Palette/FuzzyMatch.swift): every
// character of the query must appear in order. Matches at word starts and in runs score higher, so "obt" ranks
// "Open Browser Tab" first.

export interface Match { score: number; positions: number[] }

const isWordStart = (chars: string[], i: number): boolean => {
  if (i === 0) return true;
  const prev = chars[i - 1];
  const cur = chars[i];
  if (!/[\p{L}\p{N}]/u.test(prev)) return true;
  return prev === prev.toLowerCase() && prev !== prev.toUpperCase() && cur === cur.toUpperCase() && cur !== cur.toLowerCase();
};

export function fuzzyMatch(query: string, candidate: string): Match | null {
  const needle = [...query.toLowerCase()].filter((c) => !/\s/.test(c));
  if (!needle.length) return { score: 0, positions: [] };
  const original = [...candidate];
  const hay = [...candidate.toLowerCase()];
  if (hay.length !== original.length) return null;
  const positions: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const ch of needle) {
    // Prefer the next occurrence that starts a word or continues a run; else the next occurrence.
    let chosen = -1;
    for (let i = from; i < hay.length; i++) {
      if (hay[i] !== ch) continue;
      if (chosen < 0) chosen = i;
      if (isWordStart(original, i) || i === previous + 1) { chosen = i; break; }
    }
    if (chosen < 0) return null;
    score += 1;
    if (chosen === previous + 1) score += 6;
    if (isWordStart(original, chosen)) score += 8;
    if (chosen === 0) score += 4;
    positions.push(chosen);
    previous = chosen;
    from = chosen + 1;
  }
  score -= positions[0] ?? 0;
  score -= Math.floor(Math.max(0, hay.length - needle.length) / 8);
  return { score, positions };
}

/// Ranks candidates by score and keeps the matches. Equal scores keep their order.
export function rank<T>(items: T[], query: string, text: (item: T) => string): { item: T; match: Match }[] {
  return items
    .map((item, order) => ({ item, order, match: fuzzyMatch(query, text(item)) }))
    .filter((r): r is { item: T; order: number; match: Match } => r.match !== null)
    .sort((a, b) => b.match.score - a.match.score || a.order - b.order)
    .map(({ item, match }) => ({ item, match }));
}
