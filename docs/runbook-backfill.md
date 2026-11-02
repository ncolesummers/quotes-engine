# Runbook: backfill quote extraction

How to extract quotes from every Instagram post that hasn't been extracted yet. Extraction is done
by Claude Code subagents (Haiku) that read the post images and captions; there are no API calls
from this repo. Run each step from the repo root.

## 1. Sync posts and media

```sh
bun run sync:instagram
```

Fetches posts, metrics and media into `data/quotes.db` and `data/media/`. See
[instagram-setup.md](instagram-setup.md) for credentials.

## 2. Write batch files

```sh
bun run extract:batches            # 20 posts per batch
bun run extract:batches --size 10  # smaller batches
```

Writes `data/extractions/todo/batch-NNN.json`, holding the unextracted posts oldest first. Each post
carries its caption and the **absolute** paths of all its images (every carousel image). Posts with
neither media nor a caption are skipped. Image and carousel posts whose files are missing from
`data/media/` (e.g. a failed download) are left out and listed as `missingMedia`: re-run
`sync:instagram`, then batch again. Each run clears `todo/` and rewrites it from the DB, so after a
partial import, running it again only batches what is still left. It refuses to run while result
files in `data/extractions/` are waiting to be imported, because batch names restart at
`batch-001` and new results would overwrite them.

## 3. Run one Haiku subagent per batch

In a Claude Code session, for each batch:

```sh
bun scripts/extraction-prompt.ts data/extractions/todo/batch-001.json
```

Give the printed prompt, unchanged, to a Haiku subagent that has the **Read** and **Write** tools.
Run **at most 4–5 subagents at a time**, and start the next batch when one finishes.

Each subagent writes `data/extractions/batch-NNN.json` (next to `todo/`, which is where
`import:extractions` reads) and replies with one line, e.g.
`batch-007: 20 posts, 18 quotes, 2 no_quote, 0 unreadable`. Posts with an image the agent could not
read are left out of its results, so they stay unextracted for the next round. If a subagent fails
or its file is missing, run that batch again.

The prompt text is in [extraction-prompt.md](extraction-prompt.md). That file is generated from
`src/ingest/extraction/prompt.ts` (`bun run docs:prompt`), and a test checks that it is up to date.

## 4. Import the results

```sh
bun run import:extractions
```

Reads `data/extractions/*.json` (the top-level files only, not `todo/`). It moves each imported file
to `data/extractions/imported/`, and any invalid file to `data/extractions/failed/` next to a
`.error.txt`. If a file fails, fix it or run the batch again, then import again. Importing is
idempotent.

## 5. Check the review queue

Quotes with a confidence below 0.8 are linked as `needs_review`. Start the app (`bun run dev`) and
list the queue with `curl -s http://localhost:3000/api/review`. Confirm or reject each link with
`POST /api/review/:postId/:quoteId` and the body `{"action": "confirm"}` or `{"action": "reject"}`.
The same queue from SQL:

```sql
SELECT pq.post_id, pq.quote_id, pq.confidence, q.text, q.author, q.source_title
FROM post_quotes pq JOIN quotes q ON q.id = pq.quote_id
WHERE pq.status = 'needs_review' ORDER BY pq.confidence;
```

## 6. Spot-check the results with SQL

```sh
sqlite3 data/quotes.db
```

```sql
-- Posts still unextracted (should be only skipped empty, missing-media or unreadable posts).
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
