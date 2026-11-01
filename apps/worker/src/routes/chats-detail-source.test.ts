import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import { chats } from './chats.js';

const schema = readFileSync(new URL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');

// GET /api/chats/:id が各メッセージに source を付けて返すことの検証。
// 管理画面チャットで自動返信ラベルを付けるための API 側契約で、
// source / 配信型 / 外部キーのどれで判別できるかは conversations.ts と同一ルール。
describe('chat detail message source', () => {
  let fixture: ReturnType<typeof sqliteD1>;

  beforeEach(() => {
    fixture = sqliteD1();
    fixture.sqlite.exec(schema);
    fixture.sqlite.prepare('INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES(?,?,?,?,?)')
      .run('account-a', 'channel-a', 'Synthetic', 'token-a', 'secret');
    fixture.sqlite.prepare('INSERT INTO friends(id,line_user_id,line_account_id,display_name) VALUES(?,?,?,?)')
      .run('friend-a', 'line-a', 'account-a', 'LINE名A');
    fixture.sqlite.prepare("INSERT INTO chats(id,friend_id,status) VALUES('chat-a','friend-a','in_progress')").run();

    const ins = fixture.sqlite.prepare(
      "INSERT INTO messages_log(id,friend_id,direction,message_type,content,delivery_type,source,broadcast_id,scenario_step_id,created_at) VALUES(?,'friend-a',?,?,?,?,?,?,?,?)",
    );
    ins.run('m1', 'incoming', 'text', 'マイル', null, null, null, null, '2026-08-12T20:00:00.000+09:00');
    // 現行の auto-reply writer 移行: source='auto_reply' delivery_type='reply'
    ins.run('m2', 'outgoing', 'flex', '{"type":"flex"}', 'reply', 'auto_reply', null, null, '2026-08-12T20:00:02.000+09:00');
    // source が NULL の旧行 (migration 028 適用前) でも delivery_type='reply' から推論できる
    ins.run('m3', 'outgoing', 'text', '自働返信(旧行)', 'reply', null, null, null, '2026-08-12T20:01:00.000+09:00');
    // 推論が効かない outgoing は manual (オペレーター返信) 扱い
    ins.run('m4', 'outgoing', 'text', 'はい、対応します', null, null, null, null, '2026-08-12T20:02:00.000+09:00');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No real network allowed in this test'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fixture.sqlite.close();
  });

  const sourcesOf = async (query = '') => {
    const app = new Hono().route('/', chats);
    const res = await app.request(
      `http://worker.test/api/chats/friend-a${query}`,
      {},
      { DB: fixture.db } as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { messages: Array<{ id: string; source: string }> } };
    return Object.fromEntries(body.data.messages.map((m) => [m.id, m.source]));
  };

  it('returns explicit auto_reply source and infers it for legacy NULL-source rows', async () => {
    expect(await sourcesOf()).toEqual({
      m1: 'user',           // incoming → user
      m2: 'auto_reply',     // source カラムの値をそのまま
      m3: 'auto_reply',     // 旧行: delivery_type='reply' から推論
      m4: 'manual',         // 推論マーカーなしの outgoing はオペレーター返信
    });
  });

  it('search results carry the same attribution', async () => {
    // 検索 (テキストのみ) でも m3 が auto_reply と判別できること。
    expect(await sourcesOf('?search=%E8%87%AA%E5%83%8D')).toEqual({ m3: 'auto_reply' });
  });
});
