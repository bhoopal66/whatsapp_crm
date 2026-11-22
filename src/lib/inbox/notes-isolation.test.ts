// A team note (migration 241) must never reach the customer, the AI's
// context, unread counts, outbound webhooks, the public API or message
// aggregates. That holds structurally: notes live in their own table,
// `conversation_notes`, and nothing on those paths reads it. This test
// pins that by reading those paths' source as text.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      out.push(path);
  }
  return out;
}

const GUARDED = [
  // The AI: context builder, drafts, the bot, knowledge, translate.
  'src/lib/ai',
  // Outbound webhooks and their outbox.
  'src/lib/webhooks',
  // The public API and its helpers (mcp-server is a client of it).
  'src/app/api/v1',
  'src/lib/api/v1',
  // The WhatsApp send layer and the inbound pipeline.
  'src/lib/whatsapp',
  // Broadcasts, automations and flows.
  'src/lib/broadcasts',
  'src/lib/automations',
  'src/lib/flows',
];

describe('in-chat notes stay out of customer, AI and API paths', () => {
  it.each(GUARDED)('%s never reads conversation_notes', (dir) => {
    const files = sourceFiles(join(ROOT, dir));
    expect(files.length).toBeGreaterThan(0);
    const leaks = files.filter((f) =>
      /conversation_notes|ConversationNote/.test(readFileSync(f, 'utf8'))
    );
    expect(leaks).toEqual([]);
  });

  it('241 does not touch messages or the conversation counters', () => {
    const sql = readFileSync(
      join(ROOT, 'supabase/migrations/241_conversation_notes.sql'),
      'utf8'
    ).replace(/--[^\n]*/g, '');
    expect(sql).not.toMatch(
      /(INSERT INTO|UPDATE|DELETE FROM)\s+public\.messages\b/i
    );
    expect(sql).not.toMatch(/unread_count|last_message/i);
  });
});
