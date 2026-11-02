import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcrLine } from "../ocr/parse";
import { type PostOcr, writePostOcr } from "../ocr/run";
import { assembleClassifications, assembleResult, joinOcrLines } from "./assemble";
import { type ClassificationBatchPost, formatOcrLine } from "./classify-batches";
import { parseExtractionFile } from "./import";
import { ExtractionFileSchema } from "./schema";

function l(text: string, confidence = 1): OcrLine {
  return { text, confidence, box: { x: 0, y: 0, w: 1, h: 0.1 } };
}

const OCR: PostOcr = {
  ig_media_id: "p1",
  images: [
    {
      file: "p1_1.jpg",
      path: "/m/p1_1.jpg",
      lines: [l("Once you've got a", 0.9), l("task to do, it's bet-", 0.8), l("ter to do it", 1)],
    },
    { file: "p1_2.jpg", path: "/m/p1_2.jpg", lines: [l("Second quote."), l("— Joe Abercrombie")] },
  ],
};

const POST: ClassificationBatchPost = {
  ig_media_id: "p1",
  posted_at: null,
  caption: "Be the change you wish to see.\n📖 The Blade Itself — Joe Abercrombie\n#joeabercrombie",
  caption_lines: [],
  // As the batch file shows them: the OCR lines, numbered.
  images: OCR.images.map((img, i) => ({
    image: i + 1,
    file: img.file,
    lines: img.lines.map((line, idx) => formatOcrLine(i + 1, idx, line.text)),
  })),
};

/** The batch post an agent would have seen for `ocr`. */
function postFor(ocr: PostOcr): ClassificationBatchPost {
  return {
    ...POST,
    images: ocr.images.map((img, i) => ({
      image: i + 1,
      file: img.file,
      lines: img.lines.map((line, idx) => formatOcrLine(i + 1, idx, line.text)),
    })),
  };
}

const Q = { author: "Joe Abercrombie", source: "The Blade Itself" };

describe("joinOcrLines", () => {
  test("joins wrapped lines with single spaces and trims whitespace", () => {
    expect(joinOcrLines(["  Once you've got a ", "task   to do"])).toBe(
      "Once you've got a task to do",
    );
  });

  test("merges a word hyphenated across a line wrap", () => {
    expect(joinOcrLines(["it's bet-", "ter to do it"])).toBe("it's better to do it");
    expect(joinOcrLines(["un‐", "known"])).toBe("unknown");
  });

  test("keeps real hyphens and dashes at a line end", () => {
    expect(joinOcrLines(["well-", "Known"])).toBe("well- Known");
    expect(joinOcrLines(["and then —", "silence"])).toBe("and then — silence");
    expect(joinOcrLines(["a -", "b"])).toBe("a - b");
  });

  test("drops empty lines", () => {
    expect(joinOcrLines(["a", "  ", "b"])).toBe("a b");
  });
});

