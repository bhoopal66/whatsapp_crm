import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readXlsxFirstSheet,
  readXlsxSheets,
  readXlsxTable,
  XlsxLimitError,
} from './read-xlsx';
import { sheet, simpleBook, workbook, zip, NS } from './xlsx.fixture';

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
      ['山田'],
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
    expect(await readXlsxTable(simpleBook(rows))).toEqual([['TRUE', 'FALSE']]);
  });

  it('places sparse cells and rows by their references', async () => {
    const rows =
      '<row r="1"><c r="A1" t="str"><v>a</v></c><c r="D1" t="str"><v>d</v></c><c r="E1"/></row>' +
      '<row r="3"><c r="B3" t="str"><v>b</v></c><c t="str"><v>next</v></c></row>' +
      '<row><c r="AA4" t="str"><v>aa</v></c></row>';
    const table = await readXlsxTable(simpleBook(rows));
    expect(table.slice(0, 3)).toEqual([
      ['a', '', '', 'd'],
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

  it('leaves an entity named like an Object property as written', async () => {
    const bytes = simpleBook(
      '<row r="1"><c t="inlineStr"><is><t>a&constructor;b&toString;&amp;</t></is></c></row>'
    );
    expect(await readXlsxTable(bytes)).toEqual([
      ['a&constructor;b&toString;&'],
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
    expect(await readXlsxTable(bytes)).toEqual([['Customer Name', 'phone']]);
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

describe('readXlsxSheets', () => {
  it('returns every visible worksheet in tab order, rows in place', async () => {
    const bytes = zip([
      ...workbook(
        [
          { name: 'README', rid: 'rId3' },
          { name: 'Secret', rid: 'rId1', state: 'hidden' },
          { name: 'Chart', rid: 'rId4' },
          { name: 'Knowledge_Base', rid: 'rId2' },
        ],
        [
          { id: 'rId1', type: 'worksheet', target: 'worksheets/sheet1.xml' },
          { id: 'rId2', type: 'worksheet', target: 'worksheets/sheet2.xml' },
          {
            id: 'rId3',
            type: 'worksheet',
            target: '/xl/worksheets/sheet3.xml',
          },
          { id: 'rId4', type: 'chartsheet', target: 'chartsheets/sheet1.xml' },
          { id: 'rId5', type: 'sharedStrings', target: 'sharedStrings.xml' },
        ]
      ),
      {
        name: 'xl/worksheets/sheet1.xml',
        content: sheet('<row r="1"><c r="A1" t="str"><v>hidden</v></c></row>'),
      },
      {
        name: 'xl/worksheets/sheet2.xml',
        content: sheet(
          '<row r="2"><c r="A2" t="s"><v>0</v></c><c r="C2" t="str"><v>Q</v></c></row>' +
            '<row r="3"><c r="B3" t="str"><v> x </v></c></row>'
        ),
      },
      {
        name: 'xl/worksheets/sheet3.xml',
        content: sheet('<row r="1"><c r="A1" t="str"><v>read me</v></c></row>'),
      },
      {
        name: 'xl/sharedStrings.xml',
        content: `<?xml version="1.0" encoding="UTF-8"?><sst ${NS}><si><t>ID</t></si></sst>`,
      },
    ]);
    expect(await readXlsxSheets(bytes)).toEqual([
      { name: 'README', rows: [['read me']] },
      {
        name: 'Knowledge_Base',
        // Row 1 is blank and kept, so rows[i] is sheet row i + 1; cell
        // text is not trimmed.
        rows: [[], ['ID', '', 'Q'], ['', ' x ']],
      },
    ]);
  });

  it('returns no sheets when every worksheet is hidden', async () => {
    const bytes = zip([
      ...workbook(
        [{ name: 'Secret', rid: 'rId1', state: 'veryHidden' }],
        [{ id: 'rId1', type: 'worksheet', target: 'worksheets/sheet1.xml' }]
      ),
      {
        name: 'xl/worksheets/sheet1.xml',
        content: sheet('<row r="1"><c r="A1" t="str"><v>hidden</v></c></row>'),
      },
    ]);
    expect(await readXlsxSheets(bytes)).toEqual([]);
  });
});

describe('number formats', () => {
  // Style 0 General, 1 built-in date, 2 custom date and time, 3 custom
  // percentage, 4 currency, 5 time. A dxf's format is not a cell's, and
  // neither is a cellStyleXfs one.
  const STYLES =
    '<numFmts count="4">' +
    '<numFmt numFmtId="164" formatCode="dd\\-mmm\\-yyyy\\ hh:mm"/>' +
    '<numFmt numFmtId="165" formatCode="0.00%"/>' +
    '<numFmt numFmtId="166" formatCode="[$AED]\\ #,##0.00"/>' +
    '<numFmt numFmtId="167" formatCode="[&gt;1]0;hh:mm"/>' +
    '</numFmts>' +
    '<cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs>' +
    '<cellXfs count="6"><xf numFmtId="0" xfId="0"/>' +
    '<xf numFmtId="14" applyNumberFormat="1"><alignment/></xf>' +
    '<xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/>' +
    '<xf numFmtId="20"/></cellXfs>' +
    '<dxfs count="1"><dxf><numFmt numFmtId="166" formatCode="dd/mm/yyyy"/></dxf></dxfs>';
  const ROW =
    '<row r="1"><c r="A1" s="0"><v>46371</v></c>' +
    '<c r="B1" s="1"><v>46371</v></c>' +
    '<c r="C1" s="2" t="n"><v>46371.4375</v></c>' +
    '<c r="D1" s="3"><v>7.2499999999999995E-2</v></c>' +
    '<c r="E1" s="4"><v>4350.0999999999995</v></c>' +
    '<c r="F1" s="5"><v>0.5</v></c>' +
    '<c r="G1" s="1" t="str"><v>46371</v></c>' +
    '<c r="H1" s="99"><v>46371</v></c>' +
    '<c r="I1" s="1"><v>971501234567</v></c></row>';
  const SHOWN = [
    '46371',
    '15/12/2026',
    '15/12/2026 10:30',
    '7.25%',
    '4350.1',
    '12:00',
    '46371',
    '46371',
    '971501234567',
  ];

  it('reads dates, times and percentages as the sheet shows them', async () => {
    const bytes = simpleBook(ROW, undefined, STYLES);
    expect(await readXlsxTable(bytes)).toEqual([SHOWN]);
    expect(await readXlsxSheets(bytes)).toEqual([
      { name: 'Sheet1', rows: [SHOWN] },
    ]);
  });

  it('counts from 1904 when the workbook says so', async () => {
    const bytes = simpleBook(
      '<row r="1"><c r="A1" s="1"><v>44909</v></c></row>',
      undefined,
      STYLES,
      true
    );
    expect(await readXlsxTable(bytes)).toEqual([['15/12/2026']]);
  });

  const asStored = [
    ...['46371', '46371', '46371.4375', '0.0725', '4350.1', '0.5'],
    ...['46371', '46371', '971501234567'],
  ];
  it.each([
    ['missing', undefined],
    ['not a style sheet', '<nonsense'],
    ['never closed', `${STYLES.slice(0, STYLES.indexOf('</cellXfs>'))}`],
    ['empty', '<numFmts count="0"/><cellXfs count="0"/>'],
  ])('writes numbers as stored when styles.xml is %s', async (_, styles) => {
    expect(await readXlsxTable(simpleBook(ROW, undefined, styles))).toEqual([
      asStored,
    ]);
  });

  it('writes numbers as stored when styles.xml is over a limit', async () => {
    const bytes = simpleBook(ROW, undefined, STYLES + ' '.repeat(20_000));
    expect(await readXlsxTable(bytes, { maxEntryBytes: 10_000 })).toEqual([
      asStored,
    ]);
  });

  it('keeps the plain column as digits, whatever its format', async () => {
    const bytes = simpleBook(
      '<row r="2"><c r="A2" t="str"><v>phone</v></c><c r="B2" t="str"><v>due</v></c></row>' +
        '<row r="3"><c r="A3" s="1"><v>46371</v></c><c r="B3" s="1"><v>46371</v></c></row>',
      undefined,
      STYLES
    );
    expect(
      await readXlsxFirstSheet(bytes, undefined, (h) => h.indexOf('phone'))
    ).toEqual({
      rows: [
        ['phone', 'due'],
        ['46371', '15/12/2026'],
      ],
      firstRow: 2,
    });
  });
});

describe('limits', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Counts the inflaters started and the bytes they hand on, which is
   * what an early abort keeps small.
   */
  function countInflation() {
    const counts = { streams: 0, bytes: 0 };
    const Real = globalThis.DecompressionStream;
    class Counting extends Real {
      constructor(format: CompressionFormat) {
        super(format);
        counts.streams++;
      }
      get readable() {
        return super.readable.pipeThrough(
          new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>(
            {
              transform(chunk, ctl) {
                counts.bytes += chunk.length;
                ctl.enqueue(chunk);
              },
            }
          )
        );
      }
    }
    vi.stubGlobal('DecompressionStream', Counting);
    return counts;
  }

  it("refuses a row below Excel's last row", async () => {
    const bytes = simpleBook(
      '<row r="1048577"><c r="A1048577"><v>1</v></c></row>'
    );
    await expect(readXlsxTable(bytes)).rejects.toThrow(
      /Row 1048577 is outside Excel's rows/
    );
  });

  it("refuses a cell right of Excel's last column", async () => {
    const bytes = simpleBook('<row r="1"><c r="XFE1"><v>1</v></c></row>');
    await expect(readXlsxSheets(bytes)).rejects.toThrow(
      /Cell XFE1 is beyond Excel's last column/
    );
    // XFD is the last column, and is read.
    const last = simpleBook('<row r="1"><c r="XFD1"><v>1</v></c></row>');
    expect((await readXlsxTable(last))[0]).toHaveLength(16_384);
  });

  it('charges blank padding to the cell budget', async () => {
    const bytes = simpleBook(
      '<row r="200000"><c r="A200000"><v>1</v></c></row>'
    );
    await expect(readXlsxTable(bytes, { maxCells: 1000 })).rejects.toThrow(
      /more than 1000 cells/
    );
  });

  it('does not charge or place empty styled rows and cells', async () => {
    const trailing =
      '<row r="1048576" s="1" customFormat="1"/>' +
      '<row r="9"><c r="A9" s="1"/><c r="B9" s="1"><v></v></c></row>';
    const table =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>name</t></is></c>' +
      '<c r="C1" t="inlineStr"><is><t>x</t></is></c><c r="D1" s="1"/></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>ann</t></is></c></row>';
    const book = zip([
      ...workbook(
        [
          { name: 'A', rid: 'rId1' },
          { name: 'B', rid: 'rId2' },
        ],
        [
          { id: 'rId1', type: 'worksheet', target: 'worksheets/sheet1.xml' },
          { id: 'rId2', type: 'worksheet', target: 'worksheets/sheet2.xml' },
        ]
      ),
      { name: 'xl/worksheets/sheet1.xml', content: sheet(table + trailing) },
      { name: 'xl/worksheets/sheet2.xml', content: sheet(table + trailing) },
    ]);
    // Per sheet: row 1 is 3 cells, row 2 is 1, plus 2 row slots = 6.
    const sheets = await readXlsxSheets(book, { maxCells: 12 });
    expect(sheets.map((s) => s.rows)).toEqual([
      [['name', '', 'x'], ['ann']],
      [['name', '', 'x'], ['ann']],
    ]);
  });

  it('still materialises a value at the last row, bounded by the cap', async () => {
    const bytes = simpleBook(
      '<row r="1048576"><c r="A1048576"><v>1</v></c></row>'
    );
    await expect(readXlsxTable(bytes, { maxCells: 1000 })).rejects.toThrow(
      XlsxLimitError
    );
  });

  it('tags every limit refusal as an XlsxLimitError', async () => {
    const far = simpleBook('<row r="1048577"><c><v>1</v></c></row>');
    await expect(readXlsxTable(far)).rejects.toBeInstanceOf(XlsxLimitError);
    const wide = simpleBook('<row r="1"><c r="XFE1"><v>1</v></c></row>');
    await expect(readXlsxTable(wide)).rejects.toBeInstanceOf(XlsxLimitError);
    const cells = simpleBook('<row r="1"><c><v>1</v></c></row>');
    await expect(readXlsxTable(cells, { maxCells: 1 })).rejects.toBeInstanceOf(
      XlsxLimitError
    );
    await expect(
      readXlsxTable(cells, { maxEntryBytes: 10 })
    ).rejects.toBeInstanceOf(XlsxLimitError);
    // Not a limit: stays a plain Error.
    await expect(
      readXlsxTable(new Uint8Array([1, 2, 3]))
    ).rejects.not.toBeInstanceOf(XlsxLimitError);
  });

  it('spends one cell budget across every sheet, a row counting as one', async () => {
    // Each sheet: one row of three cells, four slots.
    const row =
      '<row r="1"><c><v>1</v></c><c><v>2</v></c><c><v>3</v></c></row>';
    const bytes = zip([
      ...workbook(
        [
          { name: 'A', rid: 'rId1' },
          { name: 'B', rid: 'rId2' },
        ],
        [
          { id: 'rId1', type: 'worksheet', target: 'worksheets/sheet1.xml' },
          { id: 'rId2', type: 'worksheet', target: 'worksheets/sheet2.xml' },
        ]
      ),
      { name: 'xl/worksheets/sheet1.xml', content: sheet(row) },
      { name: 'xl/worksheets/sheet2.xml', content: sheet(row) },
    ]);
    expect(await readXlsxSheets(bytes, { maxCells: 8 })).toHaveLength(2);
    await expect(readXlsxSheets(bytes, { maxCells: 7 })).rejects.toThrow(
      /more than 7 cells/
    );
  });

  it('refuses an entry whose declared size is over the cap, before inflating it', async () => {
    const counts = countInflation();
    const bytes = simpleBook('<row r="1"><c><v>1</v></c></row>');
    await expect(readXlsxTable(bytes, { maxEntryBytes: 100 })).rejects.toThrow(
      /xl\/workbook\.xml is too large/
    );
    expect(counts.streams).toBe(0);
  });

  it('caps the uncompressed bytes of the whole workbook', async () => {
    const bytes = simpleBook('<row r="1"><c><v>1</v></c></row>');
    expect(await readXlsxTable(bytes)).toEqual([['1']]);
    // workbook.xml and its relationships fit; the sheet does not.
    await expect(
      readXlsxTable(bytes, { maxEntryBytes: 1000, maxTotalBytes: 700 })
    ).rejects.toThrow(/too large uncompressed/);
  });

  it('stops inflating an entry as soon as it passes its declared size', async () => {
    const counts = countInflation();
    const bytes = zip([
      ...workbook(
        [{ name: 'Sheet1', rid: 'rId1' }],
        [{ id: 'rId1', type: 'worksheet', target: 'worksheets/sheet1.xml' }]
      ),
      {
        name: 'xl/worksheets/sheet1.xml',
        // 4 MB of spaces deflate to a few KB and claim 1,000 bytes.
        content: sheet('') + ' '.repeat(4 * 1024 * 1024),
        declaredSize: 1000,
      },
    ]);
    await expect(readXlsxTable(bytes)).rejects.toThrow(
      /inflates past its declared size/
    );
    expect(counts.bytes).toBeLessThan(512 * 1024);
  });

  it('inflates an entry once however many sheets point at it', async () => {
    const counts = countInflation();
    const bytes = zip([
      ...workbook(
        [
          { name: 'A', rid: 'rId1' },
          { name: 'B', rid: 'rId2' },
        ],
        [
          { id: 'rId1', type: 'worksheet', target: 'worksheets/sheet1.xml' },
          {
            id: 'rId2',
            type: 'worksheet',
            target: '/xl/worksheets/sheet1.xml',
          },
        ]
      ),
      {
        name: 'xl/worksheets/sheet1.xml',
        content: sheet('<row r="1"><c><v>1</v></c></row>'),
      },
    ]);
    const sheets = await readXlsxSheets(bytes);
    expect(sheets.map((s) => s.rows)).toEqual([[['1']], [['1']]]);
    // workbook.xml, its relationships and the one sheet.
    expect(counts.streams).toBe(3);
  });

  it('refuses a workbook with more tabs than the cap', async () => {
    const bytes = zip([
      ...workbook(
        [
          { name: 'A', rid: 'rId1' },
          { name: 'B', rid: 'rId1', state: 'hidden' },
        ],
        [{ id: 'rId1', type: 'worksheet', target: 'worksheets/sheet1.xml' }]
      ),
      {
        name: 'xl/worksheets/sheet1.xml',
        content: sheet('<row r="1"><c><v>1</v></c></row>'),
      },
    ]);
    expect(await readXlsxSheets(bytes, { maxSheets: 2 })).toHaveLength(1);
    await expect(readXlsxSheets(bytes, { maxSheets: 1 })).rejects.toThrow(
      /more than 1 sheets/
    );
  });
});

describe('malformed XML in linear time', () => {
  // Openers that are never closed. A lazy regex rescans to the end of
  // the entry for each one, so these sizes cost the old reader seconds
  // (quadratic), and 50 MB of them blocked the event loop for hours.
  // A linear scan reads each in milliseconds.
  const BUDGET_MS = 500;
  const cases: [string, () => Uint8Array][] = [
    ['<row> with no </row>', () => simpleBook('<row>'.repeat(35_000))],
    [
      '<c> with no </c>',
      () => simpleBook(`<row>${'<c>'.repeat(50_000)}</row>`),
    ],
    [
      '<v> with no </v>',
      () => simpleBook(`<row><c>${'<v>'.repeat(40_000)}</c></row>`),
    ],
    ['<si> with no </si>', () => simpleBook('<row/>', '<si>'.repeat(35_000))],
    [
      '<t> with no </t>',
      () => simpleBook('<row/>', `<si>${'<t>'.repeat(40_000)}</si>`),
    ],
    [
      '<xf with no >',
      () => simpleBook('<row/>', undefined, `<cellXfs>${'<xf'.repeat(40_000)}`),
    ],
    [
      '<numFmt> with no quote',
      () =>
        simpleBook(
          '<row/>',
          undefined,
          `<numFmts>${'<numFmt formatCode="'.repeat(20_000)}</numFmts>`
        ),
    ],
    [
      '<sheet with no >',
      () =>
        zip([
          {
            name: 'xl/workbook.xml',
            content: `<workbook>${'<sheet'.repeat(16_000)}`,
          },
        ]),
    ],
  ];

  it.each(cases)(
    'skips a %s without rescanning',
    async (_, book) => {
      const bytes = book();
      const started = performance.now();
      const sheets = await readXlsxSheets(bytes);
      expect(performance.now() - started).toBeLessThan(BUDGET_MS);
      // As before: an element that is never closed is not read.
      expect(sheets.flatMap((s) => s.rows.flat()).join('')).toBe('');
    },
    10_000
  );

  it('refuses a reference longer than Excel writes, without scanning it', async () => {
    // A trailing-digits regex is quadratic on a long digit run that does
    // not end the reference.
    const bytes = simpleBook(`<row r="${'1'.repeat(40_000)}x"/>`);
    const started = performance.now();
    await expect(readXlsxTable(bytes)).rejects.toThrow(
      /Cell reference "1{12}…" is too long/
    );
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
    // The longest reference Excel writes is still read.
    const last = simpleBook(
      '<row r="1048576"><c r="$XFD$1048576" t="str"><v>z</v></c></row>'
    );
    expect((await readXlsxSheets(last))[0].rows[1_048_575][16_383]).toBe('z');
  }, 10_000);

  it('does not take a longer tag for a cell, row or text run', async () => {
    const rows =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>a</t><text>no</text>' +
      '<tableParts>no</tableParts></is></c><col>no</col><cols/>' +
      '<c r="B1" t="str"><v>b</v></c></row><rowBreaks><c>no</c></rowBreaks>';
    expect(await readXlsxTable(simpleBook(rows))).toEqual([['a', 'b']]);
  });
});
