/*
 * Taamul Connect service worker — web push only.
 *
 * Plain JS, served as-is from /sw.js (no build step, no imports). It
 * deliberately has no fetch handler: nothing is cached, so a deploy can
 * never be shadowed by a stale copy of the app. next.config.ts serves
 * this file with Cache-Control: no-cache so an update is picked up on
 * the next registration check.
 *
 * Payload (lib/push/payload.ts via the dispatcher):
 *   { title, body, url, tag, kind, ts } — url always starts with '/'.
 */

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

function parsePayload(event) {
  if (!event.data) return {};
  try {
    var json = event.data.json();
    return json && typeof json === 'object' ? json : {};
  } catch (_e) {
    try {
      return { body: event.data.text() };
    } catch (_e2) {
      return {};
    }
  }
}

// Same-origin paths only. '//host' and '/\\host' are protocol-relative
// (the URL parser reads a backslash as a slash), so they are refused
// along with absolute URLs; the resolved origin is checked as well.
function safeUrl(url) {
  if (typeof url !== 'string' || url.charAt(0) !== '/') return '/notifications';
  var second = url.charAt(1);
  if (second === '/' || second === '\\') return '/notifications';
  try {
    return new URL(url, self.location.origin).origin === self.location.origin
      ? url
      : '/notifications';
  } catch (_e) {
    return '/notifications';
  }
}

// Kinds whose tag is reused per thread: a new message in the same chat
// replaces the old notification and should still buzz.
var RENOTIFY_KINDS = ['chat_message', 'whatsapp_message'];

self.addEventListener('push', function (event) {
  var data = parsePayload(event);
  var url = safeUrl(data.url);
  var title = typeof data.title === 'string' && data.title ? data.title : 'Taamul Connect';
  var tag = typeof data.tag === 'string' && data.tag ? data.tag : undefined;

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (list) {
        // The person is already looking at exactly this screen: no
        // notification (the page shows the update itself).
        var watching = list.some(function (c) {
          if (!c.focused || c.visibilityState !== 'visible') return false;
          try {
            var u = new URL(c.url);
            return u.origin === self.location.origin && u.pathname + u.search === url;
          } catch (_e) {
            return false;
          }
        });
        if (watching) return undefined;

        return self.registration.showNotification(title, {
          body: typeof data.body === 'string' ? data.body : '',
          tag: tag,
          data: { url: url },
          icon: '/icons/icon-192.png',
          badge: '/icons/badge-72.png',
          renotify: !!tag && RENOTIFY_KINDS.indexOf(data.kind) !== -1,
          timestamp: typeof data.ts === 'number' ? data.ts : Date.now(),
        });
      })
      .catch(function () {
        return undefined;
      })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = safeUrl(event.notification.data && event.notification.data.url);

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (list) {
        var client = list.find(function (c) {
          try {
            return new URL(c.url).origin === self.location.origin;
          } catch (_e) {
            return false;
          }
        });
        if (!client) return self.clients.openWindow(url);

        return client.focus().then(function (focused) {
          var target = focused || client;
          if (typeof target.navigate === 'function') {
            return target.navigate(url).catch(function () {
              target.postMessage({ type: 'push:navigate', url: url });
            });
          }
          target.postMessage({ type: 'push:navigate', url: url });
          return undefined;
        });
      })
  );
});

function urlBase64ToUint8Array(base64) {
  var padding = '='.repeat((4 - (base64.length % 4)) % 4);
  var b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  var raw = atob(b64);
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// The push service rotated or expired the subscription: re-subscribe
// with the server's current key and record the new endpoint.
self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(
    fetch('/api/push/config', { credentials: 'same-origin' })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (config) {
        if (!config || !config.publicKey) return undefined;
        return self.registration.pushManager
          .subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(config.publicKey),
          })
          .then(function (sub) {
            var json = sub.toJSON();
            return fetch('/api/push/subscribe', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                endpoint: json.endpoint,
                keys: json.keys,
                userAgent: self.navigator.userAgent,
              }),
            });
          });
      })
      .catch(function () {
        return undefined;
      })
  );
});
