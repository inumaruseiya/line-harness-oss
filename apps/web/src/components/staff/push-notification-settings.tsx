'use client'

import { LayerCard } from '@cloudflare/kumo/components/layer-card'
import { Button } from '@cloudflare/kumo/components/button'
import { Banner } from '@cloudflare/kumo/components/banner'
import { usePushNotifications } from '@/hooks/use-push-notifications'

export default function PushNotificationSettings() {
  const { permission, subscribed, error, subscribe, unsubscribe } = usePushNotifications()

  if (permission === 'unsupported') return null

  return (
    <LayerCard className="mb-6 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-kumo-strong">新着メッセージのプッシュ通知</h2>
          <p className="mt-1 text-sm text-kumo-subtle">
            友だちからメッセージが届いたとき、このブラウザに通知を表示します。
          </p>
        </div>
        {subscribed ? (
          <Button type="button" variant="secondary" onClick={() => void unsubscribe()}>
            通知を無効にする
          </Button>
        ) : (
          <Button type="button" variant="primary" onClick={() => void subscribe()} disabled={permission === 'denied'}>
            通知を有効にする
          </Button>
        )}
      </div>
      {permission === 'denied' ? (
        <Banner
          className="mt-4"
          size="sm"
          variant="alert"
          title="ブラウザの通知が拒否されています"
          description="ブラウザのサイト設定から通知を許可し、ページを再読み込みしてください。"
        />
      ) : null}
      {error ? (
        <Banner
          className="mt-4"
          size="sm"
          variant="error"
          title="通知の設定に失敗しました"
          description={error}
        />
      ) : null}
    </LayerCard>
  )
}
