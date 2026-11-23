// An uploaded text file's bytes as text.
//
// `file.text()` always decodes as UTF-8 and never fails, but Excel's
// "CSV (Comma delimited)" on an Arabic Windows is Windows-1256: every
// Arabic name became a row of U+FFFD, and was imported and messaged.

/** The bytes are not text in an encoding this reads. */
export class TextEncodingError extends Error {
  constructor() {
    super('The text encoding could not be read');
    this.name = 'TextEncodingError';
  }
}

const REPLACEMENT = '�';

/** The encoding a byte order mark names; the decoder drops the mark. */
function bomEncoding(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return null;
}

/**
 * UTF-8 with a few broken bytes, not another encoding: most of what is
 * not ASCII in it still reads. Read as Windows-1256 it would not fail,
 * it would turn every name into "Ù…Ø­Ù…Ø¯". In a real Windows-1256 file
 * hardly any pair of bytes happens to be UTF-8.
 */
function isDamagedUtf8(lenient: string): boolean {
  let broken = 0;
  let read = 0;
  for (const char of lenient) {
    if (char === REPLACEMENT) broken++;
    else if (char > '\u007f') read++;
  }
  return read > broken;
}

/**
 * A byte order mark decides. Without one the bytes are UTF-8 when they
 * are valid UTF-8, else Windows-1256, which reads any bytes at all.
 * Throws TextEncodingError for text that lost characters: U+FFFD is in
 * it (broken bytes, or a file saved after an earlier misreading), or it
 * holds NUL, which is UTF-16 without its mark, or no text at all.
 */
export function decodeText(bytes: Uint8Array): string {
  let text: string;
  const encoding = bomEncoding(bytes);
  if (encoding) {
    text = new TextDecoder(encoding).decode(bytes);
  } else {
    text = new TextDecoder('utf-8').decode(bytes);
    if (text.includes(REPLACEMENT) && !isDamagedUtf8(text)) {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        text = new TextDecoder('windows-1256').decode(bytes);
      }
    }
  }
  if (text.includes(REPLACEMENT) || text.includes('\0')) {
    throw new TextEncodingError();
  }
  return text;
}

/** {@link decodeText} of an uploaded file. */
export async function readTextFile(file: Blob): Promise<string> {
  return decodeText(new Uint8Array(await file.arrayBuffer()));
}
