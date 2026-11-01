'use client'
import { useEffect, useState } from 'react'
import { api, ApiError } from '@/lib/api'

function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return `${fallback} (${err.status} ${err.path ?? ''})`
  if (err instanceof Error) return `${fallback}: ${err.message}`
  return fallback
}

// 標準的な VAPID 公開鍵 → applicationServerKey 変換
function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4)
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export type PushPermissionState = NotificationPermission | 'unsupported'

export function usePushNotifications(): {
  permission: PushPermissionState
  subscribed: boolean
  error: string | null
  subscribe: () => Promise<void>
  unsubscribe: () => Promise<void>
} {
  const [permission, setPermission] = useState<PushPermissionState>('default')
  const [subscribed, setSubscribed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator)) {
      setPermission('unsupported')
      return
    }
    setPermission(Notification.permission)
    navigator.serviceWorker.register('/sw.js').catch((err) => console.error('[push] SW registration failed', err))
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setSubscribed(!!sub))
      .catch(() => {})
  }, [])

  async function subscribe(): Promise<void> {
    setError(null)

    const perm = await Notification.requestPermission()
    setPermission(perm)
    if (perm !== 'granted') return

    let reg: ServiceWorkerRegistration
    try {
      reg = await navigator.serviceWorker.ready
    } catch (err) {
      console.error('[push] service worker not ready', err)
      setError(describeError(err, 'Service Workerの準備に失敗'))
      return
    }

    let publicKey: string
    try {
      const keyRes = await api.push.getVapidPublicKey()
      if (!keyRes.success) throw new Error(keyRes.error)
      publicKey = keyRes.data.publicKey
    } catch (err) {
      console.error('[push] vapid key fetch failed', err)
      setError(describeError(err, 'VAPID鍵の取得に失敗'))
      return
    }

    let endpoint: string, p256dh: string, auth: string
    try {
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      })
      const json = sub.toJSON()
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error('ブラウザから購読情報を取得できませんでした')
      }
      endpoint = json.endpoint
      p256dh = json.keys.p256dh
      auth = json.keys.auth
    } catch (err) {
      console.error('[push] pushManager.subscribe failed', err)
      setError(describeError(err, 'ブラウザの購読作成に失敗'))
      return
    }

    try {
      const subscribeRes = await api.push.subscribe({ endpoint, keys: { p256dh, auth } })
      if (!subscribeRes.success) throw new Error(subscribeRes.error)
      setSubscribed(true)
    } catch (err) {
      console.error('[push] server registration failed', err)
      setError(describeError(err, 'サーバーへの登録に失敗'))
      setSubscribed(false)
    }
  }

  async function unsubscribe(): Promise<void> {
    setError(null)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await api.push.unsubscribe(sub.endpoint)
        await sub.unsubscribe()
      }
      setSubscribed(false)
    } catch (err) {
      console.error('[push] unsubscribe failed', err)
      setError(err instanceof Error ? err.message : '通知の解除に失敗しました')
    }
  }

  return { permission, subscribed, error, subscribe, unsubscribe }
}
