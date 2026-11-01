/**
 * Events / event bookings 共有ヘルパー。
 *
 * Worker 側の events ルート (apps/worker/src/routes/events.ts) はテナント固有の
 * snake_case 形状で、{} でラップされない素の行を返す (CRM 系の ApiResponse
 * とは違う)。MCP ツールは camelCase を受け付けてから snake_case に変換する。
 */

/** LINE アカウント ID。引数が無ければ既定 (LINE_HARNESS_ACCOUNT_ID) を使う。 */
export function resolveAccountId(accountId?: string): string {
  const id = accountId ?? process.env.LINE_HARNESS_ACCOUNT_ID;
  if (!id) {
    throw new Error(
      "accountId is required (pass it explicitly or set LINE_HARNESS_ACCOUNT_ID)",
    );
  }
  return id;
}

/** クエリ文字列組み立て。account_id は必ず入る。 */
export function eventsQuery(accountId: string, extra?: Record<string, string | undefined>): string {
  const sp = new URLSearchParams({ account_id: accountId });
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v !== undefined && v !== "") sp.set(k, v);
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

export interface SlotInput {
  startsAt?: string;
  endsAt?: string;
  capacity?: number | null;
  isActive?: number;
  sortOrder?: number;
}

export interface MappedSlot {
  starts_at: string;
  ends_at: string;
  capacity: number | null;
  is_active: number;
  sort_order: number;
}

/** MCP スロット入力 (camelCase) → Worker の slots[] 要素 (snake_case)。 */
export function mapSlot(s: SlotInput): MappedSlot {
  if (!s.startsAt || !s.endsAt) {
    throw new Error("each slot needs startsAt and endsAt (UTC ISO8601, e.g. 2026-11-10T02:00:00Z)");
  }
  return {
    starts_at: s.startsAt,
    ends_at: s.endsAt,
    capacity: s.capacity ?? null,
    is_active: s.isActive ?? 1,
    sort_order: s.sortOrder ?? 0,
  };
}
