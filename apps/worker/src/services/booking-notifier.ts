import { LineClient } from '@line-crm/line-sdk';

export type NotificationKind =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'day_before'
  | 'hours_before';

export interface NotificationContext {
  menuName: string;
  staffName: string;
  startsAtJst: string; // 例: "2026-05-10 14:00"
  hoursBefore: number;
}

export function renderNotificationText(
  kind: NotificationKind,
  ctx: NotificationContext,
): string {
  const detail = `\nメニュー: ${ctx.menuName}\n担当: ${ctx.staffName}\n日時: ${ctx.startsAtJst}`;
  switch (kind) {
    case 'requested':
      return `予約リクエストを受け付けました。${detail}\n\nお店からの返信をお待ちください。`;
    case 'approved':
      return `予約が確定しました。${detail}\n\n変更・キャンセルはお店に直接ご連絡ください。`;
    case 'rejected':
      return `申し訳ありません、ご希望の枠でお取りできませんでした。\n別の日時で再度お試しください。`;
    case 'expired':
      return `予約リクエストが 24 時間返信が無かったため、期限切れになりました。${detail}`;
    case 'day_before':
      return `明日のご予約のお知らせです。${detail}`;
    case 'hours_before':
      return `本日のご予約まであと ${ctx.hoursBefore} 時間です。${detail}`;
  }
}

export interface SendNotificationParams {
  channelAccessToken: string;
  toLineUserId: string;
  kind: NotificationKind;
  ctx: NotificationContext;
  /**
   * 送信ログ用。指定すると push 成功後に messages_log へ outgoing を書く。
   * source='auto_reply' (delivery_type NULL) — 管理画面の個別チャットはこの
   * source に「自動返信」ラベルを付けて表示するため、予約系自動通知も会話
   * スレッド内で判別可能になる。DB 書き込み失敗はpush 本体を失敗させない。
   */
  log?: { db: D1Database; friendId: string };
}

export async function sendBookingNotification(params: SendNotificationParams): Promise<void> {
  const text = renderNotificationText(params.kind, params.ctx);
  const client = new LineClient(params.channelAccessToken);
  await client.pushMessage(params.toLineUserId, [{ type: 'text', text }]);

  // push 送信成功後の best-effort 証跡書き込み。
  if (params.log) {
    try {
      await params.log.db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, created_at)
           VALUES (?, ?, 'outgoing', 'text', ?, 'auto_reply',
                   strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))`,
        )
        .bind(crypto.randomUUID(), params.log.friendId, text)
        .run();
    } catch (err) {
      console.error(`booking notification messages_log write failed (${params.kind}):`, err);
    }
  }
}

export type BookingNotificationSender = (params: SendNotificationParams) => Promise<void>;
