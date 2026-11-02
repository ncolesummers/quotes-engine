import { z } from "zod";

const nullableString = z
  .string()
  .nullish()
  .transform((v) => v ?? null);

/**
 * One quote as classified by an agent: a reference to OCR lines and/or the caption, never the
 * quote text itself. `.strict()` rejects a `text` key, so an agent that writes text out fails.
 */
export const ClassifiedQuoteSchema = z
  .object({
    /** 1-based image number within the post (`img1`, `img2`, ...). */
    image: z
      .number()
      .int()
      .min(1)
      .nullish()
      .transform((v) => v ?? null),
    /** Inclusive `[start, end]` OCR line indexes on that image. */
    lines: z
      .tuple([z.number().int().min(0), z.number().int().min(0)])
      .nullish()
      .transform((v) => v ?? null),
    /** True when the quote is (also) in the caption. */
    from_caption: z.boolean().default(false),
    /** Inclusive `[start, end]` caption segment indexes (`cap:L<n>`), for a caption-only quote. */
    caption_lines: z
      .tuple([z.number().int().min(0), z.number().int().min(0)])
      .nullish()
      .transform((v) => v ?? null),
    author: nullableString,
    source: nullableString,
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .refine((q) => (q.image === null) === (q.lines === null), {
    message: "`image` and `lines` must be given together",
  })
  .refine((q) => q.lines === null || q.lines[0] <= q.lines[1], {
    message: "`lines` must be [start, end] with start <= end",
  })
  .refine((q) => q.caption_lines === null || (q.from_caption && q.lines === null), {
    message: "`caption_lines` is only for a caption-only quote (`from_caption: true`, no `lines`)",
  })
  .refine((q) => q.caption_lines === null || q.caption_lines[0] <= q.caption_lines[1], {
    message: "`caption_lines` must be [start, end] with start <= end",
  })
  .refine((q) => q.lines !== null || q.from_caption, {
    message: "a quote needs `image` + `lines`, or `from_caption: true`",
  });

export const ClassificationResultSchema = z.object({
  ig_media_id: z.string().min(1),
  no_quote: z.boolean().default(false),
  quotes: z.array(ClassifiedQuoteSchema).default([]),
});

/** One classification result file (`data/extractions/classified/batch-NNN.json`). */
export const ClassificationFileSchema = z.object({
  results: z.array(ClassificationResultSchema),
});

export type ClassifiedQuote = z.infer<typeof ClassifiedQuoteSchema>;
export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;
export type ClassificationFile = z.infer<typeof ClassificationFileSchema>;
