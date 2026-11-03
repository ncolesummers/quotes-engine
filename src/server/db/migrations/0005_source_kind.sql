-- What a quote comes from (#42): a book (the default), a song, or something else (a film, a
-- speech...). For a song, `author` holds the artist and `source_title` the song title; songs and
-- other non-book sources never link to `books` (`book_id` stays null), so /books stays books only.
ALTER TABLE quotes ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'book'
  CHECK (source_kind IN ('book', 'song', 'other'));
