import { api } from './api';

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function pushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/sw.js');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Ask permission, subscribe this browser and register it with the API. */
export async function enableBrowserPush(): Promise<'enabled' | 'denied' | 'unavailable'> {
  if (!pushSupported()) return 'unavailable';
  const cfg = await api.push.config();
  if (!cfg.webPush || !cfg.vapidPublicKey) return 'unavailable';
  if ((await Notification.requestPermission()) !== 'granted') return 'denied';
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(cfg.vapidPublicKey) });
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api.push.subscribe({ kind: 'webpush', endpoint: json.endpoint, keys: json.keys });
  return 'enabled';
}

export async function disableBrowserPush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.push.unsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

/**
 * Opening a chat: the browser's notification about its new messages goes (the API sends them with
 * the tag `message:<chat id>`, and clears its own when the chat is read).
 */
export async function closeChatNotifications(conversationId: string) {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    for (const n of (await reg?.getNotifications({ tag: `message:${conversationId}` })) ?? []) n.close();
  } catch {
    // Nothing to close.
  }
}
