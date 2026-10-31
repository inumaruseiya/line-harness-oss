# Web Push 通知 (リッチプッシュ)

LINE友だちから個別メッセージを受信したとき、スタッフのブラウザ/PWAに
LINEスタイルのプッシュ通知（送信者名・アバター・本文プレビュー）を送る機能。

- 実装: `apps/worker/src/services/web-push.ts`（VAPID署名 + RFC 8291 暗号化を
  Web Crypto APIで自前実装。Node専用の `web-push` npmパッケージは使えないため）
- DB: `push_subscriptions` テーブル（`packages/db/migrations/076_push_subscriptions.sql`）
- 送信トリガー: `apps/worker/src/routes/webhook.ts` の受信メッセージ処理
  （postbackと自動応答マッチ時は送らない）

## VAPID鍵の生成

デプロイ全体で1組の鍵ペアを使う（アカウント単位の鍵分離はしない）。Node 18+
またはブラウザのコンソールで以下を実行し、公開鍵・秘密鍵をbase64url化する:

```js
const keyPair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);
const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
const privateKeyPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));

function toBase64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

console.log('VAPID_PUBLIC_KEY=', toBase64Url(publicKeyRaw));
console.log('VAPID_PRIVATE_KEY=', toBase64Url(privateKeyPkcs8));
```

登録:

```sh
wrangler secret put VAPID_PUBLIC_KEY
wrangler secret put VAPID_PRIVATE_KEY
```

`wrangler.toml` の `[vars]` に `VAPID_SUBJECT`（`mailto:admin@example.com` など、
VAPID JWTの `sub` クレームに使う連絡先）を追加する。

**注意**: 鍵をローテーションすると、既存の全購読（ブラウザ側のpush
subscription）は無効になり、スタッフは再度通知を有効化し直す必要がある。

## 通知先・対象メッセージ

- 通知先: 受信メッセージの `friends.line_account_id` に紐づく全スタッフ
  （`push_subscriptions.line_account_id` が `NULL` の購読は全アカウント対象）
- 対象: テキスト・画像・スタンプ等すべての受信メッセージ
- 対象外: postback（リッチメニュー操作）、自動応答が即時マッチしたテキスト
  メッセージ（既存の `upsertChatOnMessage` のスキップ条件と同じ）

## フロントエンド

- `apps/web/public/manifest.json` / `apps/web/public/sw.js` — Service Worker
- `apps/web/src/hooks/use-push-notifications.ts` — 通知許諾・購読フロー
- アカウント設定画面のトグルから有効化/無効化できる
