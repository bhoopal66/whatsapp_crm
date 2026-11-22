import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { shapeMismatch } from './message-shape';

describe('shapeMismatch', () => {
  it('accepts a translation with the same arguments, tags and selects', () => {
    expect(
      shapeMismatch(
        'Hi <b>{name}</b>, {s, select, a {x} other {y}}',
        'مرحبًا <b>{name}</b>، {s, select, a {س} other {ص}}'
      )
    ).toBeNull();
  });

  it('lets Arabic add plural categories but keeps other and =N', () => {
    const en = '{count, plural, =0 {none} one {# chat} other {# chats}}';
    expect(
      shapeMismatch(
        en,
        '{count, plural, =0 {لا شيء} one {محادثة} two {محادثتان} few {# محادثات} other {# محادثة}}'
      )
    ).toBeNull();
    expect(
      shapeMismatch(en, '{count, plural, one {محادثة} other {# محادثة}}')
    ).toMatch(/=0/);
  });

  it('refuses a renamed, translated or dropped argument', () => {
    expect(shapeMismatch('Hello {name}', 'مرحبًا {الاسم}')).not.toBeNull();
    expect(shapeMismatch('Hello {name}', 'مرحبًا')).not.toBeNull();
    expect(
      shapeMismatch('{n, plural, one {a} other {b}}', '{n} ب')
    ).not.toBeNull();
  });

  it('refuses a translated select key and a lost tag', () => {
    expect(
      shapeMismatch(
        '{s, select, male {a} other {b}}',
        '{s, select, ذكر {أ} other {ب}}'
      )
    ).not.toBeNull();
    expect(shapeMismatch('<link>Open</link>', 'فتح')).not.toBeNull();
  });

  it('compares raw (t.raw) strings by their literal tokens', () => {
    expect(
      shapeMismatch(
        'Hi {{1}}, see <a href="x">here</a>',
        'مرحبًا {{1}}، انظر <a href="x">هنا</a>'
      )
    ).toBeNull();
    expect(shapeMismatch('Hi {{1}}', 'مرحبًا {{2}}')).not.toBeNull();
    expect(shapeMismatch('Hi {{1}}', 'مرحبًا')).not.toBeNull();
  });

  it('agrees with the tooling copy in scripts/i18n', () => {
    // The .mjs is the same logic for the translation scripts: keep the
    // two bodies in step (this only catches a forgotten counterpart).
    const mjs = readFileSync(
      join(process.cwd(), 'scripts/i18n/message-shape.mjs'),
      'utf8'
    );
    for (const marker of [
      'lost exact cases',
      'plural without an "other" branch',
      'raw tokens differ',
      'select options differ',
    ]) {
      expect(mjs).toContain(marker);
    }
  });
});
