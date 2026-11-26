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
// replaces the old notification and buzzes again, but at most once per
// RENOTIFY_QUIET_MS per chat. Inside that window the notification is
// replaced silently: a burst of messages (or a backlog arriving at
// once) buzzed staff once per message (HR, 2026-11-13).
var RENOTIFY_KINDS = ['chat_message', 'whatsapp_message'];
var RENOTIFY_QUIET_MS = 60 * 1000;

// When the chat's notification last buzzed, if it is still on screen.
function lastBuzzedAt(tag) {
  if (!tag || typeof self.registration.getNotifications !== 'function') {
    return Promise.resolve(0);
  }
  return self.registration
    .getNotifications({ tag: tag })
    .then(function (list) {
      var last = 0;
      list.forEach(function (n) {
        var at = n.data && typeof n.data.buzzedAt === 'number' ? n.data.buzzedAt : 0;
        if (at > last) last = at;
      });
      return last;
    })
    .catch(function () {
      return 0;
    });
}

// Reminder alarms (lib/reminders/alarm.ts): the notification stays on
// screen until the person acts on it, vibrates in an alarm pattern, and
// buzzes again when its tag is reused.
var ALARM_KINDS = ['task_due', 'event_reminder', 'meeting_reminder'];
var ALARM_VIBRATE = [300, 120, 300, 120, 600];

self.addEventListener('push', function (event) {
  var data = parsePayload(event);
  var url = safeUrl(data.url);
  var title = typeof data.title === 'string' && data.title ? data.title : 'Taamul Connect';
  var tag = typeof data.tag === 'string' && data.tag ? data.tag : undefined;
  var alarm = ALARM_KINDS.indexOf(data.kind) !== -1;

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

        var threaded = !!tag && !alarm && RENOTIFY_KINDS.indexOf(data.kind) !== -1;
        return (threaded ? lastBuzzedAt(tag) : Promise.resolve(0)).then(function (last) {
          var now = Date.now();
          var quiet = threaded && last > 0 && now - last < RENOTIFY_QUIET_MS;
          var options = {
            body: typeof data.body === 'string' ? data.body : '',
            tag: tag,
            // buzzedAt carries over a silent replacement, so a steady
            // stream still buzzes once a minute.
            data: { url: url, buzzedAt: quiet ? last : now },
            icon: '/icons/icon-192.png',
            badge: '/icons/badge-72.png',
            renotify: !!tag && (alarm || (threaded && !quiet)),
            silent: quiet,
            timestamp: typeof data.ts === 'number' ? data.ts : now,
          };
          if (alarm) {
            options.requireInteraction = true;
            options.vibrate = ALARM_VIBRATE;
          }
          return self.registration.showNotification(title, options);
        });
      })
      .catch(function () {
        return undefined;
      })
  );
});

// Where no dashboard shell is mounted, so nothing follows a message:
// the pages of src/app outside (dashboard). Nothing is being written in
// them that a load could lose. sw-click.test.ts keeps the list complete.
var OUTSIDE_PATHS = ['/login', '/forgot-password', '/join', '/f'];

function isAppPage(pathname) {
  return (
    pathname !== '/' &&
    !OUTSIDE_PATHS.some(function (p) {
      return pathname === p || pathname.indexOf(p + '/') === 0;
    })
  );
}

// The tab a click opens in: an app tab over a sign-in page, then the one
// in front, then one that can be seen.
function bestClient(list) {
  var best = null;
  var bestScore = -1;
  list.forEach(function (c) {
    var u;
    try {
      u = new URL(c.url);
    } catch (_e) {
      return;
    }
    if (u.origin !== self.location.origin) return;
    var app = isAppPage(u.pathname);
    var score =
      (app ? 4 : 0) + (c.focused ? 2 : 0) + (c.visibilityState === 'visible' ? 1 : 0);
    if (score > bestScore) {
      best = { client: c, app: app };
      bestScore = score;
    }
  });
  return best;
}

var ACK_WAIT_MS = 700;
// A page still starting up has no listener yet: it is told again.
var RETRY_WAITS_MS = [1300, 2000];
var clickSeq = 0;

// Ask the page to go there; whether it answered in time.
function askPage(client, message, waitMs) {
  return new Promise(function (resolve) {
    var channel = new MessageChannel();
    var timer = setTimeout(function () {
      done(false);
    }, waitMs);
    function done(answered) {
      clearTimeout(timer);
      channel.port1.close();
      resolve(answered);
    }
    channel.port1.onmessage = function () {
      done(true);
    };
    client.postMessage(message, [channel.port2]);
  });
}

// The page goes there itself (lib/push/navigate.ts): a load loses every
// unsent draft, staged file and recording of the tab.
//
// 'push:navigate' is followed by every version of the app page, but the
// ones before 2026-11-25 never answer. So an app page is never loaded
// for want of an answer: an older one has gone there already, and a slow
// one still will. It is only asked again with 'push:open', which the
// older ones ignore. A page outside the app follows neither; it is asked
// with 'push:open' alone (its url may be out of date, and an older page
// must not be both sent there and loaded), and loaded on no answer.
function openInClient(client, app, url) {
  clickSeq += 1;
  var id = Date.now() + '-' + clickSeq;
  var retry = { type: 'push:open', url: url, id: id };
  var first = app ? { type: 'push:navigate', url: url, id: id } : retry;
  return askPage(client, first, ACK_WAIT_MS).then(function (answered) {
    if (answered) return undefined;
    if (!app) {
      return typeof client.navigate === 'function'
        ? client.navigate(url).catch(function () {
            return undefined;
          })
        : undefined;
    }
    return RETRY_WAITS_MS.reduce(function (before, waitMs) {
      return before.then(function (done) {
        return done || askPage(client, retry, waitMs);
      });
    }, Promise.resolve(false));
  });
}

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = safeUrl(event.notification.data && event.notification.data.url);

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (list) {
        var best = bestClient(list);
        if (!best) return self.clients.openWindow(url);

        return best.client
          .focus()
          .catch(function () {
            return null;
          })
          .then(function (focused) {
            return openInClient(focused || best.client, best.app, url);
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
