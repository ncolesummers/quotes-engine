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
 * Combining marks count as word characters so tags in scripts like Devanagari match whole.
 */
const HASHTAG_RUN_RE = /(?<![\p{L}\p{M}\p{N}_])(?:#[\p{L}\p{M}\p{N}_]+)+/gu;
const HASHTAG_RE = /#[\p{L}\p{M}\p{N}_]+/gu;

/**
 * Strip one hashtag run. Tags containing a letter are dropped. Numeric-only tags ("#1",
 * "#2026") are kept as text, so "#2026#wisdom" and "#2026 #wisdom" both leave "2026".
 */
function stripHashtagRun(run: string): string {
  return run.replace(HASHTAG_RE, (tag) => (/\p{L}/u.test(tag) ? " " : ` ${tag} `));
}

/** Opening quote marks whose closing partner hides separators in a quoted body. */
const QUOTE_PAIRS: Record<string, string> = {
  '"': '"',
  "\u201C": "\u201D",
  "\u201E": "\u201C",
  "\u00AB": "\u00BB",
};

/**
 * Index of the closing mark of a quoted body that opens the string, or -1. Single quotes are
 * excluded because they double as apostrophes.
 */
function quotedBodyEnd(s: string): number {
  const close = QUOTE_PAIRS[s.charAt(0)];
  return close ? s.lastIndexOf(close) : -1;
}

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
 * Separators inside a quoted body that opens the string ("Choose - Love, not hate.") are
 * ignored. The rest are tried left to right and the first one that yields a valid
 * attribution wins, so separators inside a comma-delimited source ("Seneca, Letters -
 * Book II") stay in the source. A separator is valid when:
 * - the author (text after it, up to the first comma) looks like a name and contains no
 *   other separator, and
 * - it follows a closing quote / sentence end, or is preceded by whitespace in mixed-case
 *   text. An unspaced dash between words, or a spaced dash in all-caps text, is ambiguous
 *   and left in place.
 * Surrounding quote marks are removed from the returned text.
 */
export function parseAttribution(s: string): Attribution {
  const trimmed = s.trim();
  const bodyEnd = quotedBodyEnd(trimmed);
  const separators = [...trimmed.matchAll(SEPARATOR_RE)].filter((m) => m.index > bodyEnd);
  const caseInformative = /\p{Ll}/u.test(trimmed);

  for (const sep of separators) {
    const sepEnd = sep.index + sep[0].length;
    const commaAt = trimmed.indexOf(",", sepEnd);
    const authorEnd = commaAt === -1 ? trimmed.length : commaAt;
    if (separators.some((other) => other.index >= sepEnd && other.index < authorEnd)) continue;

    const head = trimmed.slice(0, sep.index).trim();
    const author = trimmed.slice(sepEnd, authorEnd).trim();
    const source = commaAt === -1 ? "" : trimmed.slice(commaAt + 1).trim();
    const strongHead = STRONG_HEAD_END_RE.test(head);
    const spacedBefore = /\s$/.test(trimmed.slice(0, sep.index));

    if (head && looksLikeAuthor(author) && (strongHead || (spacedBefore && caseInformative))) {
      const result: Attribution = { text: stripSurroundingQuotes(head), author };
      if (source) result.source = source;
      return result;
    }
  }

  return { text: stripSurroundingQuotes(trimmed) };
}

/**
 * Canonical form of a quote for deduplication. Before NFKC: fold U+00B4 to an apostrophe
 * (NFKC would decompose it into a space + combining accent) and remove emoji (NFKC turns
 * some, like U+2139 and U+2122, into letters). Then NFKC, hashtags removed, attribution
 * stripped, smart punctuation folded to ASCII, lowercased, punctuation removed (apostrophes
 * dropped, everything else becomes a space), whitespace collapsed.
 */
export function normalizeQuote(s: string): string {
  const cleaned = collapseWhitespace(
    s
      .replace(/\u00B4/g, "'")
      .replace(EMOJI_RE, " ")
      .normalize("NFKC")
      .replace(HASHTAG_RUN_RE, stripHashtagRun),
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
