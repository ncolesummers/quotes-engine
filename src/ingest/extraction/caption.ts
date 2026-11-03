/**
 * Caption text helpers for classification. The agent never writes quote text, so caption quotes
 * are cut out of the caption by code: either the whole stripped caption, or numbered segments.
 */

/**
 * The caption as quote text: hashtags, `📖 Title — Author` lines and spacer lines (only dots or
 * similar punctuation) removed, whitespace tidied, paragraph breaks kept. `""` when nothing is left.
 */
export function stripCaption(caption: string | null): string {
  if (!caption) return "";
  const lines = caption.split(/\r?\n/).map((line) => {
    if (line.trim().startsWith("📖")) return "";
    const cleaned = line
      .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, "$1")
      .replace(/[ \t]+/g, " ")
      .trim();
    return /^[.·•\-_~*]*$/u.test(cleaned) ? "" : cleaned;
  });
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The stripped caption split into referenceable segments: each “curly-quoted” span (or a
 * "straight-quoted" span within one line) is its own
 * segment (even across line breaks), and the rest is split by line. So a quote and the account's
 * commentary or an attribution on the same line can be told apart by number (`cap:L0`, ...).
 */
export function captionSegments(caption: string | null): string[] {
  return stripCaption(caption)
    .split(/(“[^”]*”|"[^"\n]*")/)
    .flatMap((token) => (/^[“"]/.test(token) ? [token.replace(/\s+/g, " ")] : token.split("\n")))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const QUOTE_PAIRS: [string, string][] = [
  ["“", "”"],
  ['"', '"'],
];

// Music notes posts put around lyrics (`🎵 … 🎵`, `♪ … ♪`), with any spacing (#42).
const OUTER_NOTES = /^[🎵🎶♪♫]+\s*([\s\S]*?)\s*[🎵🎶♪♫]+$/u;

/**
 * Remove quotation marks that wrap the whole text (and only then), and music notes wrapping a
 * lyric.
 */
export function stripOuterQuotes(text: string): string {
  const t = text.trim().replace(OUTER_NOTES, "$1");
  for (const [open, close] of QUOTE_PAIRS) {
    if (t.length < 2 || !t.startsWith(open) || !t.endsWith(close)) continue;
    const inner = t.slice(open.length, -close.length);
    if (!inner.includes(open) && !inner.includes(close)) return inner.trim();
  }
  return t;
}
