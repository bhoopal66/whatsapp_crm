import { describe, expect, it } from 'vitest';
import { safeBroadcastReturnPath, templatesSettingsHref } from './return-path';

describe('safeBroadcastReturnPath', () => {
  it('accepts the wizard and other broadcast paths', () => {
    expect(safeBroadcastReturnPath('/broadcasts/new')).toBe('/broadcasts/new');
    expect(safeBroadcastReturnPath('/broadcasts')).toBe('/broadcasts');
  });
  it('rejects anything else', () => {
    for (const bad of [
      null,
      '',
      '//evil.com',
      '/broadcastsevil',
      'https://evil.com',
      '/inbox',
      '/broadcasts//evil.com',
      '/broadcasts\\evil',
    ]) {
      expect(safeBroadcastReturnPath(bad as string | null)).toBeNull();
    }
  });
  it('builds the settings link', () => {
    expect(templatesSettingsHref()).toBe(
      '/settings?tab=templates&from=%2Fbroadcasts%2Fnew'
    );
  });
});
