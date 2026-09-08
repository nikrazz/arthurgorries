-- Existing subscribers have no confirmed sync history, so default to unsynced.
ALTER TABLE subscribers ADD COLUMN brevo_synced INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscribers ADD COLUMN brevo_synced_at TEXT NULL;
