import { normalizeQuote } from "./normalize";

export type MatchClass = "same" | "likely" | "different";

/** Scores at or above this are treated as the same quote. */
export const SAME_THRESHOLD = 0.97;
/** Scores at or above this (but below SAME_THRESHOLD) are likely the same quote. */
export const LIKELY_THRESHOLD = 0.85;

function trigrams(s: string): Set<string> {
  const padded = ` ${s} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) grams.add(padded.slice(i, i + 3));
  return grams;
}

/**
 * Jaccard similarity (0..1) over character trigrams of the normalized strings.
 * Two strings that normalize to the same value (including both empty) score 1.
 */
export function trigramSimilarity(a: string, b: string): number {
  const na = normalizeQuote(a);
  const nb = normalizeQuote(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;

  const ga = trigrams(na);
  const gb = trigrams(nb);
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return shared / (ga.size + gb.size - shared);
}

export function classifyMatch(score: number): MatchClass {
  if (score >= SAME_THRESHOLD) return "same";
  if (score >= LIKELY_THRESHOLD) return "likely";
  return "different";
}
