import { describe, it, expect } from 'vitest';
import { metaTemplateToRow } from './template-import';
import type { MetaTemplateRecord } from './meta-api';

const full: MetaTemplateRecord = {
  id: '1799723094805717',
  name: 'acct_docs_reminder',
  language: 'en',
  status: 'APPROVED',
  category: 'UTILITY',
  quality_score: { score: 'GREEN' },
  components: [
    {
      type: 'HEADER',
      format: 'TEXT',
      text: 'Docs for {{1}}',
      example: { header_text: ['Acme'] },
    },
    {
      type: 'BODY',
      text: 'Hello {{1}}, file {{2}} is missing {{3}}.',
      example: { body_text: [['Ahmed', 'ACC/1', 'the Ejari']] },
    },
    { type: 'FOOTER', text: 'Taamul' },
    {
      type: 'BUTTONS',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Sending now' },
        {
          type: 'URL',
          text: 'Open',
          url: 'https://x.test/{{1}}',
          example: ['https://x.test/a'],
        },
        { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+97140000000' },
        { type: 'OTP', text: 'Copy code' },
      ],
    },
  ],
};

describe('metaTemplateToRow', () => {
  it('maps every component onto the local row shape', () => {
    expect(metaTemplateToRow(full)).toEqual({
      name: 'acct_docs_reminder',
      language: 'en',
      category: 'Utility',
      header_type: 'text',
      header_content: 'Docs for {{1}}',
      body_text: 'Hello {{1}}, file {{2}} is missing {{3}}.',
      footer_text: 'Taamul',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Sending now' },
        {
          type: 'URL',
          text: 'Open',
          url: 'https://x.test/{{1}}',
          example: 'https://x.test/a',
        },
        { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+97140000000' },
      ],
      sample_values: {
        body: ['Ahmed', 'ACC/1', 'the Ejari'],
        header: ['Acme'],
      },
      status: 'APPROVED',
      meta_template_id: '1799723094805717',
      quality_score: 'GREEN',
    });
  });

  it('keeps a media header as its type with no text content', () => {
    const row = metaTemplateToRow({
      ...full,
      components: [
        {
          type: 'HEADER',
          format: 'IMAGE',
          example: { header_handle: ['4::aW1hZ2U='] },
        },
        { type: 'BODY', text: 'Hi' },
      ],
    });
    expect(row?.header_type).toBe('image');
    expect(row?.header_content).toBeNull();
    expect(row?.buttons).toBeNull();
    expect(row?.sample_values).toBeNull();
  });

  it('skips a template with no body', () => {
    expect(
      metaTemplateToRow({
        ...full,
        components: [{ type: 'FOOTER', text: 'x' }],
      })
    ).toBeNull();
  });

  it('falls back on unknown category / status / quality', () => {
    const row = metaTemplateToRow({
      ...full,
      category: 'SOMETHING_NEW',
      status: 'LIMIT_EXCEEDED',
      quality_score: { score: 'UNKNOWN' },
    });
    expect(row?.category).toBe('Marketing');
    expect(row?.status).toBe('PENDING');
    expect(row?.quality_score).toBeNull();
  });
});
