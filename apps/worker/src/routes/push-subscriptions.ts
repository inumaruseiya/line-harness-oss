import { Hono } from 'hono';
import { upsertPushSubscription, deletePushSubscriptionByEndpoint } from '@line-crm/db';
import type { Env } from '../index.js';

const pushSubscriptions = new Hono<Env>();

// Exposes the VAPID public key so the frontend's pushManager.subscribe() can
// use it as the applicationServerKey. Still behind normal auth since only the
// already-logged-in admin SPA ever calls it.
pushSubscriptions.get('/api/push/vapid-public-key', async (c) => {
  if (!c.env.VAPID_PUBLIC_KEY) {
    return c.json({ success: false, error: 'Push notifications are not configured' }, 503);
  }
  return c.json({ success: true, data: { publicKey: c.env.VAPID_PUBLIC_KEY } });
});

pushSubscriptions.post('/api/push/subscriptions', async (c) => {
  const staff = c.get('staff');
  if (!staff) return c.json({ success: false, error: 'Unauthorized' }, 401);

  const body = await c.req.json<{
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
    lineAccountId?: string | null;
  }>().catch(() => null);

  if (!body?.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    return c.json({ success: false, error: 'endpoint and keys.{p256dh,auth} are required' }, 400);
  }

  await upsertPushSubscription(c.env.DB, {
    staffId: staff.id,
    lineAccountId: body.lineAccountId ?? null,
    endpoint: body.endpoint,
    p256dh: body.keys.p256dh,
    auth: body.keys.auth,
    userAgent: c.req.header('User-Agent') ?? null,
  });

  return c.json({ success: true }, 201);
});

pushSubscriptions.delete('/api/push/subscriptions', async (c) => {
  const staff = c.get('staff');
  if (!staff) return c.json({ success: false, error: 'Unauthorized' }, 401);

  const body = await c.req.json<{ endpoint?: string }>().catch(() => null);
  if (!body?.endpoint) return c.json({ success: false, error: 'endpoint is required' }, 400);

  await deletePushSubscriptionByEndpoint(c.env.DB, body.endpoint);
  return c.json({ success: true });
});

export { pushSubscriptions };
