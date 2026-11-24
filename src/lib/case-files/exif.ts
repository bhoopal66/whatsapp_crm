/**
 * The EXIF orientation of a JPEG (1 when it names none). A phone stores a
 * portrait photo as a landscape one plus this tag, which a PDF ignores.
 */
export function exifOrientation(b: Uint8Array): number {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
  let at = 2;
  while (at + 4 <= v.byteLength && v.getUint8(at) === 0xff) {
    const marker = v.getUint8(at + 1);
    // Start of the image data: no more headers.
    if (marker === 0xda || marker === 0xd9) return 1;
    const end = at + 2 + v.getUint16(at + 2);
    if (marker === 0xe1 && end <= v.byteLength) {
      const found = tiffOrientation(v, at + 4, end);
      if (found !== null) return found;
    }
    at = end;
  }
  return 1;
}

function tiffOrientation(
  v: DataView,
  start: number,
  end: number
): number | null {
  // "Exif\0\0", then a TIFF header.
  if (start + 14 > end || v.getUint32(start) !== 0x45786966) return null;
  const tiff = start + 6;
  const little = v.getUint16(tiff) === 0x4949;
  const ifd = tiff + v.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return null;
  const count = v.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return null;
    if (v.getUint16(entry, little) === 0x0112) {
      const value = v.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}
