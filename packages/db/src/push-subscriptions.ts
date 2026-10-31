import { jstNow } from './utils.js';

export interface PushSubscriptionRow {
  id: string;
  staff_id: string;
  line_account_id: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
  updated_at: string;
}

export async function upsertPushSubscription(
  db: D1Database,
  input: {
    staffId: string;
    lineAccountId?: string | null;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string | null;
  },
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO push_subscriptions (id, staff_id, line_account_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         staff_id = excluded.staff_id,
         line_account_id = excluded.line_account_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent,
         updated_at = excluded.updated_at`,
    )
    .bind(
      crypto.randomUUID(),
      input.staffId,
      input.lineAccountId ?? null,
      input.endpoint,
      input.p256dh,
      input.auth,
      input.userAgent ?? null,
      now,
      now,
    )
    .run();
}

export async function deletePushSubscriptionByEndpoint(db: D1Database, endpoint: string): Promise<void> {
  await db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(endpoint).run();
}

export async function deletePushSubscriptionsByStaff(db: D1Database, staffId: string): Promise<void> {
  await db.prepare(`DELETE FROM push_subscriptions WHERE staff_id = ?`).bind(staffId).run();
}

/**
 * Subscriptions that should receive a push for an inbound message on the given
 * LINE account: everyone whose subscription is unscoped (line_account_id IS
 * NULL) plus anyone explicitly scoped to this account, excluding deactivated
 * staff. Uses a LEFT JOIN because staff_id may be the 'env-owner' pseudo id
 * (authenticateApiToken's env API_KEY fallback, see chat_read_states), which
 * has no row in staff_members at all and should still count as active.
 */
export async function getPushSubscriptionsForLineAccount(
  db: D1Database,
  lineAccountId: string | null,
): Promise<PushSubscriptionRow[]> {
  const result = await db
    .prepare(
      `SELECT ps.* FROM push_subscriptions ps
       LEFT JOIN staff_members sm ON sm.id = ps.staff_id
       WHERE (sm.is_active = 1 OR sm.id IS NULL)
         AND (ps.line_account_id IS NULL OR ps.line_account_id = ?)`,
    )
    .bind(lineAccountId)
    .all<PushSubscriptionRow>();
  return result.results;
}

export async function pruneInvalidPushSubscription(db: D1Database, endpoint: string): Promise<void> {
  await deletePushSubscriptionByEndpoint(db, endpoint);
}
