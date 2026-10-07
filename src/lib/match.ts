// Fuzzy matching of a spoken/typed guess against article titles.

import type { Entry } from '../shared/types.js';

export type Strength = 'exact' | 'close' | 'partial';

export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // drop "(qualifier)"
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

const STRENGTH: Record<Strength, number> = { exact: 3, close: 2, partial: 1 };

function compare(g: string, t: string): Strength | null {
  if (!g || !t) return null;
  if (g === t || g.replace(/ /g, '') === t.replace(/ /g, '')) return 'exact';
  const tol = g.length < 5 ? 0 : g.length < 10 ? 1 : 2;
  if (tol && levenshtein(g, t) <= tol) return 'close';
  // "abu ghraib" vs "abu ghraib torture and prisoner abuse"
  const gw = g.split(' ');
  if (t.startsWith(g + ' ') && (gw.length >= 2 || g.length >= 0.6 * t.length) && g.length >= 4) return 'partial';
  return null;
}

/**
 * Find the entry a guess most likely refers to.
 * Returns { entry, strength: 'exact'|'close'|'partial' } or null.
 * Stronger matches win; ties go to the higher-ranked entry.
 */
export function matchGuess(guess: string, entries: Entry[]): { entry: Entry; strength: Strength } | null {
  const g = normalize(guess);
  if (!g) return null;
  let best: { entry: Entry; strength: Strength } | null = null;
  for (const e of entries) {
    for (const name of [e.title, ...e.members, ...e.aliases]) {
      const s = compare(g, normalize(name));
      if (!s) continue;
      if (!best || STRENGTH[s] > STRENGTH[best.strength] || (STRENGTH[s] === STRENGTH[best.strength] && e.rank < best.entry.rank)) {
        best = { entry: e, strength: s };
      }
    }
  }
  return best;
}

/** Does the guess start with the round's letters (ignoring a leading "The")? */
export function startsWithLetters(guess: string, letters: string): boolean {
  const raw = guess.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const l = letters.toLowerCase();
  return raw.startsWith(l) || normalize(guess).replace(/ /g, '').startsWith(l);
}
