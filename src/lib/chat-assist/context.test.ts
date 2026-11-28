import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DraftMessageRow } from '@/lib/ai/draft-prompt';

import {
  CHAT_ASSIST_MESSAGE_CAP,
  CHAT_ASSIST_MESSAGE_CHARS,
  capChatContext,
  fitTranscript,
} from './context';

const row = (
  i: number,
  over: Partial<DraftMessageRow> = {}
): DraftMessageRow => ({
  sender_type: i % 2 ? 'customer' : 'agent',
  content_type: 'text',
  content_text: `message ${i}`,
  created_at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
  status: 'delivered',
  ...over,
});

describe('capChatContext', () => {
  it('keeps the newest 60, oldest first, whatever order they come in', () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(i)).reverse();
    const out = capChatContext(rows);
    expect(CHAT_ASSIST_MESSAGE_CAP).toBe(60);
    expect(out).toHaveLength(60);
    expect(out[0].content_text).toBe('message 40');
    expect(out[59].content_text).toBe('message 99');
  });

  it('drops failed sends and clips long texts', () => {
    const long = 'x'.repeat(CHAT_ASSIST_MESSAGE_CHARS + 50);
    const out = capChatContext([
      row(1, { status: 'failed' }),
      row(2, { content_text: long }),
      row(3, { content_text: null }),
    ]);
    expect(out.map((r) => r.created_at)).toEqual([
      row(2).created_at,
      row(3).created_at,
    ]);
    expect(out[0].content_text).toHaveLength(CHAT_ASSIST_MESSAGE_CHARS);
    expect(out[0].content_text?.endsWith('…')).toBe(true);
    expect(out[1].content_text).toBeNull();
  });

  it('honours a smaller cap and never a negative one', () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(i));
    expect(capChatContext(rows, 2).map((r) => r.content_text)).toEqual([
      'message 3',
      'message 4',
    ]);
    expect(capChatContext(rows, -1)).toEqual([]);
  });
});

describe('fitTranscript', () => {
  it('drops the oldest lines first to fit', () => {
    const lines = ['aaaa', 'bbbb', 'cccc'];
    expect(fitTranscript(lines, 10)).toEqual({
      lines: ['bbbb', 'cccc'],
      dropped: 1,
    });
    expect(fitTranscript(lines, 100)).toEqual({ lines, dropped: 0 });
  });
});

describe('what the assistant reads', () => {
  it('never reads team notes (241) into its context or prompts', () => {
    for (const f of [
      'context.ts',
      'prompt.ts',
      'actions.ts',
      'refs.ts',
      'router.ts',
    ]) {
      const src = readFileSync(
        join(process.cwd(), 'src/lib/chat-assist', f),
        'utf8'
      );
      expect(src, f).not.toMatch(/conversation_notes|ConversationNote/);
    }
  });

  it('writes a note only by inserting, never by reading the table', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/lib/chat-assist/handlers.ts'),
      'utf8'
    ).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    const uses = src.match(/\.from\('conversation_notes'\)\s*\.(\w+)/g) ?? [];
    expect(uses).toEqual([".from('conversation_notes')\n        .insert"]);
  });
});
