import { describe, expect, it } from 'vitest';

import { mediaResponseHeaders } from './media-headers';

describe('mediaResponseHeaders', () => {
  it('serves image/audio/video inline', () => {
    for (const type of ['image/jpeg', 'audio/ogg; codecs=opus', 'video/mp4']) {
      const h = mediaResponseHeaders(type);
      expect(h['Content-Disposition'], type).toBe('inline');
      expect(h['X-Content-Type-Options']).toBe('nosniff');
    }
  });

  it('forces a download for active or unknown types', () => {
    for (const type of [
      'text/html',
      'image/svg+xml',
      'application/pdf',
      'application/xhtml+xml',
      'text/html; charset=utf-8',
      null,
      '',
    ]) {
      const h = mediaResponseHeaders(type);
      expect(h['Content-Disposition'], String(type)).toBe('attachment');
      expect(h['X-Content-Type-Options']).toBe('nosniff');
    }
  });

  it('never lets a shared cache store it', () => {
    expect(mediaResponseHeaders('image/png')['Cache-Control']).toBe(
      'private, max-age=86400'
    );
  });
});
