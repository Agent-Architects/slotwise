-- Additive only. Every statement adds a column or a new table; no existing data is changed or dropped.

-- Snapshot of question labels at booking time: {"<questionId>": "<label>"}.
ALTER TABLE bookings ADD COLUMN answer_labels TEXT;

-- Calendar health, shown to the owner and used to fail closed when a calendar cannot be read.
ALTER TABLE calendar_connections ADD COLUMN last_error TEXT;
ALTER TABLE calendar_connections ADD COLUMN last_error_at TEXT;

-- Named availability schedules. The existing availability row stays the default schedule (and holds the
-- owner-wide limits); event_types.schedule_id NULL means "use the default schedule".
ALTER TABLE availability ADD COLUMN schedule_name TEXT NOT NULL DEFAULT 'Working hours';
ALTER TABLE event_types ADD COLUMN schedule_id TEXT;

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  weekly TEXT NOT NULL,
  overrides TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_user ON schedules (user_id);
