-- Web Push subscriptions (migration 076).
--
-- One row per browser/device a staff member has subscribed to push on via the
-- PWA (apps/web). staff_id mirrors chat_read_states.staff_id (staff_members.id,
-- or the 'env-owner' pseudo id used by authenticateApiToken's API_KEY fallback).
--
-- line_account_id is denormalized and nullable rather than FK'd: staff_members
-- has no per-account scoping in this schema (it's a flat, deployment-wide
-- list — see friends.line_account_id / migration 008_multi_account.sql for how
-- LINE accounts are scoped instead), so NULL means "notify this staff member
-- for inbound messages on every LINE account" (today's only exposed choice —
-- the UI doesn't yet offer per-account opt-in/out). endpoint is globally
-- unique because it is a physical browser resource: re-subscribing from the
-- same browser reuses/overwrites the same row regardless of which staff_id
-- previously owned it.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              TEXT PRIMARY KEY,
  staff_id        TEXT NOT NULL,
  line_account_id TEXT,
  endpoint        TEXT NOT NULL,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  user_agent      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint ON push_subscriptions (endpoint);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_staff ON push_subscriptions (staff_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_line_account ON push_subscriptions (line_account_id);
