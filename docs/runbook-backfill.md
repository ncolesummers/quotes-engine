# Runbook: backfill quote extraction

How to extract quotes from every Instagram post that hasn't been extracted yet. The image text is
read **locally** with Apple's Vision framework (macOS), and Claude Code subagents (Haiku) only
classify it: they return which OCR lines form each quote plus the author and source, and **never
write quote text**. (Agents asked to transcribe book quotes word for word were stopped by the API
content filter.) There are no API calls from this repo. Run each step from the repo root.

## 1. Sync posts and media

```sh
bun run sync:instagram
```

Fetches posts, metrics and media into `data/quotes.db` and `data/media/`. See
[instagram-setup.md](instagram-setup.md) for credentials.

## 2. OCR the images

```sh
bun run ocr                  # 4 OCR processes at a time (one post each)
bun run ocr --concurrency 2  # lighter on memory
```

Needs macOS with the Swift toolchain. On first use it compiles `scripts/ocr/ocr.swift` to
`data/bin/ocr` (`swiftc -O`; recompiled when the source changes). It OCRs every image of every
unextracted post (all carousel images) and writes `data/ocr/<ig_media_id>.json`, one entry per
image with its lines in reading order, each with a confidence and a bounding box. It is
idempotent: images already in a post's OCR file are skipped, so re-run it after a sync or after
failures. Failed images are listed and not stored, so the next run retries them.

To OCR a single image by hand: `swift scripts/ocr/ocr.swift path/to/image.jpg`.

## 3. Write classification batch files

```sh
bun run extract:classify-batches            # 20 posts per batch
bun run extract:classify-batches --size 10  # smaller batches
```

