/**
 * Heuristics for spotting book records that need a human look (#34): titles that are
 * probably the same book, and titles that look like a series name. Hints only; nothing here
 * merges or edits anything.
 */
import { bookTitleKey } from "./book-key";
import { jaccard, trigrams } from "./similarity";

/** Title pairs scoring at least this (see `titleSimilarity`) are shown as possible duplicates. */
export const DUPLICATE_HINT_THRESHOLD = 0.6;

/** Score of a title whose words begin another title ("Sapiens" / "Sapiens: A Brief …"). */
const PREFIX_SCORE = 0.8;

/** A prefix match needs a shorter title of at least this many characters. */
const MIN_PREFIX_LENGTH = 4;

/** OCR and caption look-alikes: "1Q84" / "IQ84", "D0ne" / "Done". */
const LOOKALIKES: Record<string, string> = { "1": "i", l: "i", "0": "o" };

/**
 * The title as compared for duplicates: `bookTitleKey`, a leading article dropped, and
 * look-alike characters folded. "" for an empty title.
 */
function comparable(title: string | null | undefined): string {
  const key = bookTitleKey(title);
  if (!key) return "";
  return key
    .replace(/^(the|a|an)(\s|$)/, "")
    .replace(/[10l]/g, (c) => LOOKALIKES[c] ?? c)
    .trim();
}

function isWordPrefix(short: string, long: string): boolean {
  return short.length >= MIN_PREFIX_LENGTH && long.startsWith(`${short} `);
}

function score(a: string, b: string, ga: Set<string>, gb: Set<string>): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const fuzzy = jaccard(ga, gb);
  const prefix = isWordPrefix(a, b) || isWordPrefix(b, a);
  return prefix ? Math.max(fuzzy, PREFIX_SCORE) : fuzzy;
}

/**
 * How likely two titles name the same book, 0..1: 1 when they normalize alike (see
 * `comparable`), at least `PREFIX_SCORE` when one is the start of the other (a dropped
 * subtitle), else the trigram Jaccard similarity.
 */
export function titleSimilarity(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const ca = comparable(a);
  const cb = comparable(b);
  return score(ca, cb, trigrams(ca), trigrams(cb));
}

export interface TitleRecord {
  id: number;
  title: string | null;
}

export interface DuplicateHint {
  id: number;
  score: number;
}

/**
 * For each book, the other books whose titles score at least `DUPLICATE_HINT_THRESHOLD`
 * (best first, then by id). Books without a hint are absent from the map.
 */
export function findDuplicateHints(books: TitleRecord[]): Map<number, DuplicateHint[]> {
  const prepared = books
    .map((b) => {
      const c = comparable(b.title);
      return { id: b.id, c, grams: trigrams(c) };
    })
    .filter((b) => b.c !== "");
  const hints = new Map<number, DuplicateHint[]>();
  const add = (id: number, hint: DuplicateHint) => {
    const list = hints.get(id) ?? [];
    list.push(hint);
    hints.set(id, list);
  };
  for (let i = 0; i < prepared.length; i++) {
    const a = prepared[i];
    if (!a) continue;
    for (let j = i + 1; j < prepared.length; j++) {
      const b = prepared[j];
      if (!b) continue;
      const s = score(a.c, b.c, a.grams, b.grams);
      if (s < DUPLICATE_HINT_THRESHOLD) continue;
      add(a.id, { id: b.id, score: s });
      add(b.id, { id: a.id, score: s });
    }
  }
  for (const list of hints.values()) list.sort((x, y) => y.score - x.score || x.id - y.id);
  return hints;
}

/** Last words that usually name a series rather than one book. */
const SERIES_ENDING =
  /\b(series|saga|trilogy|duology|quartet|quintet|cycle|sequence|dynasty|archive|chronicles)$/;

/** Openings like "The Books of Babel" or "The Chronicles of Narnia". */
const SERIES_OPENING = /^(the )?(books|chronicles|tales) of\b/;

/** Series names that read like an ordinary title (normalized, see `bookTitleKey`). */
const KNOWN_SERIES = new Set([
  "the expanse",
  "the wheel of time",
  "a song of ice and fire",
  "discworld",
  "the realm of the elderlings",
  "the broken earth",
  "the locked tomb",
]);

/**
 * Whether a title looks like a series name ("The Wheel of Time", "The Red Queen's War"),
 * which usually means a caption credited the series instead of the book. A hint only.
 */
export function looksLikeSeries(title: string | null | undefined): boolean {
  const key = bookTitleKey(title);
  if (!key) return false;
  return (
    KNOWN_SERIES.has(key) ||
    SERIES_ENDING.test(key) ||
    SERIES_OPENING.test(key) ||
    // "The Red Queen's War"; "The Art of War" and "Caliban's War" are books.
    /^the .+'s war$/.test(key)
  );
}
