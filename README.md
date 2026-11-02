# quotes-engine

A local catalog of every quote I've posted to Instagram: when each was posted, how it performed (likes/comments), which quotes were reposted, plus my Apple Books highlights as a backlog of future posts. Includes a searchable UI.

## Stack

TypeScript · Bun · Biome · React · Tailwind v4 · shadcn/ui · SQLite (`bun:sqlite`) · `bun test`

## How it works

- **Instagram sync:** pulls posts, captions, media, likes and comments from the Instagram API (Creator/Business account) and saves metric snapshots over time.
- **Quote extraction:** reads the quote from the caption and/or image using Claude Haiku (subagents for the backfill, `claude -p` for new posts).
- **Apple Books import:** reads highlights from the local Books SQLite databases (the terminal needs Full Disk Access).
- **Repost tracking:** `post_quotes` links quotes to posts many-to-many, so one quote can have several postings.
- **Nightly sync:** a launchd agent runs `bun run sync`.

## Plan

The implementation plan lives in [GitHub Issues](../../issues), grouped by milestone.
