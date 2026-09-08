-- Capture future unsubscribe events without deleting subscriber history.
ALTER TABLE subscribers ADD COLUMN status TEXT NOT NULL DEFAULT 'subscribed';
ALTER TABLE subscribers ADD COLUMN unsubscribed_at TEXT NULL;
