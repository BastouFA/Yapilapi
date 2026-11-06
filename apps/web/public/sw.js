// YAPILAPI service worker: shows push notifications and opens the right page on tap.
self.addEventListener('push', (event) => {
  let data = { title: 'YAPILAPI', body: 'You have a new notification.', url: '/notifications', tag: undefined, renotify: undefined };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    /* plain text or empty payload */
  }
  // A chat message reached this device, even with the app closed: its sender sees "Delivered".
  const delivered =
    typeof data.tag === 'string' && data.tag.startsWith('message:')
      ? fetch('/api/v1/me/delivered', { method: 'POST', credentials: 'include' }).catch(() => {})
      : Promise.resolve();
  event.waitUntil(
    Promise.all([
      delivered,
      self.registration.showNotification(data.title, {
        body: data.body,
        tag: data.tag,
        // A chat's notification is replaced by each new message: it rings or buzzes again unless the
        // server says this one is a quiet update (more messages a moment after the last).
        renotify: !!data.tag && data.renotify !== false,
        icon: '/mark.svg',
        badge: '/mark.svg',
        data: { url: data.url },
      }),
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/notifications', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => w.url.startsWith(self.location.origin));
      if (open) {
        open.navigate(url);
        return open.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});

// A page says a chat was read (lib/push.ts): its notification goes from this device.
self.addEventListener('message', (event) => {
  const ids = event.data?.type === 'chats-read' && Array.isArray(event.data.ids) ? event.data.ids : [];
  if (!ids.length) return;
  event.waitUntil(
    self.registration.getNotifications().then((list) => {
      for (const n of list) if (ids.some((id) => n.tag === `message:${id}`)) n.close();
    }),
  );
});
