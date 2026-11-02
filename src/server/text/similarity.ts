import { normalizeQuote } from "./normalize";

export type MatchClass = "same" | "likely" | "different";

/** Scores at or above this are treated as the same quote. */
export const SAME_THRESHOLD = 0.97;
/** Scores at or above this (but below SAME_THRESHOLD) are likely the same quote. */
export const LIKELY_THRESHOLD = 0.85;

/** Character trigrams of an already-normalized string, padded with a space on each side. */
export function trigrams(s: string): Set<string> {
  const padded = ` ${s} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) grams.add(padded.slice(i, i + 3));
  return grams;
}

/** Jaccard similarity of two trigram sets (see `trigrams`). */
export function jaccard(ga: Set<string>, gb: Set<string>): number {
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return shared / (ga.size + gb.size - shared);
}

/**
 * Jaccard similarity (0..1) over character trigrams of the normalized strings.
 * Two strings that normalize to the same value (including both empty) score 1.
 */
export function trigramSimilarity(a: string, b: string): number {
  return normalizedSimilarity(normalizeQuote(a), normalizeQuote(b));
}

/**
 * Like `trigramSimilarity`, for strings already passed through `normalizeQuote` (e.g. stored
 * `normalized_text`), skipping the normalization cost when scanning many candidates.
 */
export function normalizedSimilarity(na: string, nb: string): number {
  if (na === nb) return 1;
  if (!na || !nb) return 0;
  return jaccard(trigrams(na), trigrams(nb));
}

export function classifyMatch(score: number): MatchClass {
  if (score >= SAME_THRESHOLD) return "same";
  if (score >= LIKELY_THRESHOLD) return "likely";
  return "different";
}
