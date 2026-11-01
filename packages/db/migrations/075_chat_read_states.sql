-- Per-staff read state for 1:1 chats.
--
-- chats.status is a shared, operator-managed conversation state (unread /
-- in_progress / resolved) and stays untouched. This table adds the LINE-app
-- style marker that a particular staff member has seen the latest incoming
-- message: a chat counts as 未読 for a staff whose last_read_at is older than
-- the newest incoming message on that chat. Staff without a row here have
-- never opened the chat.
--
-- staff_id stores staff_members.id (Bearer API key / session) or the pseudo
-- id 'env-owner' used by authenticateApiToken for the env API_KEY fallback.
CREATE TABLE IF NOT EXISTS chat_read_states (
  chat_id      TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  staff_id     TEXT NOT NULL,
  last_read_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (chat_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_read_states_staff ON chat_read_states (staff_id);
