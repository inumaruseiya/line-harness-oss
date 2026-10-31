self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'L Harness', body: event.data ? event.data.text() : '' }
  }

  const title = data.title || 'L Harness'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body,
      icon: data.icon || '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag,
      data: { url: data.url || '/chats' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification.data && event.notification.data.url ? event.notification.data.url : '/chats'

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const targetPath = new URL(targetUrl, self.location.origin).pathname
      for (const client of list) {
        if (client.url.includes(targetPath) && 'focus' in client) {
          return client.focus()
        }
      }
      if (list.length > 0 && 'navigate' in list[0]) {
        return list[0].navigate(targetUrl).then(() => list[0].focus())
      }
      return clients.openWindow(targetUrl)
    }),
  )
})
