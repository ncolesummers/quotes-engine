/**
 * Seed a scratch database with a handful of quotes and posts for UI work.
 *
 * Usage: QUOTES_DB_PATH=/tmp/quotes-dev.db bun scripts/dev-seed.ts
 *        QUOTES_DB_PATH=/tmp/quotes-dev.db bun run dev
 *
 * Refuses to run without an explicit QUOTES_DB_PATH, or with one inside data/, so it never
 * touches the real catalog.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { openDb } from "../src/server/db/index";
import { recordMetrics, upsertPost } from "../src/server/repos/posts";
import { linkPostQuote, upsertQuote } from "../src/server/repos/quotes";

/** Canonical form of `path`: symlinks resolved on the deepest ancestor that exists. */
function canonical(path: string): string {
  let existing = path;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const real = existsSync(existing) ? realpathSync(existing) : existing;
  return resolve(real, relative(existing, path));
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** True when `path` is set and resolves (from `cwd`, through symlinks) outside `dataDir`. */
export function isSafeSeedPath(
  path: string | undefined,
  {
    cwd = process.cwd(),
    dataDir = resolve(import.meta.dir, "../data"),
  }: { cwd?: string; dataDir?: string } = {},
): path is string {
  if (!path || path === ":memory:") return false;
  const target = canonical(resolve(cwd, path));
  return ![resolve(cwd, "data"), dataDir].some((dir) => isInside(target, canonical(dir)));
}

interface SeedQuote {
  text: string;
  author: string | null;
  sourceTitle: string | null;
  /** One entry per posting: [postedAt, likes, comments]. */
  postings: [string, number, number][];
}

const QUOTES: SeedQuote[] = [
  {
    text: "So it goes.",
    author: "Kurt Vonnegut",
    sourceTitle: "Slaughterhouse-Five",
    postings: [
      ["2025-03-02T14:00:00Z", 812, 41],
      ["2026-02-11T14:00:00Z", 1204, 66],
    ],
  },
  {
    text: "You cannot step into the same river twice, for other waters are continually flowing on.",
    author: "Heraclitus",
    sourceTitle: "Fragments",
    postings: [["2025-11-20T09:30:00Z", 540, 18]],
  },
  {
    text: "It is good to have an end to journey toward; but it is the journey that matters, in the end.",
    author: "Ursula K. Le Guin",
    sourceTitle: "The Left Hand of Darkness",
    postings: [
      ["2024-08-14T18:00:00Z", 430, 12],
      ["2025-06-01T18:00:00Z", 690, 27],
      ["2026-09-09T18:00:00Z", 958, 35],
    ],
  },
  {
    text: "I took a deep breath and listened to the old brag of my heart. I am, I am, I am.",
    author: "Sylvia Plath",
    sourceTitle: "The Bell Jar",
    postings: [["2026-10-03T12:00:00Z", 1530, 88]],
  },
  {
    text: "Whatever our souls are made of, his and mine are the same.",
    author: "Emily Brontë",
    sourceTitle: "Wuthering Heights",
    postings: [],
  },
];

function main(): void {
  const path = process.env.QUOTES_DB_PATH;
  if (!isSafeSeedPath(path)) {
    console.error("Set QUOTES_DB_PATH to a scratch file outside data/.");
    process.exit(1);
  }
  const db = openDb(path);
  let seq = 0;
  for (const q of QUOTES) {
    const { quote } = upsertQuote(db, {
      text: q.text,
      author: q.author,
      sourceTitle: q.sourceTitle,
    });
    for (const [postedAt, likes, comments] of q.postings) {
      const post = upsertPost(db, {
        igMediaId: `dev-${quote.id}-${++seq}`,
        permalink: null,
        caption: q.text,
        postedAt,
      });
      recordMetrics(db, post.id, likes, comments, postedAt);
      linkPostQuote(db, post.id, quote.id, {
        method: "caption",
        confidence: 1,
        status: "confirmed",
      });
    }
  }
  db.close();
  console.log(`Seeded ${QUOTES.length} quotes into ${path}`);
}

if (import.meta.main) main();
