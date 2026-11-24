import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  renderedForLinkedDevice,
  renderTemplateBody,
  resolveTemplateRow,
  templateBodyParams,
  templateContentText,
} from './template-body';
import type { MessageTemplate } from '@/types';

function row(over: Partial<MessageTemplate>): MessageTemplate {
  return {
    id: 'tpl-1',
    user_id: 'u-1',
    name: 'order_update',
    category: 'Utility',
    language: 'en_US',
    body_text: 'Your order {{1}} ships on {{2}}',
    created_at: '2026-01-01T00:00:00Z',
    status: 'APPROVED',
    ...over,
  } as MessageTemplate;
}

/**
 * Minimal `from().select().eq().eq()` thenable — the same surface
 * resolveTemplateRow uses. Records the filters so a test can assert
 * the lookup is account-scoped.
 */
function dbReturning(
  rows: unknown[],
  filters: Record<string, unknown> = {}
): SupabaseClient {
  const builder = {
    select: () => builder,
    eq: (col: string, val: unknown) => {
      filters[col] = val;
      return builder;
    },
    then: (resolve: (r: { data: unknown[] }) => unknown) =>
      resolve({ data: rows }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

describe('renderTemplateBody', () => {
  it('substitutes named placeholders in extractVariableKeys order', () => {
    expect(
      renderTemplateBody('Hello {{customer_name}}, the {{plan}} plan', [
        'Sara',
        'Grow',
      ])
    ).toBe('Hello Sara, the Grow plan');
  });

  it('leaves an unsupplied named placeholder visible and never re-substitutes', () => {
    expect(
      renderTemplateBody('{{customer_name}} on {{plan}}', ['{{plan}}'])
    ).toBe('{{plan}} on {{plan}}');
  });

  it('substitutes positional placeholders', () => {
    expect(
      renderTemplateBody('Your order {{1}} ships on {{2}}', ['A123', 'Friday'])
    ).toBe('Your order A123 ships on Friday');
  });

  it('leaves a placeholder visible when the param is missing', () => {
    expect(renderTemplateBody('Hi {{1}}, code {{2}}', ['Sam'])).toBe(
      'Hi Sam, code {{2}}'
    );
  });

  it('handles a body with no placeholders and repeated indexes', () => {
    expect(renderTemplateBody('No variables here', ['x'])).toBe(
      'No variables here'
    );
    expect(renderTemplateBody('{{1}} and {{1}}', ['twice'])).toBe(
      'twice and twice'
    );
  });
});

describe('templateBodyParams', () => {
  it('prefers structured body values over the legacy array', () => {
    expect(templateBodyParams(['legacy'], { body: ['structured'] })).toEqual([
      'structured',
    ]);
  });

  it('falls back to the legacy array when structured body is absent', () => {
    expect(templateBodyParams(['a', 'b'], { headerText: 'x' })).toEqual([
      'a',
      'b',
    ]);
    expect(templateBodyParams(['a'], undefined)).toEqual(['a']);
  });

  it('returns an empty array for junk input', () => {
    expect(templateBodyParams(null, null)).toEqual([]);
    expect(templateBodyParams(undefined, { body: 'not-an-array' })).toEqual([]);
  });

  it('drops non-string entries from the structured body', () => {
    expect(templateBodyParams([], { body: ['ok', 7, null] })).toEqual(['ok']);
  });
});

describe('resolveTemplateRow', () => {
  it('scopes the lookup to the account and template name', async () => {
    const filters: Record<string, unknown> = {};
    await resolveTemplateRow(
      dbReturning([row({})], filters),
      'acct-1',
      'order_update',
      'en_US'
    );
    expect(filters).toEqual({ account_id: 'acct-1', name: 'order_update' });
  });

  it("matches a synced 'en' row when the caller asks for 'en_US' (#483)", async () => {
    const resolved = await resolveTemplateRow(
      dbReturning([row({ language: 'en' })]),
      'acct-1',
      'order_update',
      'en_US'
    );
    expect(resolved.row?.language).toBe('en');
    // Caller pinned a language — that is what Meta is sent.
    expect(resolved.language).toBe('en_US');
  });

  it("resolves a bare 'en' row when the caller omits the language, and sends 'en'", async () => {
    const resolved = await resolveTemplateRow(
      dbReturning([row({ language: 'en' })]),
      'acct-1',
      'order_update',
      null
    );
    expect(resolved.row?.language).toBe('en');
    // The old code pinned 'en_US' here, which Meta rejects as a
    // missing translation.
    expect(resolved.language).toBe('en');
  });

  it('prefers an exact language match over a base-language sibling', async () => {
    const resolved = await resolveTemplateRow(
      dbReturning([
        row({ id: 'a', language: 'en' }),
        row({ id: 'b', language: 'en_GB' }),
      ]),
      'acct-1',
      'order_update',
      'en_GB'
    );
    expect(resolved.row?.id).toBe('b');
  });

  it('prefers en_US then en when no language is requested', async () => {
    const resolved = await resolveTemplateRow(
      dbReturning([
        row({ id: 'es', language: 'es' }),
        row({ id: 'us', language: 'en_US' }),
        row({ id: 'en', language: 'en' }),
      ]),
      'acct-1',
      'order_update'
    );
    expect(resolved.row?.id).toBe('us');
  });

  it('returns no row when the account has none, keeping the requested language', async () => {
    const resolved = await resolveTemplateRow(
      dbReturning([]),
      'acct-1',
      'missing',
      'fr'
    );
    expect(resolved).toEqual({ row: null, malformed: false, language: 'fr' });
  });

  it('reports a row that matched by name but fails the shape guard', async () => {
    const resolved = await resolveTemplateRow(
      dbReturning([{ id: 'tpl-1', language: 'en_US' /* no body_text */ }]),
      'acct-1',
      'order_update',
      'en_US'
    );
    expect(resolved.malformed).toBe(true);
    expect(resolved.row).toBeNull();
  });

  it('sends the caller-pinned language even when no local row matches it', async () => {
    const resolved = await resolveTemplateRow(
      dbReturning([row({ language: 'es' })]),
      'acct-1',
      'order_update',
      'de'
    );
    expect(resolved.row).toBeNull();
    expect(resolved.language).toBe('de');
  });
});

describe('resolveTemplateRow: two teammates hold the same one', () => {
  const at = (day: number) => `2026-11-0${day}T00:00:00Z`;
  const pick = async (rows: unknown[], id?: string | null, name = 'en_US') =>
    resolveTemplateRow(
      dbReturning(rows as never),
      'acct-1',
      'order_update',
      name,
      id
    );
  const metas = row({ id: 'meta', meta_template_id: 'M1', created_at: at(1) });
  const local = row({ id: 'local', created_at: at(5) });

  it('prefers the one Meta approved, in either order', async () => {
    for (const rows of [
      [local, metas],
      [metas, local],
    ]) {
      expect((await pick(rows)).row?.id).toBe('meta');
    }
  });

  it('then an approved one, refused ones last', async () => {
    const paused = row({
      id: 'paused',
      meta_template_id: 'M1',
      status: 'PAUSED',
      created_at: at(9),
    });
    const refused = row({
      id: 'refused',
      submission_error: 'Bad header',
      created_at: at(8),
    });
    expect((await pick([paused, refused, local])).row?.id).toBe('local');
    expect((await pick([paused, refused])).row?.id).toBe('refused');
  });

  it('then the newest', async () => {
    const older = row({ id: 'older', created_at: at(2) });
    expect((await pick([older, local])).row?.id).toBe('local');
    expect((await pick([local, older])).row?.id).toBe('local');
  });

  it('sends exactly the row that was chosen, in its own language', async () => {
    const other = row({ id: 'other', language: 'en', created_at: at(1) });
    const chosen = await pick([metas, local, other], 'local');
    expect(chosen.row?.id).toBe('local');
    expect(await pick([metas, other], 'other', 'en_US')).toMatchObject({
      row: { id: 'other' },
      language: 'en',
    });
  });

  it('falls back when the id is not among them', async () => {
    expect((await pick([local, metas], 'elsewhere')).row?.id).toBe('meta');
    expect((await pick([local, metas], null)).row?.id).toBe('meta');
  });
});

describe('templateContentText', () => {
  it('renders the substituted body from the local row', () => {
    expect(templateContentText(row({}), ['A123', 'Friday'])).toBe(
      'Your order A123 ships on Friday'
    );
  });

  it("prefers the caller's pre-rendered text (the dashboard composer)", () => {
    expect(
      templateContentText(row({}), ['A123', 'Friday'], 'composer rendered')
    ).toBe('composer rendered');
  });

  it('is null when there is no local row to render from', () => {
    expect(templateContentText(null, ['A123'])).toBeNull();
  });
});

describe('renderedForLinkedDevice', () => {
  const row = (over: Partial<MessageTemplate>) =>
    ({
      id: 't',
      name: 't',
      language: 'en',
      body_text: 'Hi',
      ...over,
    }) as MessageTemplate;

  it('fills the header text with its own value', () => {
    const t = row({ header_type: 'text', header_content: 'Case {{1}}' });
    expect(
      renderedForLinkedDevice(t, { body: ['x'], headerText: ' TC-1 ' })
        .header_content
    ).toBe('Case TC-1');
  });

  it('leaves the header as it is when no value was given', () => {
    const t = row({ header_type: 'text', header_content: 'Case {{1}}' });
    expect(renderedForLinkedDevice(t)).toBe(t);
    expect(renderedForLinkedDevice(t, { headerText: '  ' })).toBe(t);
    expect(renderedForLinkedDevice(t, { headerText: 7 })).toBe(t);
  });

  it('takes the picture from where the editor stores it', () => {
    const t = row({
      header_type: 'image',
      header_media_url: 'https://h/a.png',
    });
    expect(renderedForLinkedDevice(t).header_content).toBe('https://h/a.png');
    expect(
      renderedForLinkedDevice(t, { headerMediaUrl: 'https://h/b.png' })
        .header_content
    ).toBe('https://h/b.png');
  });

  it('keeps a link already in the old place, and a template without one', () => {
    const old = row({
      header_type: 'document',
      header_content: 'https://h/old.pdf',
      header_media_url: 'https://h/new.pdf',
    });
    expect(renderedForLinkedDevice(old)).toBe(old);
    const none = row({ header_type: 'video' });
    expect(renderedForLinkedDevice(none)).toBe(none);
  });
});
