/**
 * Whether bytes are an Ogg/Opus file: the "OggS" capture pattern, and an
 * "OpusHead" identification header in the first page. The library stores
 * only Ogg/Opus (the composer recorder's and OpenAI's `opus` output), the
 * one voice-note format every provider plays.
 */
export function isOggOpus(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 36) return false;
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...bytes.subarray(from, to));
  if (ascii(0, 4) !== 'OggS') return false;
  return ascii(0, Math.min(bytes.byteLength, 200)).includes('OpusHead');
}
