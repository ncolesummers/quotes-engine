import { z } from "zod";
import { SOURCE_KINDS } from "../../server/repos/quotes";

/**
 * What the quote comes from (#42): a book, a song (`author` = artist, `source` = song title) or
 * something else. Only books are matched to (or create) a `books` row on import.
 */
export const SourceKindSchema = z
  .enum(SOURCE_KINDS)
  .nullish()
  .transform((v) => v ?? "book");

/** One quote found in a post by the extractor. */
export const ExtractedQuoteSchema = z.object({
  text: z.string().trim().min(1),
  author: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  source: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  kind: SourceKindSchema,
  found_in: z.enum(["caption", "image", "both"]),
  confidence: z.number().min(0).max(1),
});

/** Extraction output for one post. `no_quote: true` means the post was checked and has none. */
export const ExtractionResultSchema = z.object({
  ig_media_id: z.string().min(1),
  quotes: z.array(ExtractedQuoteSchema).default([]),
  no_quote: z.boolean().default(false),
});

/** One extraction result file (`data/extractions/*.json`). */
export const ExtractionFileSchema = z.object({
  results: z.array(ExtractionResultSchema),
});

export type ExtractedQuote = z.infer<typeof ExtractedQuoteSchema>;
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
export type ExtractionFile = z.infer<typeof ExtractionFileSchema>;
