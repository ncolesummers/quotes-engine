-- Initial schema. Timestamps are ISO-8601 UTC strings.

CREATE TABLE quotes (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  normalized_text TEXT NOT NULL UNIQUE,
  author TEXT,
  source_title TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- External-content FTS5 index over quotes, kept in sync by triggers.
CREATE VIRTUAL TABLE quotes_fts USING fts5(
  text,
  author,
  source_title,
  content = 'quotes',
  content_rowid = 'id'
);

CREATE TRIGGER quotes_fts_ai AFTER INSERT ON quotes BEGIN
  INSERT INTO quotes_fts (rowid, text, author, source_title)
  VALUES (new.id, new.text, new.author, new.source_title);
END;

CREATE TRIGGER quotes_fts_ad AFTER DELETE ON quotes BEGIN
  INSERT INTO quotes_fts (quotes_fts, rowid, text, author, source_title)
  VALUES ('delete', old.id, old.text, old.author, old.source_title);
END;

CREATE TRIGGER quotes_fts_au AFTER UPDATE ON quotes BEGIN
  INSERT INTO quotes_fts (quotes_fts, rowid, text, author, source_title)
  VALUES ('delete', old.id, old.text, old.author, old.source_title);
  INSERT INTO quotes_fts (rowid, text, author, source_title)
  VALUES (new.id, new.text, new.author, new.source_title);
END;

CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  ig_media_id TEXT NOT NULL UNIQUE,
  permalink TEXT,
  caption TEXT,
  media_type TEXT,
  media_url TEXT,
  media_path TEXT,
  posted_at TEXT,
  like_count INTEGER,
  comments_count INTEGER,
  metrics_updated_at TEXT,
  extracted_at TEXT
);

CREATE INDEX posts_posted_at_idx ON posts (posted_at);

CREATE TABLE post_quotes (
  post_id INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  quote_id INTEGER NOT NULL REFERENCES quotes (id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('caption', 'image', 'manual')),
  confidence REAL,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'needs_review')),
  PRIMARY KEY (post_id, quote_id)
);

-- post_id is covered by the primary key's leading column.
CREATE INDEX post_quotes_quote_id_idx ON post_quotes (quote_id);

CREATE TABLE metric_snapshots (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL,
  likes INTEGER,
  comments INTEGER
);

CREATE INDEX metric_snapshots_post_id_idx ON metric_snapshots (post_id, captured_at);

CREATE TABLE books (
  id INTEGER PRIMARY KEY,
  asset_id TEXT NOT NULL UNIQUE,
  title TEXT,
  author TEXT
);

CREATE TABLE highlights (
  id INTEGER PRIMARY KEY,
  annotation_uuid TEXT NOT NULL UNIQUE,
  book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  text TEXT,
  note TEXT,
  location TEXT,
  created_at TEXT,
  quote_id INTEGER REFERENCES quotes (id) ON DELETE SET NULL
);

CREATE INDEX highlights_book_id_idx ON highlights (book_id);
CREATE INDEX highlights_quote_id_idx ON highlights (quote_id);
