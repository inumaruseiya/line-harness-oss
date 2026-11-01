import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { sqliteD1 } from '../test-support/sqlite-d1.js';

vi.mock('@line-crm/line-sdk', () => {
  return {
    LineClient: class {
      pushed: unknown[][] = [];
      constructor(public channelAccessToken: string) {}
      async pushMessage(to: string, messages: unknown[]) {
        this.pushed.push(messages);
        return {};
      }
    },
  };
});

import { sendBookingNotification, renderNotificationText } from './booking-notifier.js';

const schema = readFileSync(new URL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');

const ctx = {
  menuName: 'カット',
  staffName: '山田',
  startsAtJst: '2026-05-10 14:00',
  hoursBefore: 2,
};

describe('renderNotificationText', () => {
  test('受付', () => {
    const text = renderNotificationText('requested', ctx);
    expect(text).toContain('予約リクエストを受け付けました');
    expect(text).toContain('カット');
    expect(text).toContain('山田');
    expect(text).toContain('2026-05-10 14:00');
    expect(text).toContain('お店からの返信をお待ちください');
  });
  test('承認', () => {
    const text = renderNotificationText('approved', ctx);
    expect(text).toContain('予約が確定しました');
    expect(text).toContain('変更・キャンセルはお店に直接ご連絡ください');
  });
  test('拒否', () => {
    expect(renderNotificationText('rejected', ctx)).toContain('お取りできませんでした');
  });
  test('期限切れ', () => {
    expect(renderNotificationText('expired', ctx)).toContain('期限切れ');
  });
  test('前日リマインダ', () => {
    expect(renderNotificationText('day_before', ctx)).toContain('明日のご予約');
  });
  test('当日 N 時間前', () => {
    const t = renderNotificationText('hours_before', ctx);
    expect(t).toContain('本日のご予約まであと 2 時間');
  });
});

// push 送信後に messages_log へ source='auto_reply' の outgoing を書くことで、
// 管理画面の個別チャットに「自動返信」ラベル付きで出ることの契約テスト。
// DB 書き込み失敗は push 本体を失敗させない (best-effort logging)。
describe('sendBookingNotification log', () => {
  let fixture: ReturnType<typeof sqliteD1>;

  beforeEach(() => {
    fixture = sqliteD1();
    fixture.sqlite.exec(schema);
  });

  afterEach(() => {
    fixture.sqlite.close();
  });

  function stubbedDb(simulateFailure = false) {
    const inserts: { sql: string; bound: unknown[] }[] = [];
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind: (...args: unknown[]) => {
            stmt.bound = args;
            return stmt;
          },
          bound: [] as unknown[],
          async run() {
            if (simulateFailure) throw new Error('D1 down');
            inserts.push({ sql, bound: stmt.bound });
            return { success: true, meta: { changes: 1 } };
          },
        };
        return stmt;
      },
    } as unknown as D1Database;
    return { db, inserts };
  }

  const notification = {
    channelAccessToken: 'tok',
    toLineUserId: 'U_test',
    kind: 'approved' as const,
    ctx: {
      menuName: 'カット',
      staffName: '山田',
      startsAtJst: '2026-05-10 14:00',
      hoursBefore: 0,
    },
  };

  test('writes an outgoing auto_reply row on success', async () => {
    const { db, inserts } = stubbedDb();
    await sendBookingNotification({ ...notification, log: { db, friendId: 'F1' } });
    expect(inserts).toHaveLength(1);
    const [id, friendId, content] = inserts[0].bound;
    expect(friendId).toBe('F1');
    expect(inserts[0].sql).toContain("source, created_at");
    expect(String(inserts[0].bound[0]).length).toBeGreaterThan(0);
    expect(content).toContain('予約が確定しました');
  });

  test('log failure does not break the notification', async () => {
    const { db } = stubbedDb(true);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      sendBookingNotification({ ...notification, log: { db, friendId: 'F1' } }),
    ).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('messages_log write failed'),
      expect.anything(),
    );
    consoleSpy.mockRestore();
  });

  test('no log param = no insert (既存呼び出しと互換)', async () => {
    await expect(sendBookingNotification(notification)).resolves.toBeUndefined();
  });
});
