import { describe, expect, it } from 'vitest';

import { isOggOpus } from './audio';

const enc = (s: string) => new TextEncoder().encode(s);

describe('isOggOpus', () => {
  it('accepts an Ogg page carrying OpusHead', () => {
    const page = enc('OggS' + '\0'.repeat(24) + 'OpusHead' + '\0'.repeat(20));
    expect(isOggOpus(page)).toBe(true);
  });

  it('refuses Ogg Vorbis, other formats and short input', () => {
    expect(
      isOggOpus(enc('OggS' + '\0'.repeat(24) + '\x01vorbis' + '\0'.repeat(20)))
    ).toBe(false);
    expect(isOggOpus(enc('ID3' + '\0'.repeat(60)))).toBe(false);
    expect(isOggOpus(enc('OggS'))).toBe(false);
  });
});