describe("assembleResult", () => {
  const CAPTIONED: ClassificationBatchPost = {
    ...POST,
    caption:
      "“An environment tells you how to live in it.” Jessyn says it like an observation.\n#tag",
  };

  test("a caption_lines range takes just those caption segments, without outer quote marks", () => {
    const r = assembleResult(
      {
        ig_media_id: "p1",
        no_quote: false,
        quotes: [
          {
            ...Q,
            image: null,
            lines: null,
            from_caption: true,
            caption_lines: [0, 0],
            confidence: 0.9,
          },
        ],
      },
      CAPTIONED,
      OCR,
    );
    expect(r.quotes[0]).toEqual({
      text: "An environment tells you how to live in it.",
      ...Q,
      found_in: "caption",
      confidence: 0.9,
    });
  });

  test("an out-of-range caption_lines range is an error", () => {
    expect(() =>
      assembleResult(
        {
          ig_media_id: "p1",
          no_quote: false,
          quotes: [
            {
              ...Q,
              image: null,
              lines: null,
              from_caption: true,
              caption_lines: [1, 2],
              confidence: 1,
            },
          ],
        },
        CAPTIONED,
        OCR,
      ),
    ).toThrow(/caption_lines \[1, 2\] are out of range/);
  });

  test("strips quote marks wrapping a whole OCR quote", () => {
    const ocr: PostOcr = {
      ig_media_id: "p1",
      images: [{ file: "p1_1.jpg", path: "/m/p1_1.jpg", lines: [l("“Quoted"), l("text.”")] }],
    };
    const r = assembleResult(
      {
        ig_media_id: "p1",
        no_quote: false,
        quotes: [
          {
            ...Q,
            caption_lines: null,
            image: 1,
            lines: [0, 1],
            from_caption: false,
            confidence: 1,
          },
        ],
      },
      postFor(ocr),
      ocr,
    );
    expect(r.quotes[0]?.text).toBe("Quoted text.");
  });

  test("joins referenced lines across a hyphenated wrap into an image quote", () => {
    const r = assembleResult(
      {
        ig_media_id: "p1",
        no_quote: false,
        quotes: [
          {
            ...Q,
            caption_lines: null,
            image: 1,
            lines: [0, 2],
            from_caption: false,
            confidence: 1,
          },
        ],
      },
      POST,
      OCR,
    );
    expect(r.quotes).toEqual([
      {
        text: "Once you've got a task to do, it's better to do it",
        ...Q,
        found_in: "image",
        confidence: 0.9,
      },
    ]);
  });

  test("confidence is the model's confidence times the mean OCR confidence", () => {
    const r = assembleResult(
      {
        ig_media_id: "p1",
        no_quote: false,
        quotes: [
          {
            ...Q,
            caption_lines: null,
            image: 1,
            lines: [0, 1],
            from_caption: false,
            confidence: 0.5,
          },
        ],
      },
      POST,
      OCR,
    );
    expect(r.quotes[0]?.confidence).toBeCloseTo(0.5 * 0.85, 6);
  });

  test("a quote in both image and caption is found_in both, text from OCR", () => {
    const r = assembleResult(
      {
        ig_media_id: "p1",
        no_quote: false,
        quotes: [
          { ...Q, caption_lines: null, image: 2, lines: [0, 0], from_caption: true, confidence: 1 },
        ],
      },
      POST,
      OCR,
    );
    expect(r.quotes[0]).toMatchObject({ text: "Second quote.", found_in: "both" });
  });

  test("a caption-only quote takes the stripped caption", () => {
    const r = assembleResult(
      {
        ig_media_id: "p1",
        no_quote: false,
        quotes: [
          {
            ...Q,
            caption_lines: null,
            image: null,
            lines: null,
            from_caption: true,
            confidence: 0.8,
          },
        ],
      },
      POST,
      OCR,
    );
    expect(r.quotes[0]).toEqual({
      text: "Be the change you wish to see.",
      ...Q,
      found_in: "caption",
      confidence: 0.8,
    });
  });

  test("carousels give one quote per entry", () => {
    const r = assembleResult(
      {
        ig_media_id: "p1",
        no_quote: false,
        quotes: [
          {
            ...Q,
            caption_lines: null,
            image: 1,
            lines: [0, 0],
            from_caption: false,
            confidence: 1,
          },
          {
            ...Q,
            caption_lines: null,
            image: 2,
            lines: [0, 0],
            from_caption: false,
            confidence: 1,
          },
        ],
      },
      POST,
      OCR,
    );
    expect(r.quotes.map((q) => q.text)).toEqual(["Once you've got a", "Second quote."]);
  });

  test("passes a no_quote result through", () => {
    expect(assembleResult({ ig_media_id: "p1", no_quote: true, quotes: [] }, POST, OCR)).toEqual({
      ig_media_id: "p1",
      no_quote: true,
      quotes: [],
    });
  });

  test("throws for an out-of-range line or image", () => {
    const res = (image: number, lines: [number, number]) => ({
      ig_media_id: "p1",
      no_quote: false,
      quotes: [{ ...Q, caption_lines: null, image, lines, from_caption: false, confidence: 1 }],
    });
    expect(() => assembleResult(res(1, [1, 3]), POST, OCR)).toThrow(/out of range/);
    expect(() => assembleResult(res(3, [0, 0]), POST, OCR)).toThrow(/image 3/);
  });

  test("throws for a caption quote when the stripped caption is empty", () => {
    expect(() =>
      assembleResult(
        {
          ig_media_id: "p1",
          no_quote: false,
          quotes: [
            {
              ...Q,
              caption_lines: null,
              image: null,
              lines: null,
              from_caption: true,
              confidence: 1,
            },
          ],
        },
        { ...POST, caption: "#only #tags" },
        OCR,
      ),
    ).toThrow(/caption/);
  });

  test("throws when no_quote is false but there are no quotes", () => {
    expect(() =>
      assembleResult({ ig_media_id: "p1", no_quote: false, quotes: [] }, POST, OCR),
    ).toThrow(/no quotes/);
  });
});

