// Real .xlsx bytes for tests.

import { deflateRawSync } from 'node:zlib';

// Minimal CRC-32 for the zip writer below. The reader does not check
// it, but a real archive tool would, and the fixtures should be honest
// zips.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of data) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface FixtureFile {
  name: string;
  content: string;
  /** 0 = stored, 8 = deflate (default). */
  method?: 0 | 8;
  /** The uncompressed size the central directory claims (default: true). */
  declaredSize?: number;
}

/**
 * A ZIP with local headers, a central directory and an end record. The
 * local headers carry zero sizes with flag bit 3 set, as a streaming
 * writer leaves them, so the reader has to take sizes from the central
 * directory.
 */
export function zip(files: FixtureFile[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const method = file.method ?? 8;
    const name = enc.encode(file.name);
    const raw = enc.encode(file.content);
    const data = method === 8 ? deflateRawSync(raw) : Buffer.from(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0008, 6);
    local.writeUInt16LE(method, 8);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(data.length, 8);
    descriptor.writeUInt32LE(raw.length, 12);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, Buffer.from(name), data, descriptor);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0008, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(file.declaredSize ?? raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, Buffer.from(name));

    offset += 30 + name.length + data.length + descriptor.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

export const NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export function workbook(
  sheets: { name: string; rid: string; state?: string }[],
  rels: { id: string; type: string; target: string }[],
  properties = ''
): FixtureFile[] {
  return [
    {
      name: 'xl/workbook.xml',
      content:
        `<?xml version="1.0" encoding="UTF-8"?><workbook ${NS}>${properties}<sheets>` +
        sheets
          .map(
            (s, i) =>
              `<sheet name="${s.name}" sheetId="${i + 1}"` +
              (s.state ? ` state="${s.state}"` : '') +
              ` r:id="${s.rid}"/>`
          )
          .join('') +
        '</sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8"?><Relationships>' +
        rels
          .map(
            (r) =>
              `<Relationship Id="${r.id}" Type="${REL}/${r.type}" Target="${r.target}"/>`
          )
          .join('') +
        '</Relationships>',
    },
  ];
}

export function sheet(rows: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><worksheet ${NS}>` +
    '<cols><col min="1" max="1" width="20"/></cols>' +
    `<sheetData>${rows}</sheetData></worksheet>`
  );
}

/**
 * One workbook, one sheet at the usual path, with optional shared strings
 * and style sheet contents.
 */
export function simpleBook(
  rows: string,
  shared?: string,
  styles?: string,
  date1904 = false
): Uint8Array {
  const rels = [
    { id: 'rId1', type: 'worksheet', target: 'worksheets/sheet1.xml' },
  ];
  if (shared) {
    rels.push({
      id: 'rId2',
      type: 'sharedStrings',
      target: 'sharedStrings.xml',
    });
  }
  if (styles) {
    rels.push({ id: 'rId3', type: 'styles', target: 'styles.xml' });
  }
  return zip([
    ...workbook(
      [{ name: 'Sheet1', rid: 'rId1' }],
      rels,
      date1904 ? '<workbookPr date1904="1"/>' : ''
    ),
    { name: 'xl/worksheets/sheet1.xml', content: sheet(rows) },
    ...(shared
      ? [
          {
            name: 'xl/sharedStrings.xml',
            content: `<?xml version="1.0" encoding="UTF-8"?><sst ${NS}>${shared}</sst>`,
          },
        ]
      : []),
    ...(styles
      ? [
          {
            name: 'xl/styles.xml',
            content: `<?xml version="1.0" encoding="UTF-8"?><styleSheet ${NS}>${styles}</styleSheet>`,
          },
        ]
      : []),
  ]);
}
