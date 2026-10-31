'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

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
  subscribe: () => Promise<void>
  unsubscribe: () => Promise<void>
} {
  const [permission, setPermission] = useState<PushPermissionState>('default')
  const [subscribed, setSubscribed] = useState(false)

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
    const perm = await Notification.requestPermission()
    setPermission(perm)
    if (perm !== 'granted') return

    const reg = await navigator.serviceWorker.ready
    const keyRes = await api.push.getVapidPublicKey()
    if (!keyRes.success) throw new Error('Push notifications are not configured on the server')

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(keyRes.data.publicKey) as BufferSource,
    })
    const json = sub.toJSON()
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      throw new Error('Push subscription is missing required fields')
    }
    await api.push.subscribe({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    })
    setSubscribed(true)
  }

  async function unsubscribe(): Promise<void> {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) {
      await api.push.unsubscribe(sub.endpoint)
      await sub.unsubscribe()
    }
    setSubscribed(false)
  }

  return { permission, subscribed, subscribe, unsubscribe }
}
