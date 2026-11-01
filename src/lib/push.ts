// Web Push on this device. iPhone requirements (iOS/iPadOS 16.4+):
//  * the app must be added to the Home Screen and opened from its icon;
//  * permission can only be requested from a direct tap;
//  * each device has its own subscription, registered with the server.
import { api } from './api';
import { FUNCTIONS_URL, VAPID_PUBLIC_KEY, supabase } from './supabase';
import { AppError, toAppError } from './errors';

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export type PushSupport =
  | { ok: true }
  | { ok: false; reason: 'install' | 'unsupported' | 'not-configured' | 'denied'; message: string };

export function pushSupport(): PushSupport {
  if (!VAPID_PUBLIC_KEY) return { ok: false, reason: 'not-configured', message: 'Push notifications are not configured on the server yet (missing VAPID key).' };
  if (isIOS() && !isStandalone()) {
    return { ok: false, reason: 'install', message: 'On iPhone, add this app to your Home Screen and open it from the icon to enable notifications.' };
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { ok: false, reason: 'unsupported', message: isIOS()
      ? 'This iOS version does not support web notifications. iOS 16.4 or later is required.'
      : 'This browser does not support push notifications.' };
  }
  if (Notification.permission === 'denied') {
    return { ok: false, reason: 'denied', message: isIOS()
      ? 'Notifications are blocked. Enable them in iPhone Settings → Notifications → Attendance.'
      : 'Notifications are blocked for this site in your browser settings.' };
  }
  return { ok: true };
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (isIOS() && /Mac/.test(ua)) ? 'iPad'
    : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Device';
  const browser = isStandalone() ? 'Home Screen app' : /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : 'Browser';
  return `${device} · ${browser}`;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration();
  if (!existing) return null;
  return navigator.serviceWorker.ready;
}

export async function currentEndpoint(): Promise<string | null> {
  try {
    const reg = await registration();
    const sub = await reg?.pushManager.getSubscription();
    return sub?.endpoint ?? null;
  } catch {
    return null;
  }
}

async function register(sub: PushSubscription) {
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new AppError('The browser returned an incomplete push subscription.');
  await api.registerPush(json.endpoint, json.keys.p256dh, json.keys.auth, deviceLabel());
}

/** Must be called directly from a tap (iOS requirement). */
export async function enablePush(): Promise<void> {
  const support = pushSupport();
  if (!support.ok) throw new AppError(support.message);
  // requestPermission must be the first await after the tap on iOS.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new AppError(isIOS()
      ? 'Notifications were not allowed. You can enable them in iPhone Settings → Notifications → Attendance.'
      : 'Notifications were not allowed.');
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) });
  }
  try {
    await register(sub);
  } catch (e) {
    throw toAppError(e);
  }
}

/** Re-register an existing subscription on app start (keys can rotate). */
export async function syncPushSubscription(): Promise<boolean> {
  try {
    if (!pushSupport().ok || Notification.permission !== 'granted') return false;
    const reg = await registration();
    let sub = await reg?.pushManager.getSubscription();
    if (!sub && reg) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) });
    }
    if (!sub) return false;
    await register(sub);
    return true;
  } catch {
    return false;
  }
}

export async function disablePush(): Promise<void> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api.unregisterPush(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

/** Send a test now, or (delaySeconds > 0) a reminder-style test later, so it can be checked with the app closed. */
export async function sendTestPush(delaySeconds = 0): Promise<{ devices: number; delivered?: number; scheduled?: boolean }> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new AppError('Please sign in again.', { auth: true });
  let res: Response;
  try {
    res = await fetch(`${FUNCTIONS_URL}/send-reminders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? '' },
      body: JSON.stringify({ type: 'test', delaySeconds }),
    });
  } catch (e) {
    throw toAppError(e);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(body.error ?? `The notification service returned ${res.status}. Is the Edge Function deployed?`);
  return body;
}
