import { basename, extname, join, resolve } from "node:path";
import type { z } from "zod";
import type { ClassificationFileSchema } from "./classification-schema";
import { CLASSIFIED_SUBDIR } from "./classify-batches";
import { ATTRIBUTION_RULES, COMMENTARY_RULE, NON_QUOTE_RULE } from "./prompt";

export interface ClassificationPromptOptions {
  /** Batch file to process, e.g. `data/extractions/todo/batch-007.json`. */
  batchPath: string;
  /** Where the agent writes its result, e.g. `data/extractions/classified/batch-007.json`. */
  outPath: string;
}

/**
 * Example output embedded in the prompt. A test checks it parses with `ClassificationFileSchema`
 * and holds no quote text.
 */
export const CLASSIFICATION_EXAMPLE: z.input<typeof ClassificationFileSchema> = {
  results: [
    {
      ig_media_id: "17890000000000001",
      no_quote: false,
      quotes: [
        {
          image: 1,
          lines: [0, 4],
          from_caption: false,
          author: "Joe Abercrombie",
          source: "The First Law",
          confidence: 0.9,
        },
      ],
    },
    {
      ig_media_id: "17890000000000002",
      no_quote: false,
      quotes: [
        {
          image: 1,
          lines: [1, 3],
          from_caption: false,
          author: "Robin Hobb",
          source: "Fool's Errand",
          confidence: 0.95,
        },
        {
          image: 2,
          lines: [0, 2],
          from_caption: false,
          author: "Robin Hobb",
          source: "Fool's Errand",
          confidence: 0.85,
        },
      ],
    },
    {
      ig_media_id: "17890000000000003",
      no_quote: false,
      quotes: [
        {
          from_caption: true,
          caption_lines: [0, 0],
          author: "Haruki Murakami",
          source: "Kafka on the Shore",
          confidence: 0.8,
        },
      ],
    },
    { ig_media_id: "17890000000000004", no_quote: true, quotes: [] },
  ],
};

/**
 * Where the classification result for a batch goes: `<extractionsDir>/classified/<name>.json`,
 * read by `extract:assemble`. Throws when that is the batch path itself.
 */
export function classifiedPathForBatch(batchPath: string, extractionsDir: string): string {
  const outPath = join(extractionsDir, CLASSIFIED_SUBDIR, basename(batchPath));
  if (resolve(outPath) === resolve(batchPath)) {
    throw new Error(
      `${batchPath} is a result path; the agent would overwrite it. Pass a batch from todo/.`,
    );
  }
  return outPath;
}

function compactExample(): string {
  const lines = CLASSIFICATION_EXAMPLE.results.map((r) => `  ${JSON.stringify(r)}`);
  return `{"results": [\n${lines.join(",\n")}\n]}`;
}

