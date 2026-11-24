import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { unsavedInMemory } from '@/lib/app-update/unsaved';

import { createTextDrafts, groupTextDrafts, sendTyped } from './text-drafts';

const drafts = (max?: number) => {
  const d = createTextDrafts(max);
  d.claim('u');
  return d;
};

describe('createTextDrafts', () => {
  it('keeps each chat its own words, spaces included', () => {
    const d = drafts();
    d.write('u', 'group:a', 'half a ');
    expect(d.get('u', 'group:a')).toBe('half a ');
    expect(d.get('u', 'group:b')).toBe('');
    d.write('u', 'group:a', '');
    expect(d.get('u', 'group:a')).toBe('');
  });

  it('is never shown to the next login, and holds nothing signed out', () => {
    const d = drafts();
    d.write('u', 'a', 'x');
    d.write(null, 'a', 'y');
    expect(d.get('u', 'a')).toBe('x');
    expect(d.get(null, 'a')).toBe('');
    expect(d.get('other', 'a')).toBe('');
    d.claim('other');
    expect(d.get('other', 'a')).toBe('');
    d.claim('u');
    expect(d.get('u', 'a')).toBe('');
  });

  it('drops the oldest chat past the bound', () => {
    const d = drafts(2);
    d.write('u', 'a', '1');
    d.write('u', 'b', '2');
    d.write('u', 'a', '1!');
    d.write('u', 'c', '3');
    expect(d.get('u', 'b')).toBe('');
    expect(d.get('u', 'a')).toBe('1!');
    expect(d.get('u', 'c')).toBe('3');
  });

  it('tells the box on screen, and forgets a closed one', () => {
    const d = drafts();
    let told = 0;
    const stop = d.subscribe(() => told++);
    d.write('u', 'a', 'x');
    expect(told).toBe(1);
    stop();
    d.write('u', 'a', 'xy');
    expect(told).toBe(1);
  });

  it('holds the tab back from a reload while words wait', () => {
    groupTextDrafts.write('u', 'a', ' ');
    expect(unsavedInMemory()).toBe(false);
    groupTextDrafts.write('u', 'a', 'x');
    expect(unsavedInMemory()).toBe(true);
    groupTextDrafts.write('u', 'a', '');
    expect(unsavedInMemory()).toBe(false);
  });

  it('is memory only, and what the group box sends from', () => {
    const lib = readFileSync('src/lib/groups/text-drafts.ts', 'utf8');
    expect(lib).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    const box = readFileSync(
      'src/components/groups/group-composer.tsx',
      'utf8'
    );
    expect(box).toContain(
      'sendTyped(groupTextDrafts, userId, chatKey, onSendText)'
    );
  });
});

describe('sendTyped', () => {
  it('empties the box while it sends, for good once sent', async () => {
    const d = drafts();
    d.write('u', 'a', ' hello ');
    const sent: string[] = [];
    await sendTyped(d, 'u', 'a', async (body) => {
      sent.push(body);
      expect(d.get('u', 'a')).toBe('');
      return true;
    });
    expect(sent).toEqual(['hello']);
    expect(d.get('u', 'a')).toBe('');
  });

  it('sends nothing blank', async () => {
    const d = drafts();
    d.write('u', 'a', ' \n');
    let sent = 0;
    await sendTyped(d, 'u', 'a', async () => !!++sent);
    expect(sent).toBe(0);
  });

  it('gives the words back to their own chat when refused', async () => {
    const d = drafts();
    d.write('u', 'a', 'hello');
    await sendTyped(d, 'u', 'a', async () => {
      // Another chat is open by now.
      d.write('u', 'b', 'elsewhere');
      return false;
    });
    expect(d.get('u', 'a')).toBe('hello');
    expect(d.get('u', 'b')).toBe('elsewhere');
  });

  it('gives them back when the send breaks', async () => {
    const d = drafts();
    d.write('u', 'a', 'hello');
    await expect(
      sendTyped(d, 'u', 'a', () => Promise.reject(new Error('x')))
    ).rejects.toThrow('x');
    expect(d.get('u', 'a')).toBe('hello');
  });

  it('never over words typed since, nor to another login', async () => {
    const d = drafts();
    d.write('u', 'a', 'hello');
    await sendTyped(d, 'u', 'a', async () => {
      d.write('u', 'a', 'newer');
      return false;
    });
    expect(d.get('u', 'a')).toBe('newer');
    await sendTyped(d, 'u', 'a', async () => {
      d.claim('other');
      return false;
    });
    expect(d.get('other', 'a')).toBe('');
    d.claim('u');
    expect(d.get('u', 'a')).toBe('');
  });
});
