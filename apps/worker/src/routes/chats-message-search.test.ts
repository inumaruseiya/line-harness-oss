import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import { chats } from './chats.js';
import { friends } from './friends.js';

const schema = readFileSync(new URL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');

describe('in-chat message search (?search=)', () => {
  let fixture: ReturnType<typeof sqliteD1>;

  beforeEach(() => {
    fixture = sqliteD1();
    fixture.sqlite.exec(schema);
    fixture.sqlite.prepare('INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES(?,?,?,?,?)')
      .run('account-a', 'channel-a', 'Synthetic', 'token-a', 'secret');
    fixture.sqlite.prepare('INSERT INTO friends(id,line_user_id,line_account_id,display_name) VALUES(?,?,?,?)')
      .run('friend-a', 'line-a', 'account-a', 'Synthetic friend');
    fixture.sqlite.prepare("INSERT INTO chats(id,friend_id,status) VALUES('chat-a','friend-a','in_progress')").run();
    // 送受信混合: 検索語「見積もり」を含むテキストが2件、非マッチ1件、flex 1件。
    fixture.sqlite.prepare(
      "INSERT INTO messages_log(id,friend_id,direction,message_type,content,created_at) VALUES(?,?,?,?,?,?)",
    ).run('m1-old', 'friend-a', 'outgoing', 'text', '見積もりは後ほど', '2026-08-12T19:00:00.000+09:00');
    fixture.sqlite.prepare(
      "INSERT INTO messages_log(id,friend_id,direction,message_type,content,created_at) VALUES(?,?,?,?,?,?)",
    ).run('m2-skip', 'friend-a', 'incoming', 'text', 'こんにちは', '2026-08-12T19:30:00.000+09:00');
    fixture.sqlite.prepare(
      "INSERT INTO messages_log(id,friend_id,direction,message_type,content,created_at) VALUES(?,?,?,?,?,?)",
    ).run('m3-flex', 'friend-a', 'outgoing', 'flex', '{"body":"見積もり"}', '2026-08-12T20:00:00.000+09:00');
    fixture.sqlite.prepare(
      "INSERT INTO messages_log(id,friend_id,direction,message_type,content,created_at) VALUES(?,?,?,?,?,?)",
    ).run('m4-hit', 'friend-a', 'incoming', 'text', '見積もりお願いします', '2026-08-12T20:30:00.000+09:00');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No real network allowed in this test'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fixture.sqlite.close();
  });

  // chat 詳細のメッセージ内検索。テキストのみ対象: flex JSON への誤ヒットを防ぐ。
  it('returns only matching text messages in chronological order on /api/chats/:id', async () => {
    const app = new Hono();
    app.route('/', chats);
    const res = await app.request(
      'http://worker.test/api/chats/friend-a?search=' + encodeURIComponent('見積もり'),
      {},
      { DB: fixture.db, LINE_CHANNEL_ACCESS_TOKEN: 'token-a' } as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { search?: string; searchTotal?: number; messages?: Array<{ id: string; messageType: string }> };
    };
    expect(body.data.search).toBe('見積もり');
    expect(body.data.searchTotal).toBe(2);
    expect(body.data.messages?.map((m) => m.id)).toEqual(['m1-old', 'm4-hit']);
    expect(body.data.messages?.every((m) => m.messageType === 'text')).toBe(true);
  });

  // ヒットなし → メッセージ配列は空だがチャット自体は 200 (composer / サイドバー維持)。
  it('returns an empty message list (not 404) when nothing matches', async () => {
    const app = new Hono();
    app.route('/', chats);
    const res = await app.request(
      'http://worker.test/api/chats/friend-a?search=' + encodeURIComponent('見つからない単語'),
      {},
      { DB: fixture.db, LINE_CHANNEL_ACCESS_TOKEN: 'token-a' } as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { searchTotal?: number; messages?: unknown[] } };
    expect(body.data.searchTotal).toBe(0);
    expect(body.data.messages).toEqual([]);
  });

  it('searches message history on /api/friends/:id/messages', async () => {
    const app = new Hono();
    app.route('/', friends);
    const res = await app.request(
      'http://worker.test/api/friends/friend-a/messages?search=' + encodeURIComponent('hello'),
      {},
      { DB: fixture.db } as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[] };
    expect(body.data).toEqual([]); // 'hello' はどのメッセージにも無い
  });

  // search 無し時は既存挙動と同じ (DESC 200 → 昇順化) でデグレしないこと。
  it('returns the full unfiltered history when search is absent', async () => {
    const app = new Hono();
    app.route('/', friends);
    const res = await app.request('http://worker.test/api/friends/friend-a/messages', {}, { DB: fixture.db } as never);
    const body = await res.json() as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toEqual(['m1-old', 'm2-skip', 'm3-flex', 'm4-hit']);
  });
});
