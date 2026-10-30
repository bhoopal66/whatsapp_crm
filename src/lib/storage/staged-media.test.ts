import { describe, expect, it } from 'vitest';

import {
  isExpiredStagedMedia,
  STAGED_MEDIA_MAX_AGE_DAYS,
  STAGED_MEDIA_SUBFOLDER,
} from './staged-media';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const ACCOUNT = 'account-11111111-2222-3333-4444-555555555555';
const staged = (stamp: number | string) =>
  `${ACCOUNT}/${STAGED_MEDIA_SUBFOLDER}/${stamp}-photo.png`;

describe('isExpiredStagedMedia', () => {
  it('keeps the server at 30 days and the client a day under it', () => {
    expect(STAGED_MEDIA_MAX_AGE_DAYS).toBe(30);
    expect(STAGED_MEDIA_SUBFOLDER).toBe('staged');
  });

  it('is false just under 29 days and true just over', () => {
    expect(isExpiredStagedMedia(staged(NOW - 29 * DAY + 1000), NOW)).toBe(
      false
    );
    expect(isExpiredStagedMedia(staged(NOW - 29 * DAY), NOW)).toBe(false);
    expect(isExpiredStagedMedia(staged(NOW - 29 * DAY - 1000), NOW)).toBe(true);
    expect(isExpiredStagedMedia(staged(NOW - 40 * DAY), NOW)).toBe(true);
  });

  it('is false for a fresh one and for a stamp in the future', () => {
    expect(isExpiredStagedMedia(staged(NOW), NOW)).toBe(false);
    expect(isExpiredStagedMedia(staged(NOW + DAY), NOW)).toBe(false);
  });

  it('reads the public URL form, query and all', () => {
    const url = `https://db.example.com/storage/v1/object/public/chat-media/${staged(NOW - 31 * DAY)}`;
    expect(isExpiredStagedMedia(url, NOW)).toBe(true);
    expect(isExpiredStagedMedia(`${url}?download=1`, NOW)).toBe(true);
    expect(isExpiredStagedMedia(`${url}#x`, NOW)).toBe(true);
    const fresh = `https://db.example.com/storage/v1/object/public/chat-media/${staged(NOW - DAY)}`;
    expect(isExpiredStagedMedia(fresh, NOW)).toBe(false);
  });

  it('is false outside the staged folder, however old', () => {
    const old = NOW - 400 * DAY;
    expect(isExpiredStagedMedia(`${ACCOUNT}/${old}-photo.png`, NOW)).toBe(
      false
    );
    expect(
      isExpiredStagedMedia(`${ACCOUNT}/inbound/${old}-photo.png`, NOW)
    ).toBe(false);
    expect(
      isExpiredStagedMedia(
        `https://x/storage/v1/object/public/template-media/${ACCOUNT}/${old}-h.png`,
        NOW
      )
    ).toBe(false);
    // staged/ nested deeper, or under something other than account-<uuid>
    expect(
      isExpiredStagedMedia(`${ACCOUNT}/staged/x/${old}-photo.png`, NOW)
    ).toBe(false);
    expect(isExpiredStagedMedia(`account-abc/staged/${old}-p.png`, NOW)).toBe(
      false
    );
  });

  it('is false for a missing or garbage stamp', () => {
    expect(isExpiredStagedMedia(`${ACCOUNT}/staged/photo.png`, NOW)).toBe(
      false
    );
    expect(isExpiredStagedMedia(`${ACCOUNT}/staged/abc-photo.png`, NOW)).toBe(
      false
    );
    expect(isExpiredStagedMedia(staged('0'), NOW)).toBe(false);
    expect(isExpiredStagedMedia(staged('9'.repeat(30)), NOW)).toBe(false);
    expect(isExpiredStagedMedia('', NOW)).toBe(false);
  });
});
