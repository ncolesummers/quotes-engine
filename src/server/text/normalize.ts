/** A quote split from a trailing "-- Author, Source" attribution. */
export interface Attribution {
  text: string;
  author?: string;
  source?: string;
}

const QUOTE_MARKS = "\"'\u201C\u201D\u2018\u2019\u201E\u201A\u00AB\u00BB\u2039\u203A`\u00B4";

/** Max words allowed in an author name before we stop treating the tail as an attribution. */
const MAX_AUTHOR_WORDS = 5;

/** Lowercase words allowed inside an otherwise capitalized author name. */
const NAME_PARTICLES = new Set([
  "de",
  "da",
  "di",
  "del",
  "der",
  "du",
  "van",
  "von",
  "la",
  "le",
  "bin",
  "ibn",
  "al",
]);

/** A head ending in a closing quote or sentence end makes the following separator unambiguous. */
const STRONG_HEAD_END_RE = /["'\u201D\u2019\u00BB.!?]$/;

/**
 * Attribution separators: em/en/horizontal-bar dashes and tildes anywhere, `--` anywhere,
 * and a single hyphen only when preceded by whitespace/quote and followed by whitespace
 * (so intra-word hyphens like "well-known" never split).
 */
const SEPARATOR_RE =
  /[\u2014\u2013\u2015~]|--|(?<=[\s"'\u201C\u201D\u2018\u2019\u00AB\u00BB])-(?=\s)/g;

/**
 * Runs of Instagram-style hashtags not glued to a preceding word character (so "C#" is kept).
 * Each tag must contain a letter, so "#1" is kept as text.
 */
const HASHTAG_RE = /(?<![\p{L}\p{N}_])(?:#[\p{N}_]*\p{L}[\p{L}\p{N}_]*)+/gu;

/** Keycap sequences ("1" + U+FE0F + U+20E3), emoji, and the joiners/selectors that glue emoji. */
const EMOJI_RE =
  /[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200D|\uFE0F|\u20E3/gu;

const ASCII_FOLDS: Array<[RegExp, string]> = [
  [/[\u2018\u2019\u201A\u201B\u2032`]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"'],
  [/[\u2010-\u2015\u2212]/g, "-"],
];

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function stripSurroundingQuotes(s: string): string {
  if (
    s.length >= 2 &&
    QUOTE_MARKS.includes(s.charAt(0)) &&
    QUOTE_MARKS.includes(s.charAt(s.length - 1))
  ) {
    return s.slice(1, -1).trim();
  }
  return s;
}

/** Every word capitalized (name particles aside) and short enough to be a name. */
function looksLikeAuthor(author: string): boolean {
  const words = author.split(/\s+/);
  return (
    words.length <= MAX_AUTHOR_WORDS &&
    words.every((w, i) => /^\p{Lu}/u.test(w) || (i > 0 && NAME_PARTICLES.has(w)))
  );
}

/**
 * Split a trailing attribution ("-- Author", "~ Author", "- Author, Source") off a quote.
 *
 * Only the last separator is considered. The author (text after it, up to the first comma)
 * must look like a name, and the separator must either follow a closing quote / sentence
 * end, or be preceded by whitespace in mixed-case text. An unspaced dash between words, or a
 * spaced dash in all-caps text, is ambiguous and left in place. Surrounding quote marks are
 * removed from the returned text.
 */
export function parseAttribution(s: string): Attribution {
  const trimmed = s.trim();
  const last = [...trimmed.matchAll(SEPARATOR_RE)].at(-1);

  if (last) {
    const head = trimmed.slice(0, last.index).trim();
    const tail = trimmed.slice(last.index + last[0].length).trim();
    const commaAt = tail.indexOf(",");
    const author = (commaAt === -1 ? tail : tail.slice(0, commaAt)).trim();
    const source = commaAt === -1 ? "" : tail.slice(commaAt + 1).trim();

    const strongHead = STRONG_HEAD_END_RE.test(head);
    const spacedBefore = /\s$/.test(trimmed.slice(0, last.index));
    const caseInformative = /\p{Ll}/u.test(trimmed);

    if (head && looksLikeAuthor(author) && (strongHead || (spacedBefore && caseInformative))) {
      const result: Attribution = { text: stripSurroundingQuotes(head), author };
      if (source) result.source = source;
      return result;
    }
  }

  return { text: stripSurroundingQuotes(trimmed) };
}

/**
 * Canonical form of a quote for deduplication: NFKC (after folding U+00B4 to an apostrophe,
 * which NFKC would otherwise decompose into a space + combining accent), emoji/hashtags
 * removed, attribution stripped, smart punctuation folded to ASCII, lowercased, punctuation
 * removed (apostrophes dropped, everything else becomes a space), whitespace collapsed.
 */
export function normalizeQuote(s: string): string {
  const cleaned = collapseWhitespace(
    s
      .replace(/\u00B4/g, "'")
      .normalize("NFKC")
      .replace(HASHTAG_RE, " ")
      .replace(EMOJI_RE, ""),
  );
  let text = parseAttribution(cleaned).text;
  for (const [re, replacement] of ASCII_FOLDS) text = text.replace(re, replacement);
  return collapseWhitespace(
    text
      .toLowerCase()
      .replace(/'/g, "")
      .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " "),
  );
}
