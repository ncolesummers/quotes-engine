import { z } from "zod";

/** Normalized bounding box, origin top-left, all values 0–1 of the image size. */
export const OcrBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

export const OcrLineSchema = z.object({
  text: z.string(),
  confidence: z.number().min(0).max(1),
  box: OcrBoxSchema,
});

/** One image as printed by `scripts/ocr/ocr.swift`. `error` is set when it couldn't be OCR'd. */
export const OcrImageSchema = z.object({
  path: z.string().min(1),
  lines: z.array(OcrLineSchema),
  error: z.string().optional(),
});

export const OcrOutputSchema = z.array(OcrImageSchema);

export type OcrLine = z.infer<typeof OcrLineSchema>;
export type OcrImage = z.infer<typeof OcrImageSchema>;

const center = (l: OcrLine) => l.box.y + l.box.h / 2;

/**
 * Lines in reading order: top to bottom, then left to right. Lines whose vertical centres are
 * within half a line height of each other count as one row, so slight skew between words on the
 * same row doesn't reorder them.
 */
export function sortReadingOrder(lines: readonly OcrLine[]): OcrLine[] {
  const byY = [...lines].sort((a, b) => center(a) - center(b));
  const rows: OcrLine[][] = [];
  for (const line of byY) {
    const row = rows.at(-1);
    const first = row?.[0];
    if (
      row &&
      first &&
      Math.abs(center(line) - center(first)) < 0.5 * Math.min(line.box.h, first.box.h)
    ) {
      row.push(line);
    } else {
      rows.push([line]);
    }
  }
  return rows.flatMap((row) => row.sort((a, b) => a.box.x - b.box.x));
}

/** Parse and validate the Swift CLI's stdout; lines are returned in reading order. */
export function parseOcrOutput(stdout: string): OcrImage[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Invalid OCR output: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = OcrOutputSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid OCR output:\n${z.prettifyError(parsed.error)}`);
  return parsed.data.map((image) => ({ ...image, lines: sortReadingOrder(image.lines) }));
}
