import { describe, expect, it } from 'vitest';

import { isKnownPushEndpoint } from './endpoint';

describe('isKnownPushEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://push.services.mozilla.com/x',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://web.push.apple.com/abc',
    'https://FCM.GOOGLEAPIS.COM/fcm/send/abc',
    'https://fcm.googleapis.com:443/fcm/send/abc',
  ])('accepts %s', (url) => {
    expect(isKnownPushEndpoint(url)).toBe(true);
  });

  it.each([
    ['an IPv4 literal', 'https://10.0.0.5/x'],
    ['a public IPv4 literal', 'https://8.8.8.8/x'],
    ['an IPv6 literal', 'https://[::1]/x'],
    ['localhost', 'https://localhost/x'],
    ['a metadata host', 'https://169.254.169.254/latest'],
    ['a prefix look-alike', 'https://xfcm.googleapis.com/x'],
    ['a suffix look-alike', 'https://fcm.googleapis.com.attacker.tld/x'],
    ['an embedded look-alike', 'https://evilfcm.googleapis.com.attacker.tld/x'],
    ['the bare parent domain', 'https://googleapis.com/x'],
    ['http', 'http://fcm.googleapis.com/fcm/send/abc'],
    ['a non-default port', 'https://fcm.googleapis.com:8443/x'],
    ['userinfo', 'https://user:pw@fcm.googleapis.com/x'],
    ['userinfo hiding the host', 'https://fcm.googleapis.com@10.0.0.5/x'],
    ['a non-URL', 'not a url'],
    ['an empty string', ''],
  ])('rejects %s', (_label, url) => {
    expect(isKnownPushEndpoint(url)).toBe(false);
  });
});