Writes `data/extractions/todo/batch-NNN.json`, holding the unextracted posts oldest first. Each post
carries its caption and, per image, its numbered OCR lines (`img1:L0 "…"`, `img1:L1 "…"`, ...;
carousel images are `img1`, `img2`, ...), plus the caption split into numbered segments
(`cap:L0 "…"`; hashtags and `📖` lines removed, each “curly-quoted” span its own segment so it can
be told apart from the account's commentary). No image paths: the agents work from the text only.
Posts not fully OCR'd are left out and listed as `missingOcr` (run step 2 again); posts whose image
files are missing are listed as `missingMedia` (re-run step 1). Each run clears `todo/` and rewrites
it from the DB. It refuses to run while classification results (`data/extractions/classified/`) or
extraction results (`data/extractions/*.json`) are waiting, because batch names restart at
`batch-001`.

(`bun run extract:batches` still writes the old image-reading batches for
[extraction-prompt.md](extraction-prompt.md); don't mix the two in one round.)

## 4. Run one Haiku subagent per batch

In a Claude Code session, for each batch:

```sh
bun run extract:classify-prompt data/extractions/todo/batch-001.json
```

Give the printed prompt, unchanged, to a Haiku subagent that has the **Read** and **Write** tools.
Run **at most 4–5 subagents at a time**, and start the next batch when one finishes.

Each subagent writes `data/extractions/classified/batch-NNN.json`: per post, `no_quote` and a list
of quotes as `{ image, lines: [start, end], from_caption, caption_lines, author, source, confidence }`
(line references only, never quote text). It replies
with one line, e.g. `batch-007: 20 posts, 18 quotes, 2 no_quote`. If a subagent fails or its file is
missing, run that batch again.

The prompt text is in [classification-prompt.md](classification-prompt.md). That file is generated
from `src/ingest/extraction/classification-prompt.ts` (`bun run docs:prompt`), and a test checks
that it is up to date.

## 5. Assemble extraction files

```sh
bun run extract:assemble
```

For each `data/extractions/classified/batch-NNN.json` it fills in the quote text from the
referenced OCR lines (joining wrapped lines and merging words hyphenated across a wrap) or, for
caption-only quotes, from the referenced `caption_lines` segments (or, without them, the whole
caption with its hashtags and `📖` lines removed). Quote marks wrapping the whole quote are dropped.
`found_in` becomes `image`, `caption` or `both`, and the confidence is the agent's confidence times
the mean OCR confidence of the lines. It writes `data/extractions/batch-NNN.json` in the
[#9 extraction schema](../src/ingest/extraction/schema.ts) and moves the classification file to
`classified/assembled/` (invalid files go to `classified/failed/` with a `.error.txt`). A bad
reference (e.g. a line range out of bounds) is a per-post error: the post is left out and stays
unextracted for the next round.

## 6. Import the results

```sh
bun run import:extractions
```

Reads `data/extractions/*.json` (the top-level files only, not `todo/`). It moves each imported file
to `data/extractions/imported/`, and any invalid file to `data/extractions/failed/` next to a
`.error.txt`. If a file fails, fix it or run the batch again (steps 4–5), then import again. Importing is
idempotent.

## 7. Check the review queue

Quotes with a confidence below 0.8 are linked as `needs_review`. Start the app (`bun run dev`) and
list the queue with `curl -s http://localhost:3000/api/review`. Confirm or reject each link with
`POST /api/review/:postId/:quoteId` and the body `{"action": "confirm"}` or `{"action": "reject"}`.
The same queue from SQL:

```sql
SELECT pq.post_id, pq.quote_id, pq.confidence, q.text, q.author, q.source_title
FROM post_quotes pq JOIN quotes q ON q.id = pq.quote_id
WHERE pq.status = 'needs_review' ORDER BY pq.confidence;
```

## 8. Spot-check the results with SQL

```sh
sqlite3 data/quotes.db
```

```sql
-- Posts still unextracted (should be only skipped empty, missing-media/OCR or errored posts).
SELECT COUNT(*) FROM posts WHERE extracted_at IS NULL;

-- Links by status and method.
SELECT status, method, COUNT(*) FROM post_quotes GROUP BY status, method;

-- Extracted posts with no quote: check that these really are non-quote posts.
SELECT p.ig_media_id, substr(p.caption, 1, 80)
FROM posts p
WHERE p.extracted_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM post_quotes pq WHERE pq.post_id = p.id)
ORDER BY random() LIMIT 20;

-- A random sample of quotes with their captions, to compare against the images.
SELECT p.ig_media_id, q.text, q.author, q.source_title, pq.confidence, substr(p.caption, 1, 80)
FROM post_quotes pq
JOIN posts p ON p.id = pq.post_id
JOIN quotes q ON q.id = pq.quote_id
ORDER BY random() LIMIT 20;

-- Authors and sources, to catch badly decoded hashtags (e.g. "Joeabercrombie").
SELECT author, source_title, COUNT(*) FROM quotes GROUP BY 1, 2 ORDER BY 3 DESC;
```

## New posts: `bun run extract:new`

For the few posts that arrive each day, steps 2–6 run unattended, without a Claude Code session:

```sh
bun run extract:new            # 20 posts per batch
bun run extract:new --size 10
```

It does nothing (no OCR, no agent) when every post is already extracted. Otherwise it OCRs the
unextracted posts, writes the classification batches, and runs one headless Haiku agent per batch,
one at a time, with a 5-minute limit each (`CLASSIFY_TIMEOUT_MS`):

```sh
claude -p "<classification prompt for the batch>" --model haiku --tools Read,Write \
  --allowedTools Read,Write --permission-mode acceptEdits --output-format json \
  --no-session-persistence --strict-mcp-config --add-dir <extractions dir>
```

The agent runs in the repo root. Then it assembles and imports the results. A batch whose agent
exits non-zero, times out, reports an error or writes no result file is logged with its stderr; its
partial result (if any) goes to `classified/failed/`, and its posts stay unextracted for the next
run. Results left by an earlier, interrupted run (`classified/*.json` or `extractions/*.json`) are
assembled and imported first. It prints each batch's time and cost, then a summary, and exits 1 if
anything failed.

Env: the same `QUOTES_DB_PATH`, `MEDIA_DIR`, `OCR_DIR`, `EXTRACTIONS_DIR` and `OCR_BIN` as above,
plus `CLAUDE_BIN` (default: `claude` on `PATH`). Relative paths are resolved against the repo root.
