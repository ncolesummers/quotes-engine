import { basename, extname, join, resolve } from "node:path";
import type { ExtractionFile } from "./schema";

export interface ExtractionPromptOptions {
  /** Batch file to process, e.g. `data/extractions/todo/batch-007.json`. */
  batchPath: string;
  /** Where the agent writes its results, e.g. `data/extractions/batch-007.json`. */
  outPath: string;
}

/**
 * Example output embedded in the prompt. A test checks that it is valid against
 * `ExtractionFileSchema`, so the prompt can't drift from what `import:extractions` accepts.
 */
export const EXAMPLE_OUTPUT: ExtractionFile = {
  results: [
    {
      ig_media_id: "17890000000000001",
      quotes: [
        {
          text: "Quote text from the image, transcribed exactly.",
          author: "Joe Abercrombie",
          source: "The First Law",
          found_in: "image",
          confidence: 0.9,
        },
      ],
      no_quote: false,
    },
    {
      ig_media_id: "17890000000000002",
      quotes: [
        {
          text: "First quote, from the first carousel image.",
          author: "Robin Hobb",
          source: "Fool's Errand",
          found_in: "image",
          confidence: 0.95,
        },
        {
          text: "Second quote, from the second carousel image.",
          author: "Robin Hobb",
          source: "Fool's Errand",
          found_in: "both",
          confidence: 0.85,
        },
      ],
      no_quote: false,
    },
    { ig_media_id: "17890000000000003", quotes: [], no_quote: true },
  ],
};

/**
 * Where the result for a batch goes: `<extractionsDir>/<batch-name>.json`, read by
 * `import:extractions`. Throws when that is the batch path itself (e.g. a result file was passed
 * instead of a `todo/` batch), since the agent would overwrite its own input.
 */
export function outPathForBatch(batchPath: string, extractionsDir: string): string {
  const outPath = join(extractionsDir, basename(batchPath));
  if (resolve(outPath) === resolve(batchPath)) {
    throw new Error(
      `${batchPath} is a result path; the agent would overwrite it. Pass a batch from todo/.`,
    );
  }
  return outPath;
}

/**
 * Attribution rules shared with the classification prompt (`classification-prompt.ts`): caption
 * formats, hashtag decoding and process tags. Each line is a list item indented under a step.
 */
export const ATTRIBUTION_RULES = `   - If the caption uses the \`📖 Title — Author\` format (also \`📖 Title · Author\`), take \`source\` = Title and \`author\` = Author from it.
   - Otherwise most captions give the author and book only as hashtags. Turn them back into proper names: \`#joeabercrombie\` → "Joe Abercrombie", \`#thefirstlaw\` → "The First Law", \`#jamessacorey\` → "James S. A. Corey", \`#theexpanse\` → "The Expanse", \`#harukimurakami\` → "Haruki Murakami", \`#kafkaontheshore\` → "Kafka on the Shore". Use the real, correctly spelled and capitalized name of the person or book.
   - An attribution printed in the image counts too.
   - Set \`source\` only when a book or series is clearly named (by a tag, the caption or the image). Otherwise use null. Use null for \`author\` when nothing names one.
   - **Ignore process/tool tags**: \`#pythonimaginglibrary\`, \`#p5js\`, \`#gnuterrypratchett\` and generic tags (\`#quote\`, \`#books\`, \`#reading\`, \`#bookstagram\`, ...) are never an author or a source.`;

/** The account's own commentary is not a quote (shared with the classification prompt). */
export const COMMENTARY_RULE = `**The account's own commentary is not a quote.** Short captions like "Find your joy wherever you can." are usually the poster's comment; the quote is then in the image. Only record text that is quoted from a book, person or other work.`;

/** Posts without a quote (shared with the classification prompt). */
export const NON_QUOTE_RULE = `**Non-quote posts** (e.g. "Wine ❤️", thanking someone for a mug, a photo with no quoted text) get \`"quotes": []\` and \`"no_quote": true\`.`;

function compactExample(): string {
  // One result per line keeps the example short but readable.
  const lines = EXAMPLE_OUTPUT.results.map((r) => `  ${JSON.stringify(r)}`);
  return `{"results": [\n${lines.join(",\n")}\n]}`;
}

