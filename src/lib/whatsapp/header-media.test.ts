import { describe, expect, it } from 'vitest';
import {
  headerMediaAccept,
  isMediaHeaderKind,
  validateHeaderMediaFile,
} from './header-media';

describe('validateHeaderMediaFile', () => {
  it('accepts an MP4 under 16 MB as a video header', () => {
    expect(
      validateHeaderMediaFile('video', { type: 'video/mp4', size: 12_000_000 })
    ).toBeNull();
  });

  it('rejects a video over Meta’s 16 MB header limit', () => {
    expect(
      validateHeaderMediaFile('video', { type: 'video/mp4', size: 17_000_000 })
    ).toMatchObject({ kind: 'size', maxBytes: 16 * 1024 * 1024 });
  });

  it('rejects QuickTime for a video header — the bucket allows it inbound only', () => {
    expect(
      validateHeaderMediaFile('video', { type: 'video/quicktime', size: 1 })
    ).toMatchObject({ kind: 'type' });
  });

  it('keeps the image rules the editor already had (JPEG/PNG, 5 MB)', () => {
    expect(
      validateHeaderMediaFile('image', { type: 'image/png', size: 1 })
    ).toBeNull();
    expect(
      validateHeaderMediaFile('image', { type: 'image/webp', size: 1 })
    ).toMatchObject({ kind: 'type' });
    expect(
      validateHeaderMediaFile('image', { type: 'image/png', size: 6_000_000 })
    ).toMatchObject({ kind: 'size' });
  });

  it('builds the accept attribute from the same list', () => {
    expect(headerMediaAccept('video')).toBe('video/mp4,video/3gpp');
  });

  it('recognises only the three media kinds', () => {
    expect(isMediaHeaderKind('video')).toBe(true);
    expect(isMediaHeaderKind('text')).toBe(false);
    expect(isMediaHeaderKind(null)).toBe(false);
  });
});
