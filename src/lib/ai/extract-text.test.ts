import { describe, expect, it } from 'vitest';

import { beforeDeadline, extractKnowledgeText } from './extract-text';

/** A minimal PDF, one line of Helvetica text per page, with a true xref. */
function pdf(pages: string[]): ArrayBuffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
    );
  });
  let out = '%PDF-1.4\n';
  const offsets = objects.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out).buffer as ArrayBuffer;
}

const read = (
  bytes: ArrayBuffer,
  limits?: Parameters<typeof extractKnowledgeText>[3]
) => extractKnowledgeText('doc.pdf', 'application/pdf', bytes, limits);

describe('extractKnowledgeText (PDF)', () => {
  it('reads every page in order', async () => {
    expect(await read(pdf(['Hello world', 'Second page']))).toBe(
      'Hello world\nSecond page'
    );
  });

  it('refuses a PDF with more pages than the cap, naming both', async () => {
    await expect(
      read(pdf(['one', 'two', 'three']), { maxPages: 2 })
    ).rejects.toMatchObject({
      code: 'pdf_too_long',
      status: 413,
      message: expect.stringContaining('3 pages; the limit is 2'),
    });
    expect(await read(pdf(['one', 'two']), { maxPages: 2 })).toBe('one\ntwo');
  });

  it('refuses text past the character cap rather than cutting it off', async () => {
    // "Hello world" is 11 characters, plus one for the page break. A
    // fresh copy each time: pdf.js detaches the buffer it is handed.
    const pages = ['Hello world', 'Second page'];
    await expect(read(pdf(pages), { maxChars: 20 })).rejects.toMatchObject({
      code: 'pdf_too_long',
      message: expect.stringContaining('more than 20 characters'),
    });
    expect(await read(pdf(pages), { maxChars: 24 })).toBe(
      'Hello world\nSecond page'
    );
  });

  it('reports a file that is not a PDF as unreadable', async () => {
    await expect(
      read(new TextEncoder().encode('not a pdf').buffer as ArrayBuffer)
    ).rejects.toMatchObject({ code: 'pdf_unreadable', status: 400 });
  });
});

describe('beforeDeadline', () => {
  it('rejects with pdf_timeout when the work outlives the deadline', async () => {
    await expect(
      beforeDeadline(new Promise(() => {}), Date.now() + 10)
    ).rejects.toMatchObject({ code: 'pdf_timeout' });
  });

  it('passes the work through when it settles in time', async () => {
    expect(await beforeDeadline(Promise.resolve(7), Date.now() + 1000)).toBe(7);
    await expect(
      beforeDeadline(Promise.reject(new Error('bad')), Date.now() + 1000)
    ).rejects.toThrow('bad');
  });
});