function renderPrompt(batchPath: string, outPath: string, batch: string): string {
  return `You are extracting quotes from Instagram posts for a personal quote catalog. Process ONE batch file and write ONE result file. You have two tools: Read (it shows you images) and Write.

## Input

Read the batch file:

    ${batchPath}

It looks like \`{"posts": [{"ig_media_id", "posted_at", "caption", "media_paths": [...]}]}\`. \`caption\` may be null. \`media_paths\` are absolute paths to the post's images; carousels have several (\`<id>_1.jpg\`, \`<id>_2.jpg\`, ...).

## For every post

1. **Read every image** in \`media_paths\` with the Read tool, one by one. Do not skip any: on a carousel each image can carry a different quote. Most quotes are in the image, not the caption. If any image cannot be read (the Read fails, or it shows nothing), leave the post out of \`results\` entirely, so it stays queued for a later run. Do not mark it \`no_quote\`.
2. Read the caption. The quote may be in the image, the caption, or both. Set \`found_in\` to \`"image"\`, \`"caption"\` or \`"both"\` accordingly.
3. **Transcribe the quote exactly** as written: keep the original wording, punctuation, quotation marks, dashes, ellipses and capitalization. Do not paraphrase, fix, translate or complete it. Join lines that are only wrapped for layout into one line; keep real paragraph breaks as \`\\n\`. Leave out decorative quote marks around the whole quote and the attribution line (e.g. "— Stephen King").
4. **Attribution (\`author\`, \`source\`)**:
${ATTRIBUTION_RULES}
5. ${COMMENTARY_RULE}
6. ${NON_QUOTE_RULE}
7. **Carousels may contain several quotes**: add one entry to \`quotes\` per distinct quote. If the same quote appears in the image and the caption, record it once with \`found_in: "both"\`.
8. **\`confidence\`** is a number from 0 to 1 for the whole entry (text and attribution). Use about 0.9–1 when the text is clearly legible and the attribution is explicit. Lower it (≤ 0.7) when the text is hard to read, cut off or stylized, or when the author/source is a guess (e.g. inferred from an ambiguous hashtag). Entries below 0.8 go to a human review queue, so be honest.

## Output

Write the result file with the Write tool to exactly this path:

    ${outPath}

It must be valid JSON matching this schema exactly — no extra keys, no comments, no Markdown fences in the file:

- \`"results"\`: an array with **one result per input post, in input order** (same \`ig_media_id\`s, none added). The only posts left out are those with an image you cannot read (step 1).
- Each result: \`"ig_media_id"\` (string, copied from the input), \`"quotes"\` (array), \`"no_quote"\` (boolean; true only when \`quotes\` is empty because the post has no quote).
- Each quote: \`"text"\` (non-empty string), \`"author"\` (string or null), \`"source"\` (string or null), \`"found_in"\` (\`"caption"\`, \`"image"\` or \`"both"\`), \`"confidence"\` (number 0–1).

Example (a single-image post, a carousel with two quotes, and a non-quote post):

\`\`\`json
${compactExample()}
\`\`\`

## When finished

Reply with exactly one line and nothing else, in this form:

    ${batch}: <posts> posts, <quotes> quotes, <no_quote> no_quote, <unreadable> unreadable

for example \`batch-007: 20 posts, 18 quotes, 2 no_quote, 0 unreadable\`, where \`<unreadable>\` counts the posts left out because an image could not be read.
`;
}

/** Full instructions for one agent processing one batch file. Paths are made absolute. */
export function buildExtractionPrompt({ batchPath, outPath }: ExtractionPromptOptions): string {
  return renderPrompt(
    resolve(batchPath),
    resolve(outPath),
    basename(batchPath, extname(batchPath)),
  );
}

/** Contents of `docs/extraction-prompt.md`, generated from the same template. */
export function renderExtractionPromptDoc(): string {
  return `<!-- Generated by \`bun run docs:prompt\` from src/ingest/extraction/prompt.ts. Do not edit by hand. -->

# Extraction prompt

This is the prompt each extraction subagent receives for one batch (see [runbook-backfill.md](runbook-backfill.md)). Print the real prompt for a batch, with absolute paths filled in, with:

    bun scripts/extraction-prompt.ts data/extractions/todo/batch-NNN.json

---

${renderPrompt(
  "/abs/path/to/data/extractions/todo/batch-NNN.json",
  "/abs/path/to/data/extractions/batch-NNN.json",
  "batch-NNN",
)}`;
}
