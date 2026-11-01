import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getStaffByApiKey: vi.fn().mockResolvedValue(null),
  getFriendById: vi.fn(),
  getFriendTags: vi.fn(),
  updateFriendNickname: vi.fn(),
  jstNow: vi.fn(() => '2026-10-31T00:00:00.000+09:00'),
};
vi.mock('@line-crm/db', () => dbMocks);
vi.mock('../services/event-bus.js', () => ({ fireEvent: vi.fn() }));
vi.mock('../services/step-delivery.js', () => ({ buildMessage: vi.fn() }));

const { authMiddleware } = await import('../middleware/auth.js');
const { friends } = await import('./friends.js');
type Env = import('../index.js').Env;

const API_KEY = 'test-owner-key';

const db = {} as unknown as D1Database;
const env = { DB: db, API_KEY } as unknown as Env['Bindings'];

function putDisplayName(body: unknown) {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', friends);
  return instance.request(
    '/api/friends/f-1/display-name',
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getStaffByApiKey.mockResolvedValue(null);
  dbMocks.getFriendTags.mockResolvedValue([]);
  dbMocks.updateFriendNickname.mockResolvedValue(undefined);
  dbMocks.getFriendById.mockResolvedValue({
    id: 'f-1',
    display_name: 'LINE taro',
    nickname: null,
    metadata: '{}',
  });
});

describe('PUT /api/friends/:id/display-name', () => {
  test('persists a trimmed nickname and echoes the coalesced displayName', async () => {
    dbMocks.getFriendById
      .mockResolvedValueOnce({ id: 'f-1', display_name: 'LINE taro', nickname: null, metadata: '{}' })
      .mockResolvedValueOnce({ id: 'f-1', display_name: 'LINE taro', nickname: '山田', metadata: '{}' });

    const res = await putDisplayName({ nickname: '  山田  ' });
    const body = (await res.json()) as { data: { displayName: string | null; nickname: string | null; lineName: string | null } };

    expect(res.status).toBe(200);
    expect(dbMocks.updateFriendNickname).toHaveBeenCalledWith(expect.anything(), 'f-1', '山田');
    // displayName follows the management name once it is set.
    expect(body.data.displayName).toBe('山田');
    expect(body.data.nickname).toBe('山田');
    expect(body.data.lineName).toBe('LINE taro');
  });

  // 空文字は「解除」: NULL を保存してLINE表示名に戻す。空文字という管理名を
  // 残すと一覧が名前なしになり、解除の意味をなさない。
  test('clears the nickname for an empty string', async () => {
    const res = await putDisplayName({ nickname: '   ' });

    expect(res.status).toBe(200);
    expect(dbMocks.updateFriendNickname).toHaveBeenCalledWith(expect.anything(), 'f-1', null);
  });

  test('clears the nickname when null is passed', async () => {
    const res = await putDisplayName({ nickname: null });

    expect(res.status).toBe(200);
    expect(dbMocks.updateFriendNickname).toHaveBeenCalledWith(expect.anything(), 'f-1', null);
  });

  test('rejects non-string values', async () => {
    const res = await putDisplayName({ nickname: 42 });

    expect(res.status).toBe(400);
    expect(dbMocks.updateFriendNickname).not.toHaveBeenCalled();
  });

  test('rejects over-long nicknames', async () => {
    const res = await putDisplayName({ nickname: 'あ'.repeat(101) });

    expect(res.status).toBe(422);
    expect(dbMocks.updateFriendNickname).not.toHaveBeenCalled();
  });

  test('returns 404 for an unknown friend', async () => {
    dbMocks.getFriendById.mockResolvedValue(null);

    const res = await putDisplayName({ nickname: '山田' });

    expect(res.status).toBe(404);
    expect(dbMocks.updateFriendNickname).not.toHaveBeenCalled();
  });

  // 他のオペレーター用ルートの律儀: 未認証は先で落ちる。
  test('requires authentication', async () => {
    const instance = new Hono<Env>();
    instance.use('*', authMiddleware);
    instance.route('/', friends);
    const res = await instance.request(
      '/api/friends/f-1/display-name',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: 'x' }) },
      env,
    );

    expect(res.status).toBe(401);
    expect(dbMocks.updateFriendNickname).not.toHaveBeenCalled();
  });
});
