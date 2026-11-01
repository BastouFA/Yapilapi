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

let config: Promise<{ webPush: boolean; vapidPublicKey: string | null }> | null = null;

/** Whether the server sends browser notifications, and its key (asked once per page). */
export function pushConfig() {
  config ??= api.push.config().catch(() => {
    config = null;
    return { webPush: false, vapidPublicKey: null };
  });
  return config;
}

/**
 * Ask permission, subscribe this browser and register it with the API. Call it straight from a
 * tap: Safari on an iPhone only asks while the tap still counts, so permission is asked first.
 */
export async function enableBrowserPush(): Promise<'enabled' | 'denied' | 'unavailable'> {
  if (!pushSupported()) return 'unavailable';
  const asked = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (asked !== 'granted') return 'denied';
  const cfg = await pushConfig();
  if (!cfg.webPush || !cfg.vapidPublicKey) return 'unavailable';
  await registerHere(cfg.vapidPublicKey);
  setTurnedOff(false);
  return 'enabled';
}

/** This browser's subscription (made if it has none, or made again if it was for another key), told to the API. */
async function registerHere(vapidPublicKey: string) {
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const key = urlBase64ToUint8Array(vapidPublicKey);
  let sub = await reg.pushManager.getSubscription();
  const had = sub?.options.applicationServerKey;
  if (sub && had && !new Uint8Array(had).every((b, i) => b === key[i])) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api.push.subscribe({ kind: 'webpush', endpoint: json.endpoint, keys: json.keys });
}

const OFF_KEY = 'ypl.push.off';
function setTurnedOff(off: boolean) {
  try {
    if (off) localStorage.setItem(OFF_KEY, '1');
    else localStorage.removeItem(OFF_KEY);
  } catch {
    /* storage off: nothing to remember */
  }
}
function turnedOff() {
  try {
    return localStorage.getItem(OFF_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * On opening the app: notifications are allowed here, so the API must know this browser, for the
 * account signed in now. A phone can say "on" while the API has nothing for it (the request to
 * register failed, the address changed, another account was signed in), and then nothing ever
 * arrives. Not when the person turned them off in Settings, and it never asks for permission.
 */
export async function keepBrowserPush() {
  if (!pushSupported() || Notification.permission !== 'granted' || turnedOff()) return;
  const cfg = await pushConfig();
  if (cfg.webPush && cfg.vapidPublicKey) await registerHere(cfg.vapidPublicKey);
}

/** `turnOff`: the person's own choice (Settings), which keepBrowserPush respects; signing out isn't. */
export async function disableBrowserPush(turnOff = false) {
  if (turnOff) setTurnedOff(true);
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
