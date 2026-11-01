-- Operator-assigned friend nickname (管理名).
--
-- LINE does not expose an official-account-side rename to the Messaging API, so
-- operators need a place to persist a management name of their own. Stored in a
-- dedicated column instead of inside `metadata` so it stays first-class:
-- (`nickname` is queried by COALESCE in list/search SQL and must survive
-- follow-webhook profile upserts untouched — upsertFriend does not touch this
-- column on purpose.)
ALTER TABLE friends ADD COLUMN nickname TEXT;
