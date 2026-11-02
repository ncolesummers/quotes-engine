/** Emoji and the joiners/selectors that glue them (NFKC would turn some into letters). */
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️|⃣/gu;

/**
 * One part of a book key: emoji removed, NFKC, `&` spelled out as "and", smart apostrophes
 * folded to `'`, lowercased, other punctuation turned into spaces, whitespace collapsed.
 * Apostrophes are kept so "Fool's Errand" reads naturally as `fool's errand`. Null when
 * nothing is left.
 */
function keyPart(s: string | null | undefined): string | null {
  if (!s) return null;
  const part = s
    .replace(EMOJI_RE, " ")
    .normalize("NFKC")
    .replace(/&/g, " and ")
    .replace(/[‘’‚‛′`´]/g, "'")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}'\s]/gu, " ")
    .replace(/(^|\s)'+|'+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return part || null;
}

/** The normalized title alone, as used for title-only keys. Null for an empty title. */
export function bookTitleKey(title: string | null | undefined): string | null {
  return keyPart(title);
}

/**
 * Dedup key for a book: `title|author` (e.g. `fool's errand|robin hobb`), or just the title
 * when the author is unknown. Null when the title is empty.
 */
export function bookKey(title: string | null | undefined, author?: string | null): string | null {
  const t = keyPart(title);
  if (!t) return null;
  const a = keyPart(author);
  return a ? `${t}|${a}` : t;
}
