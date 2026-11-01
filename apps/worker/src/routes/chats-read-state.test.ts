import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import { chats } from './chats.js';

const schema = readFileSync(new URL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');

// 既読未読は authMiddleware が解決した c.staff 単位。テストではミドルウェアで
// 直に積んで、worker 側の既読記録 / 一覧の viewerUnread を実 D1 (sqlite) で検証する。
type StaffVar = { id: string; name: string; role: 'owner' | 'admin' | 'staff' };
function staffApp(staffId: string) {
  const app = new Hono<{ Variables: { staff: StaffVar } }>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: staffId, name: 'S', role: 'owner' });
    await next();
  });
  app.route('/', chats);
  return app;
}

describe('chat list search + per-staff read state', () => {
  let fixture: ReturnType<typeof sqliteD1>;

  beforeEach(() => {
    fixture = sqliteD1();
    fixture.sqlite.exec(schema);
    fixture.sqlite.prepare('INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES(?,?,?,?,?)')
      .run('account-a', 'channel-a', 'Synthetic', 'token-a', 'secret');
    fixture.sqlite.prepare('INSERT INTO friends(id,line_user_id,line_account_id,display_name,nickname) VALUES(?,?,?,?,?)')
      .run('friend-a', 'line-a', 'account-a', 'LINE名A', '管理名A');
    fixture.sqlite.prepare('INSERT INTO friends(id,line_user_id,line_account_id,display_name,nickname) VALUES(?,?,?,?,?)')
      .run('friend-b', 'line-b', 'account-a', 'LINE名B', null);
    fixture.sqlite.prepare("INSERT INTO chats(id,friend_id,status) VALUES('chat-a','friend-a','in_progress')").run();
    fixture.sqlite.prepare("INSERT INTO chats(id,friend_id,status) VALUES('chat-b','friend-b','unread')").run();
    // friend-a: 管理名Aを名乗り、未読の incoming 1件 (=staff-a 未読)
    fixture.sqlite.prepare(
      "INSERT INTO messages_log(id,friend_id,direction,message_type,content,created_at) VALUES(?,'friend-a','incoming','text','hello a','2026-08-12T20:00:00.000+09:00')",
    ).run('m1');
    // friend-b: incoming の直後に staff-a が既読済みでも、staff-b (id 変える) 未読を
    // 見れるよう texts は1件だけ。別friendの既読状態は read_states で別管理。
    fixture.sqlite.prepare(
      "INSERT INTO messages_log(id,friend_id,direction,message_type,content,created_at) VALUES(?,'friend-b','incoming','text','hello b','2026-08-12T20:10:00.000+09:00')",
    ).run('m2');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No real network allowed in this test'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fixture.sqlite.close();
  });

  it('search matches the management name first and the LINE display name as fallback', async () => {
    for (const [query, expectCount] of [
      ['管理名A', 1],
      ['LINE名A', 1],
      ['LINE名B', 1],
      ['nothing-matches', 0],
    ] as const) {
      const app = staffApp('staff-a');
      const res = await app.request(
        `http://worker.test/api/chats?search=${encodeURIComponent(query)}`,
        {},
        { DB: fixture.db } as never,
      );
      const body = await res.json() as { data: Array<{ id: string }> };
      expect(body.data.map((r) => r.id), query).toHaveLength(expectCount);
      if (query === 'LINE名A') expect(body.data[0]?.id).toBe('friend-a');
    }
  });

  it('marks chats with a newer incoming message as viewerUnread for a fresh staff', async () => {
    const app = staffApp('staff-a');
    const res = await app.request('http://worker.test/api/chats', {}, { DB: fixture.db } as never);
    const body = await res.json() as { data: Array<{ id: string; viewerUnread: boolean; viewerLastReadAt: string | null }> };
    const byId = new Map(body.data.map((r) => [r.id, r]));

    // staff-a still unread — chat_read_states is empty.
    expect(byId.get('friend-a')!.viewerUnread).toBe(true);
    expect(byId.get('friend-b')!.viewerUnread).toBe(true);
    expect(byId.get('friend-a')!.viewerLastReadAt!).toBeNull();
  });

  it('records a read when the staff opens the chat and the badge flips to read', async () => {
    const app = staffApp('staff-a');
    const detail = await app.request('http://worker.test/api/chats/friend-a', {}, { DB: fixture.db } as never);
    expect(detail.status).toBe(200);

    // friend-b is a different chat; staff-a never opened it.
    const listed = await app.request('http://worker.test/api/chats', {}, { DB: fixture.db } as never);
    const body = await listed.json() as { data: Array<{ id: string; viewerUnread: boolean; viewerLastReadAt: string | null }> };
    const byId = new Map(body.data.map((r) => [r.id, r]));
    expect(byId.get('friend-a')!.viewerUnread).toBe(false);
    expect(byId.get('friend-a')!.viewerLastReadAt).toBeTruthy();
    // 同じ staff-a でも friend-b (未オープン) はまだ未読。
    expect(byId.get('friend-b')!.viewerUnread).toBe(true);
    expect(byId.get('friend-b')!.viewerLastReadAt).toBeNull();

    // 既読 row は staff-a に紐づいて記録されている。
    const rows = fixture.sqlite.prepare('SELECT chat_id, staff_id FROM chat_read_states ORDER BY staff_id').all() as Array<{ chat_id: string; staff_id: string }>;
    expect(rows).toEqual([{ chat_id: 'chat-a', staff_id: 'staff-a' }]);
  });

  // 別スタッフの既読が自分には波及しない — 「スタッフごとの既読未読」の核心。
  it('keeps read state per staff: another staff still sees unread', async () => {
    const readApp = staffApp('staff-a');
    await readApp.request('http://worker.test/api/chats/friend-a');

    const app = staffApp('staff-b');
    const listed = await app.request('http://worker.test/api/chats', {}, { DB: fixture.db } as never);
    const body = await listed.json() as { data: Array<{ id: string; viewerUnread: boolean }> };
    const byId = new Map(body.data.map((r) => [r.id, r]));
    expect(byId.get('friend-a')!.viewerUnread).toBe(true);
    expect(byId.get('friend-b')!.viewerUnread).toBe(true);
  });

  // 新しい incoming が既読より後に届いたら未読に戻る。テストでは実時間と
  // 比較しない — 既読時刻は jstNow() (実時間) なので、m3 の時刻は明確に未来に置く。
  it('re-flags unread when a new incoming message arrives after last_read_at', async () => {
    const app = staffApp('staff-a');
    await app.request('http://worker.test/api/chats/friend-a', {}, { DB: fixture.db } as never);
    fixture.sqlite.prepare(
      "INSERT INTO messages_log(id,friend_id,direction,message_type,content,created_at) VALUES(?,'friend-a','incoming','text','again','2099-01-01T21:30:00.000+09:00')",
    ).run('m3');

    const listed = await app.request('http://worker.test/api/chats', {}, { DB: fixture.db } as never);
    const body = await listed.json() as { data: Array<{ id: string; viewerUnread: boolean }> };
    expect(body.data.find((r) => r.id === 'friend-a')!.viewerUnread).toBe(true);
  });
});
