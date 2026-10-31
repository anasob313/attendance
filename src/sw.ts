/// <reference lib="webworker" />
// Service worker: precached app shell (offline start) + Web Push display.
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
// Single-page app: every navigation is served the cached index.html, so the
// app opens offline. API calls to Supabase are never cached.
// The public information pages (home, privacy, terms) are separate static
// pages, not app routes, so they are never answered with the app shell.
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), {
  denylist: [/\/(home|privacy|terms)(\/|\/index\.html)?$/],
}));

self.addEventListener('install', () => { void self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

/** Resolve an app path ('/settings') inside this app's scope (works at a sub-path). */
function inScope(path: string): string {
  return new URL(path.replace(/^\//, ''), self.registration.scope).href;
}

interface PushPayload { title?: string; body?: string; detail?: string; tag?: string; url?: string }

self.addEventListener('push', (event) => {
  let data: PushPayload = {};
  try { data = event.data?.json() ?? {}; } catch { data = { body: event.data?.text() }; }
  // iOS requires every push to show a visible notification.
  const title = data.title ?? 'Attendance';
  const body = [data.body, data.detail].filter(Boolean).join('\n') || 'You have a new notification.';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: data.tag,
    icon: inScope('icons/icon-192.png'),
    badge: inScope('icons/badge-72.png'),
    data: { url: data.url ?? '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = inScope((event.notification.data as { url?: string })?.url ?? '/');
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        await c.focus();
        if ('navigate' in c && c.url !== url) await (c as WindowClient).navigate(url).catch(() => undefined);
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
