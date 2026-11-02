# CLAUDE.md

## Project

Local-only app cataloging Instagram quote posts + Apple Books highlights. See README.md. Work is tracked as GitHub issues; implement one issue per branch/PR (`feat/<issue#>-<slug>`), and reference the issue in the PR body (`Closes #N`).

## Stack & commands

- Runtime/package manager: **Bun** (never npm/yarn/pnpm). `bun install`, `bun add <pkg>`.
- `bun run dev` — Bun.serve with HTML imports (API at `/api/*`, React SPA)
- `bun test` — tests (happy-dom + @testing-library/react for UI)
- `bun run lint` — `biome check .`; `bun run format` — `biome check --write .`
- `bun run typecheck` — `tsc --noEmit`
- DB: `bun:sqlite` only (no ORM). SQL migrations in `src/server/db/migrations/NNNN_name.sql`.
- UI: React + Tailwind v4 + shadcn/ui components in `src/web/components/ui`.

## TDD (required)

1. Write a failing test that captures the issue's acceptance criteria first; run it and see it fail.
2. Implement the minimum to pass. 3. Refactor with tests green.

- DB tests use `:memory:` databases with migrations applied — never touch `data/`.
- Network (Instagram, `claude -p`) is always injected/mocked in tests; no real calls in `bun test`.
- Apple Books tests use fixture SQLite files in `test/fixtures/`, never the real Books DBs.
- Before declaring done: `bun run lint && bun run typecheck && bun test` all pass.

## Layout

- `src/server/` db, repositories, HTTP API
- `src/ingest/` instagram, apple-books, extraction
- `src/web/` React app
- `scripts/` CLI entrypoints (`sync`, `import:extractions`, ...)
- `data/` (gitignored) `quotes.db`, `media/`, `extractions/`, `logs/`

## Conventions

- Pure functions for logic (normalization, matching, parsing); thin I/O shells around them.
- Dependency injection for clock, fetch, db, and filesystem paths.
- Timestamps stored as ISO-8601 UTC strings.
