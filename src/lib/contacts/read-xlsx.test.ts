import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';

import { readXlsxTable } from './read-xlsx';

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

interface FixtureFile {
  name: string;
  content: string;
  /** 0 = stored, 8 = deflate (default). */
  method?: 0 | 8;
}

/**
 * A ZIP with local headers, a central directory and an end record. The
 * local headers carry zero sizes with flag bit 3 set, as a streaming
 * writer leaves them, so the reader has to take sizes from the central
 * directory.
 */
function zip(files: FixtureFile[]): Uint8Array {
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
    central.writeUInt32LE(raw.length, 24);
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

const NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function workbook(
  sheets: { name: string; rid: string; state?: string }[],
  rels: { id: string; type: string; target: string }[]
): FixtureFile[] {
  return [
    {
      name: 'xl/workbook.xml',
      content:
        `<?xml version="1.0" encoding="UTF-8"?><workbook ${NS}><sheets>` +
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

function sheet(rows: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><worksheet ${NS}>` +
    '<cols><col min="1" max="1" width="20"/></cols>' +
    `<sheetData>${rows}</sheetData></worksheet>`
  );
}

/** One workbook, one sheet at the usual path, optional shared strings. */
function simpleBook(rows: string, shared?: string): Uint8Array {
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
  return zip([
    ...workbook([{ name: 'Sheet1', rid: 'rId1' }], rels),
    { name: 'xl/worksheets/sheet1.xml', content: sheet(rows) },
    ...(shared
      ? [
          {
            name: 'xl/sharedStrings.xml',
            content: `<?xml version="1.0" encoding="UTF-8"?><sst ${NS}>${shared}</sst>`,
          },
        ]
      : []),
  ]);
}

describe('readXlsxTable', () => {
  it('reads shared strings, joining rich-text runs and dropping phonetic guides', async () => {
    const shared =
      '<si><t>phone</t></si>' +
      '<si><r><rPr><b/></rPr><t>Customer</t></r><r><t xml:space="preserve"> Name</t></r></si>' +
      '<si><t>山田</t><rPh sb="0" eb="2"><t>ヤマダ</t></rPh><phoneticPr fontId="1"/></si>' +
      '<si><t/></si>';
    const rows =
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>';
    expect(await readXlsxTable(simpleBook(rows, shared))).toEqual([
      ['phone', 'Customer Name'],
      ['山田', ''],
    ]);
  });

  it('reads inline strings and formula strings (t="str")', async () => {
    const rows =
      '<row r="1">' +
      '<c r="A1" t="inlineStr"><is><t>Phone Number</t></is></c>' +
      '<c r="B1" t="inlineStr"><is><r><t>Sir/</t></r><r><t>Madam</t></r></is></c>' +
      '<c r="C1" t="str"><f>A1</f><v>O\'Brien</v></c>' +
      '</row>';
    expect(await readXlsxTable(simpleBook(rows))).toEqual([
      ['Phone Number', 'Sir/Madam', "O'Brien"],
    ]);
  });

  it('writes whole numbers in plain digits, E-notation included', async () => {
    const rows =
      '<row r="1">' +
      '<c r="A1"><v>971501234567</v></c>' +
      '<c r="B1" t="n"><v>9.71501234567E+11</v></c>' +
      '<c r="C1"><v>2</v></c>' +
      '<c r="D1"><v>1.5</v></c>' +
      '<c r="E1"><v>1E+300</v></c>' +
      '</row>';
    expect(await readXlsxTable(simpleBook(rows))).toEqual([
      ['971501234567', '971501234567', '2', '1.5', '1E+300'],
    ]);
  });

  it('reads booleans as TRUE/FALSE and errors as empty', async () => {
    const rows =
      '<row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c>' +
      '<c r="C1" t="e"><v>#N/A</v></c></row>';
    expect(await readXlsxTable(simpleBook(rows))).toEqual([
      ['TRUE', 'FALSE', ''],
    ]);
  });

  it('places sparse cells and rows by their references', async () => {
    const rows =
      '<row r="1"><c r="A1" t="str"><v>a</v></c><c r="D1" t="str"><v>d</v></c><c r="E1"/></row>' +
      '<row r="3"><c r="B3" t="str"><v>b</v></c><c t="str"><v>next</v></c></row>' +
      '<row><c r="AA4" t="str"><v>aa</v></c></row>';
    const table = await readXlsxTable(simpleBook(rows));
    expect(table.slice(0, 3)).toEqual([
      ['a', '', '', 'd', ''],
      [],
      ['', 'b', 'next'],
    ]);
    expect(table[3]).toHaveLength(27);
    expect(table[3][26]).toBe('aa');
  });

  it('decodes XML entities and Excel _xHHHH_ escapes', async () => {
    const shared =
      '<si><t>Mövenpick Hotels &amp; Resorts</t></si>' +
      '<si><t>&lt;b&gt; &quot;x&quot; &apos;y&apos; &#65;&#x42; &amp;lt;</t></si>' +
      '<si><t>line_x000D_two _x005F_x000D_</t></si>';
    const rows =
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>' +
      '<c r="C1" t="s"><v>2</v></c></row>';
    expect(await readXlsxTable(simpleBook(rows, shared))).toEqual([
      [
        'Mövenpick Hotels & Resorts',
        '<b> "x" \'y\' AB &lt;',
        'line\rtwo _x000D_',
      ],
    ]);
  });

  it('reads a sheet whose name carries an entity', async () => {
    const bytes = zip([
      ...workbook(
        [{ name: 'Declined &amp; Dropped', rid: 'rId1' }],
        [{ id: 'rId1', type: 'worksheet', target: 'worksheets/sheet1.xml' }]
      ),
      {
        name: 'xl/worksheets/sheet1.xml',
        content: sheet('<row r="1"><c r="A1" t="str"><v>Phone</v></c></row>'),
      },
    ]);
    expect(await readXlsxTable(bytes)).toEqual([['Phone']]);
  });

  it('reads stored (uncompressed) entries', async () => {
    const bytes = zip([
      ...workbook(
        [{ name: 'Sheet1', rid: 'rId1' }],
        [{ id: 'rId1', type: 'worksheet', target: 'worksheets/sheet1.xml' }]
      ).map((f) => ({ ...f, method: 0 as const })),
      {
        name: 'xl/worksheets/sheet1.xml',
        content: sheet('<row r="1"><c r="A1"><v>42</v></c></row>'),
        method: 0,
      },
    ]);
    expect(await readXlsxTable(bytes)).toEqual([['42']]);
  });

  it('takes the first sheet in tab order through the relationships', async () => {
    const bytes = zip([
      ...workbook(
        [
          { name: 'Contacts', rid: 'rId7' },
          { name: 'Old', rid: 'rId1' },
        ],
        [
          { id: 'rId1', type: 'worksheet', target: 'worksheets/sheet1.xml' },
          {
            id: 'rId7',
            type: 'worksheet',
            target: '/xl/worksheets/sheet3.xml',
          },
        ]
      ),
      {
        name: 'xl/worksheets/sheet1.xml',
        content: sheet('<row r="1"><c r="A1" t="str"><v>old</v></c></row>'),
      },
      {
        name: 'xl/worksheets/sheet3.xml',
        content: sheet('<row r="1"><c r="A1" t="str"><v>first</v></c></row>'),
      },
    ]);
    expect(await readXlsxTable(bytes)).toEqual([['first']]);
  });

  it('skips a hidden first sheet and reads the first visible one', async () => {
    const bytes = zip([
      ...workbook(
        [
          { name: 'Secret', rid: 'rId1', state: 'hidden' },
          { name: 'Contacts', rid: 'rId2' },
        ],
        [
          { id: 'rId1', type: 'worksheet', target: 'worksheets/sheet1.xml' },
          { id: 'rId2', type: 'worksheet', target: 'worksheets/sheet2.xml' },
        ]
      ),
      {
        name: 'xl/worksheets/sheet1.xml',
        content: sheet('<row r="1"><c r="A1" t="str"><v>hidden</v></c></row>'),
      },
      {
        name: 'xl/worksheets/sheet2.xml',
        content: sheet('<row r="1"><c r="A1" t="str"><v>shown</v></c></row>'),
      },
    ]);
    expect(await readXlsxTable(bytes)).toEqual([['shown']]);
  });

  it('reads an empty shared-string cell as blank, not string 0', async () => {
    const bytes = simpleBook(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"/><c r="B2" t="s"><v/></c></row>',
      '<si><t>Customer Name</t></si><si><t>phone</t></si>'
    );
    expect(await readXlsxTable(bytes)).toEqual([
      ['Customer Name', 'phone'],
      ['', ''],
    ]);
  });

  it('starts at the first non-blank row so the header is row 0', async () => {
    const bytes = simpleBook(
      '<row r="1"><c r="A1" t="str"><v> </v></c></row>' +
        '<row r="3"><c r="A3" t="str"><v>phone</v></c></row>' +
        '<row r="4"><c r="A4" t="str"><v>971501234567</v></c></row>'
    );
    expect(await readXlsxTable(bytes)).toEqual([['phone'], ['971501234567']]);
  });

  it('throws on bytes that are not a ZIP', async () => {
    await expect(
      readXlsxTable(new TextEncoder().encode('phone,name\n+971501234567,A'))
    ).rejects.toThrow();
    await expect(readXlsxTable(new Uint8Array())).rejects.toThrow();
  });
});