describe("assembleClassifications", () => {
  let root: string;
  let extractionsDir: string;
  let todoDir: string;
  let classifiedDir: string;
  let ocrDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "quotes-assemble-"));
    extractionsDir = join(root, "extractions");
    todoDir = join(extractionsDir, "todo");
    classifiedDir = join(extractionsDir, "classified");
    ocrDir = join(root, "ocr");
    mkdirSync(todoDir, { recursive: true });
    mkdirSync(classifiedDir, { recursive: true });
    writePostOcr(ocrDir, OCR);
    writePostOcr(ocrDir, {
      ig_media_id: "p2",
      images: [{ file: "p2.jpg", path: "/m/p2.jpg", lines: [l("Only line")] }],
    });
    writeFileSync(
      join(todoDir, "batch-001.json"),
      JSON.stringify({
        posts: [
          POST,
          {
            ig_media_id: "p2",
            posted_at: null,
            caption: null,
            images: [{ image: 1, file: "p2.jpg", lines: [formatOcrLine(1, 0, "Only line")] }],
          },
          { ig_media_id: "p3", posted_at: null, caption: "hi", images: [] },
        ],
      }),
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = () => assembleClassifications({ classifiedDir, todoDir, ocrDir, extractionsDir });

  test("writes a valid ExtractionFile where import:extractions reads, keeping per-post errors out", () => {
    writeFileSync(
      join(classifiedDir, "batch-001.json"),
      JSON.stringify({
        results: [
          {
            ig_media_id: "p1",
            no_quote: false,
            quotes: [{ ...Q, caption_lines: null, image: 1, lines: [0, 2], confidence: 0.9 }],
          },
          {
            ig_media_id: "p2",
            no_quote: false,
            quotes: [{ ...Q, caption_lines: null, image: 1, lines: [0, 5], confidence: 0.9 }],
          },
          { ig_media_id: "p3", no_quote: true, quotes: [] },
        ],
      }),
    );

    const summary = run();
    expect(summary).toMatchObject({ filesAssembled: 1, filesFailed: 0, posts: 2, quotes: 1 });
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({ igMediaId: "p2" });
    expect(summary.errors[0]?.message).toMatch(/out of range/);

    const out = join(extractionsDir, "batch-001.json");
    const content = readFileSync(out, "utf8");
    expect(ExtractionFileSchema.safeParse(JSON.parse(content)).success).toBe(true);
    const results = parseExtractionFile(content);
    expect(results.map((r) => r.ig_media_id)).toEqual(["p1", "p3"]);
    expect(results[0]?.quotes[0]?.text).toBe("Once you've got a task to do, it's better to do it");

    // The classification file is archived so it isn't assembled twice.
    expect(existsSync(join(classifiedDir, "batch-001.json"))).toBe(false);
    expect(existsSync(join(classifiedDir, "assembled", "batch-001.json"))).toBe(true);
  });

  test("errors for a post that is not in the batch or has no OCR", () => {
    rmSync(join(ocrDir, "p2.json"));
    writeFileSync(
      join(classifiedDir, "batch-001.json"),
      JSON.stringify({
        results: [
          { ig_media_id: "nope", no_quote: true },
          {
            ig_media_id: "p2",
            quotes: [{ ...Q, caption_lines: null, image: 1, lines: [0, 0], confidence: 1 }],
          },
        ],
      }),
    );
    const summary = run();
    expect(summary.errors.map((e) => e.igMediaId)).toEqual(["nope", "p2"]);
    expect(summary.posts).toBe(0);
    expect(existsSync(join(extractionsDir, "batch-001.json"))).toBe(false);
    // Nothing was assembled, so the file is failed (kept for a retry), not archived as done.
    expect(summary).toMatchObject({ filesAssembled: 0, filesFailed: 1 });
    expect(existsSync(join(classifiedDir, "failed", "batch-001.json"))).toBe(true);
    expect(existsSync(join(classifiedDir, "failed", "batch-001.json.error.txt"))).toBe(true);
  });

  test("errors for a post whose OCR changed since its batch was written", () => {
    writePostOcr(ocrDir, {
      ig_media_id: "p2",
      images: [{ file: "p2.jpg", path: "/m/p2.jpg", lines: [l("New first line"), l("Only line")] }],
    });
    writeFileSync(
      join(classifiedDir, "batch-001.json"),
      JSON.stringify({
        results: [
          {
            ig_media_id: "p2",
            quotes: [{ ...Q, caption_lines: null, image: 1, lines: [0, 0], confidence: 1 }],
          },
          { ig_media_id: "p3", no_quote: true },
        ],
      }),
    );
    const summary = run();
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({ igMediaId: "p2" });
    expect(summary.errors[0]?.message).toMatch(/changed since/);
    expect(summary.posts).toBe(1);
  });

  test("moves an invalid classification file to classified/failed with an error note", () => {
    writeFileSync(
      join(classifiedDir, "batch-001.json"),
      JSON.stringify({ results: [{ ig_media_id: "p1", quotes: [{ text: "agent wrote it" }] }] }),
    );
    const summary = run();
    expect(summary).toMatchObject({ filesAssembled: 0, filesFailed: 1 });
    expect(existsSync(join(classifiedDir, "failed", "batch-001.json"))).toBe(true);
    expect(existsSync(join(classifiedDir, "failed", "batch-001.json.error.txt"))).toBe(true);
  });

  test("fails a file whose batch is missing from todo/", () => {
    writeFileSync(join(classifiedDir, "batch-002.json"), JSON.stringify({ results: [] }));
    const summary = run();
    expect(summary.filesFailed).toBe(1);
    expect(summary.errors[0]?.message).toMatch(/batch-002/);
  });

  test("does not overwrite an extraction file that is not imported yet", () => {
    writeFileSync(join(extractionsDir, "batch-001.json"), "{}");
    writeFileSync(
      join(classifiedDir, "batch-001.json"),
      JSON.stringify({ results: [{ ig_media_id: "p3", no_quote: true }] }),
    );
    const summary = run();
    expect(summary.filesFailed).toBe(1);
    expect(summary.errors[0]?.message).toMatch(/import:extractions/);
    expect(readFileSync(join(extractionsDir, "batch-001.json"), "utf8")).toBe("{}");
    expect(existsSync(join(classifiedDir, "batch-001.json"))).toBe(true);
  });
});

