-- Slotwise schema v1. Shared by D1 (wrangler d1 migrations apply) and the Node SQLite adapter.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  welcome TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS availability (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL,
  weekly TEXT NOT NULL,
  overrides TEXT NOT NULL,
  buffer_before INTEGER NOT NULL DEFAULT 0,
  buffer_after INTEGER NOT NULL DEFAULT 0,
  min_notice INTEGER NOT NULL DEFAULT 240,
  max_days_ahead INTEGER NOT NULL DEFAULT 60,
  max_per_day INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_types (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  durations TEXT NOT NULL,
  default_duration INTEGER NOT NULL,
  slot_interval INTEGER,
  location TEXT NOT NULL,
  questions TEXT NOT NULL,
  color TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  buffer_before INTEGER,
  buffer_after INTEGER,
  min_notice INTEGER,
  max_days_ahead INTEGER,
  max_per_day INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, slug)
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type_id TEXT NOT NULL,
  event_type_name TEXT NOT NULL,
  status TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  block_start_ms INTEGER NOT NULL,
  block_end_ms INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  duration INTEGER NOT NULL,
  invitee_name TEXT NOT NULL,
  invitee_email TEXT NOT NULL,
  invitee_timezone TEXT NOT NULL,
  invitee_phone TEXT,
  guests TEXT NOT NULL,
  answers TEXT NOT NULL,
  location TEXT NOT NULL,
  manage_token_hash TEXT NOT NULL,
  external TEXT,
  calendar_error TEXT,
  cancel_reason TEXT,
  cancelled_by TEXT,
  cancelled_at TEXT,
  reschedule_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bookings_user_status_start ON bookings (user_id, status, start_ms);
CREATE INDEX IF NOT EXISTS bookings_user_day ON bookings (user_id, local_date, status);

CREATE TABLE IF NOT EXISTS calendar_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  account_email TEXT NOT NULL,
  enc_tokens TEXT NOT NULL,
  check_calendar_ids TEXT NOT NULL,
  write_calendar_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, provider, account_email)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  booking_id TEXT,
  kind TEXT NOT NULL,
  audience TEXT NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, created_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE IF NOT EXISTS mock_calendar_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  attendees TEXT NOT NULL,
  join_url TEXT,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