function renderPrompt(batchPath: string, outPath: string, batch: string): string {
  return `You are classifying Instagram posts for a personal quote catalog. The text of each post's images has already been read by OCR and is in the batch file as numbered lines. Your job is to say **which lines** form each quote and **who** it is by. Process ONE batch file and write ONE result file. You have two tools: Read and Write.

## Never write out quote text

**Never write quote text** — not in the result file, not in your reply, not paraphrased, not partly. Refer to a quote only by its line numbers: image lines (\`"image"\` + \`"lines"\`) or caption segments (\`"from_caption": true\` + \`"caption_lines"\`). The quote text is filled in later by code, from the OCR. Your output holds only line references, names, titles, flags and numbers. Do not open the images either: everything you need is in the batch file.

## Input

Read the batch file:

    ${batchPath}

It looks like \`{"posts": [{"ig_media_id", "posted_at", "caption", "caption_lines": [...], "images": [{"image": 1, "file", "lines": [...]}]}]}\`. \`caption\` may be null. \`images\` has one entry per image of the post, numbered from 1; carousels have several. Each entry of \`lines\` is one OCR line, prefixed with its reference, top to bottom:

    img1:L0 "Once you've got a"
    img1:L1 "task to do, it's bet-"
    img1:L2 "ter to do it than"
    img1:L3 "live with the fear of it."
    img1:L4 "— Joe Abercrombie"

\`img1:L0\` means image 1, line 0. Line numbers start at 0 on every image. OCR may garble decorative fonts or pick up stray words (watermarks, handles, page numbers); judge by meaning.

\`caption_lines\` is the caption split into numbered segments, with hashtags and \`📖\` lines removed. A “curly-quoted” span is its own segment, apart from any commentary or attribution next to it:

    cap:L0 "“If you only read the books that everyone else is reading, you can only think what everyone else is thinking.”"
    cap:L1 "― Haruki Murakami, Norwegian Wood"

## For every post

1. Read the caption and every image's lines. On a carousel each image can carry a different quote.
2. **Find each quote** and give its line range on one image: \`"image": N\` and \`"lines": [start, end]\`, both ends **inclusive**, taken from the \`imgN:L<start>\` and \`imgN:L<end>\` references. In the example above the quote is \`"image": 1, "lines": [0, 3]\`. Include every line of the quote and nothing else: leave out an attribution line (like \`img1:L4 "— Joe Abercrombie"\`), a title, a watermark or a handle above or below it. A quote that runs over two images is two entries, one per image.
3. **Quotes in the caption.** If the quote is (also) written in the caption, set \`"from_caption": true\`. When it is in the caption only, give no \`"image"\` or \`"lines"\`; instead give \`"caption_lines": [start, end]\` (inclusive, from the \`cap:L<n>\` references) covering exactly the quote's segments, leaving out commentary and attribution segments. In the example above that is \`"caption_lines": [0, 0]\`. When it is in both, give the image's line range and no \`"caption_lines"\`. Otherwise set \`"from_caption": false\`.
4. **Attribution (\`author\`, \`source\`)**:
${ATTRIBUTION_RULES}
5. ${COMMENTARY_RULE}
6. ${NON_QUOTE_RULE} So do posts whose images have no lines and whose caption holds no quote.
7. **Carousels may contain several quotes**: add one entry to \`quotes\` per distinct quote. If the same quote appears in the image and the caption, record it once with the image's lines and \`"from_caption": true\`.
8. **\`confidence\`** is a number from 0 to 1 for the whole entry (line range and attribution). Use about 0.9–1 when the quote's lines are clear and the attribution is explicit. Lower it (≤ 0.7) when the OCR lines look garbled or the quote's boundaries are unclear, or when the author/source is a guess (e.g. inferred from an ambiguous hashtag). It is combined with the OCR's own confidence; entries below 0.8 go to a human review queue, so be honest.

## Output

Write the result file with the Write tool to exactly this path:

    ${outPath}

It must be valid JSON matching this schema exactly — no extra keys, no comments, no Markdown fences in the file:

- \`"results"\`: an array with **one result per input post, in input order** (same \`ig_media_id\`s, none added, none left out).
- Each result: \`"ig_media_id"\` (string, copied from the input), \`"no_quote"\` (boolean; true only when \`quotes\` is empty because the post has no quote), \`"quotes"\` (array).
- Each quote: \`"image"\` (image number, or omitted for a caption-only quote), \`"lines"\` (\`[start, end]\`, or omitted for a caption-only quote), \`"from_caption"\` (boolean), \`"caption_lines"\` (\`[start, end]\`, only for a caption-only quote), \`"author"\` (string or null), \`"source"\` (string or null), \`"confidence"\` (number 0–1). **There is no \`text\` key**: a file with quote text in it is rejected.

Example (a single-image post, a carousel with two quotes, a caption-only quote and a non-quote post):

\`\`\`json
${compactExample()}
\`\`\`

## When finished

Reply with exactly one line and nothing else (no quote text), in this form:

    ${batch}: <posts> posts, <quotes> quotes, <no_quote> no_quote

for example \`batch-007: 20 posts, 18 quotes, 2 no_quote\`.
`;
}

/** Full instructions for one agent classifying one batch file. Paths are made absolute. */
export function buildClassificationPrompt({
  batchPath,
  outPath,
}: ClassificationPromptOptions): string {
  return renderPrompt(
    resolve(batchPath),
    resolve(outPath),
    basename(batchPath, extname(batchPath)),
  );
}

/** Contents of `docs/classification-prompt.md`, generated from the same template. */
export function renderClassificationPromptDoc(): string {
  return `<!-- Generated by \`bun run docs:prompt\` from src/ingest/extraction/classification-prompt.ts. Do not edit by hand. -->

# Classification prompt

This is the prompt each classification subagent receives for one batch (see [runbook-backfill.md](runbook-backfill.md)). The agent returns only OCR line references and metadata, never quote text. Print the real prompt for a batch, with absolute paths filled in, with:

    bun run extract:classify-prompt data/extractions/todo/batch-NNN.json

---

${renderPrompt(
  "/abs/path/to/data/extractions/todo/batch-NNN.json",
  "/abs/path/to/data/extractions/classified/batch-NNN.json",
  "batch-NNN",
)}`;
}
