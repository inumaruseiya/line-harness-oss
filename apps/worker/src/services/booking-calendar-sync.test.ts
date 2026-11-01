import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1 } from '../test-support/sqlite-d1.js';
import { syncConfirmedBookingToGoogle } from './booking-calendar-sync.js';

const schema = readFileSync(new URL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');

// Google 連携のイベント文面: TimeTree が Google カレンダーの予定を
// ホームカレンダー表示しても 人/担当がタイトルから判別できるよう
// 「管理名(f.nickname 優先)｜担当者名」形式と、メニューは description 側へ
// 移した契約を固定する。verify-with-synthetic-data 方針に従い、実 fetch は禁止。
describe('syncConfirmedBookingToGoogle event wording', () => {
  type FetchCall = { url: string; init: RequestInit };
  let fixture: ReturnType<typeof sqliteD1>;
  let calls: FetchCall[];

  const seed = (friend: { nickname: string | null; display_name: string },
                staff: { display_name: string; name: string }) => {
    fixture.sqlite.prepare(
      'INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES(?,?,?,?,?)',
    ).run('account-a', 'channel-a', 'Synthetic', 'token-a', 'secret');
    fixture.sqlite.prepare(
      'INSERT INTO staff(id,line_account_id,name,display_name,is_active) VALUES(?,?,?,?,1)',
    ).run('staff-a', 'account-a', staff.name, staff.display_name);
    fixture.sqlite.prepare(
      'INSERT INTO menus(id,line_account_id,name,duration_minutes,buffer_after_minutes,base_price,is_active) VALUES(?,?,?,60,0,5000,1)',
    ).run('menu-a', 'account-a', 'カラー 60分');
    fixture.sqlite.prepare(
      'INSERT INTO google_calendar_connections(id,line_account_id,staff_id,calendar_id,auth_type,access_token,refresh_token,is_active) '
        + "VALUES('gc-a','account-a','staff-a','primary','oauth','tok',NULL,1)",
    ).run();
    fixture.sqlite.prepare(
      'INSERT INTO friends(id,line_user_id,line_account_id,display_name,nickname) VALUES(?,?,?,?,?)',
    ).run('friend-a', 'line-a', 'account-a', friend.display_name, friend.nickname);
    const ins = fixture.sqlite.prepare(
      `INSERT INTO bookings(id,line_account_id,friend_id,staff_id,menu_id,starts_at,ends_at,block_ends_at,status,customer_note,price_at_booking,requested_at)
       VALUES('bk-a','account-a','friend-a','staff-a','menu-a',?,?,?,?,?,5000,?)`,
    );
    ins.run('2026-11-10T02:00:00.000Z', '2026-11-10T03:00:00.000Z', '2026-11-10T03:00:00.000Z', 'confirmed', null, '2026-11-01T00:00:00.000Z');
  };

  const eventBody = () => {
    const post = calls.filter((c) => c.url.includes('/events') && c.init.method === 'POST');
    expect(post).toHaveLength(1);
    return JSON.parse(post[0].init.body as string);
  };

  beforeEach(() => {
    fixture = sqliteD1();
    fixture.sqlite.exec(schema);
    calls = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      // service account token mint への実リクエストを禁止しつつ accessToken 発行をふり
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'fake-access', expires_in: 3600 }), { status: 200 });
      }
      calls.push({ url, init: init ?? {} });
      if (url.includes('calendar/v3') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'gcal-event-1' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fixture.sqlite.close();
  });

  // auth_type='oauth' + access_token 直接: トークン発行系の env/署名には触れない。
  const credentials = { oauthClientId: '', oauthClientSecret: '' } as never;

  it('builds the event title as 管理名(優先)｜担当者名 and moves the menu to the description', async () => {
    seed({ nickname: '管理名A', display_name: 'LINE名A' }, { display_name: '表示担当', name: '管理担当' });
    const result = await syncConfirmedBookingToGoogle(fixture.db, credentials, 'bk-a');
    expect(result.synced).toBe(true);
    expect(eventBody().summary).toBe('管理名A｜表示担当');
    expect(eventBody().description).toContain('メニュー: カラー 60分');
    expect(eventBody().description).toContain('担当: 表示担当');
  });

  it('falls back to the LINE display name when no nickname, and to staff.name when display_name is blank', async () => {
    seed({ nickname: null, display_name: 'LINE名B' }, { display_name: '', name: '管理担当B' });
    await syncConfirmedBookingToGoogle(fixture.db, credentials, 'bk-a');
    expect(eventBody().summary).toBe('LINE名B｜管理担当B');
  });
});
