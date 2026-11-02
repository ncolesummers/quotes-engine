-- Books as a shared record for Apple Books highlights and posted quotes (#25).
--
-- SQLite can't drop NOT NULL in place, so `books` is rebuilt (create, copy, drop, rename).
-- `migrate` runs every migration with foreign keys off and checks them before committing, so
-- dropping the old table doesn't cascade-delete highlights.

CREATE TABLE books_new (
  id INTEGER PRIMARY KEY,
  -- Apple Books asset id; null for books known only from captions or manual edits.
  asset_id TEXT UNIQUE,
  title TEXT,
  author TEXT,
  -- `bookKey(title, author)`: e.g. "fool's errand|robin hobb", or just the title.
  -- Null only for rows not yet keyed (rows copied below; `bun run books:backfill` fills them).
  normalized_key TEXT UNIQUE,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('apple_books', 'caption', 'manual'))
);

-- Every existing row came from Apple Books.
INSERT INTO books_new (id, asset_id, title, author, source)
SELECT id, asset_id, title, author, 'apple_books' FROM books;

DROP TABLE books;
ALTER TABLE books_new RENAME TO books;

ALTER TABLE quotes ADD COLUMN book_id INTEGER REFERENCES books (id) ON DELETE SET NULL;
CREATE INDEX quotes_book_id_idx ON quotes (book_id);