describe("assembleResult guards against non-quote text", () => {
  const caption = (
    q: Partial<Parameters<typeof assembleResult>[0]["quotes"][number]>,
  ): Parameters<typeof assembleResult>[0] => ({
    ig_media_id: "p1",
    no_quote: false,
    quotes: [
      {
        ...Q,
        image: null,
        lines: null,
        from_caption: true,
        caption_lines: null,
        confidence: 0.9,
        ...q,
      },
    ],
  });

  test("a caption-only quote without caption_lines is an error when the caption has several segments", () => {
    const post = { ...POST, caption: "“A quote.” Some commentary about it.\n― Joe Abercrombie" };
    expect(() => assembleResult(caption({}), post, OCR)).toThrow(/caption_lines/);
  });

  test("drops a trailing dash attribution line from an image line range", () => {
    const r = assembleResult(
      {
        ig_media_id: "p1",
        no_quote: false,
        quotes: [
          {
            ...Q,
            caption_lines: null,
            image: 2,
            lines: [0, 1],
            from_caption: false,
            confidence: 1,
          },
        ],
      },
      POST,
      OCR,
    );
    expect(r.quotes[0]?.text).toBe("Second quote.");
  });

  test("drops a trailing dash attribution segment from a caption_lines range", () => {
    const post = {
      ...POST,
      caption: "“If you only read the books…” ― Haruki Murakami, Norwegian Wood",
    };
    const r = assembleResult(caption({ caption_lines: [0, 1] }), post, OCR);
    expect(r.quotes[0]?.text).toBe("If you only read the books…");
  });
});

describe("joinOcrLines fixes all-caps OCR confusions", () => {
  test("a standalone 1 between capitalised words is the pronoun I", () => {
    expect(joinOcrLines(["BUT 1 FEEL THAT 1 HAVE ALWAYS"])).toBe("BUT I FEEL THAT I HAVE ALWAYS");
    expect(joinOcrLines(["1 SOMETIMES THINK"])).toBe("I SOMETIMES THINK");
    expect(joinOcrLines(["I WAS BADLY MISINFORMED, 1 DEEPLY REGRET"])).toBe(
      "I WAS BADLY MISINFORMED, I DEEPLY REGRET",
    );
    expect(joinOcrLines(["AND SO", "1 WENT"])).toBe("AND SO I WENT");
  });

  test("leaves real numbers alone", () => {
    for (const line of [
      "CHAPTER 1",
      "CHAPTER 1 BEGINS",
      "PART 1 OF THE STORY",
      "THE 1ST TIME",
      "STEP 1. BREATHE",
      "OVER 1,000 YEARS",
      "WON 1 0 GAMES",
      "ROOM 21 1 B",
      "only 1 apple",
    ]) {
      expect(joinOcrLines([line])).toBe(line);
    }
  });

  test("a line-initial T'D / T'M / T'LL / T'VE in all-caps text is I'D etc.", () => {
    expect(joinOcrLines(["T'D RATHER BE", "T’M HERE", "T'LL GO", "T'VE SEEN"])).toBe(
      "I'D RATHER BE I’M HERE I'LL GO I'VE SEEN",
    );
    expect(joinOcrLines(["T'd rather"])).toBe("T'd rather");
    expect(joinOcrLines(["AND T'D"])).toBe("AND T'D");
  });
});
