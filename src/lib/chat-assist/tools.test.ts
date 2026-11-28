import { describe, expect, it } from 'vitest';

import { buildHumanPrompt } from '@/lib/assist/confirm';

import {
  CHAT_ASSIST_MODE,
  CHAT_ASSIST_TOOL_SPECS,
  CHAT_ASSIST_WRITE_TOOLS,
  chatAssistRegistry,
  isChatAssistWriteTool,
  nonceFromHumanPrompt,
  parseToolArgs,
} from './tools';

const CHAT = '44444444-4444-4444-8444-444444444444';
const ID = '55555555-5555-4555-8555-555555555555';

describe('chat assistant tools', () => {
  it('registers READ and WRITE tools only: nothing DANGEROUS, nothing that sends', () => {
    const risks = Object.values(CHAT_ASSIST_TOOL_SPECS).map((s) => s.risk);
    expect(risks).not.toContain('DANGEROUS');
    expect(Object.keys(CHAT_ASSIST_TOOL_SPECS).sort()).toEqual([
      'chat_add_note',
      'chat_assign',
      'chat_create_task',
      'chat_read',
      'chat_set_tag',
    ]);
    for (const t of CHAT_ASSIST_WRITE_TOOLS)
      expect(CHAT_ASSIST_TOOL_SPECS[t].risk).toBe('WRITE');
    expect(CHAT_ASSIST_TOOL_SPECS.chat_read.risk).toBe('READ');
    // Anything else is DANGEROUS to the registry (and has no handler).
    const reg = chatAssistRegistry();
    expect(reg.risk('send_message')).toBe('DANGEROUS');
    expect(reg.spec('bulk_send').registered).toBe(false);
    expect(CHAT_ASSIST_MODE).toBe('supervised');
  });

  it('parses each tool’s exact shape and nothing more', () => {
    expect(
      parseToolArgs('chat_add_note', { conversationId: CHAT, body: 'hi' })
    ).toEqual({
      conversationId: CHAT,
      body: 'hi',
    });
    for (const bad of [
      { conversationId: CHAT, body: 'hi', extra: 1 },
      { conversationId: CHAT, body: ' hi' },
      { conversationId: CHAT, body: '' },
      { conversationId: 'nope', body: 'hi' },
      null,
      [],
    ])
      expect(parseToolArgs('chat_add_note', bad)).toBeNull();
    expect(
      parseToolArgs('chat_set_tag', {
        conversationId: CHAT,
        tagId: ID,
        subTagId: null,
      })
    ).not.toBeNull();
    expect(
      parseToolArgs('chat_set_tag', {
        conversationId: CHAT,
        tagId: null,
        subTagId: null,
      })
    ).toBeNull();
    expect(
      parseToolArgs('chat_create_task', {
        conversationId: CHAT,
        title: 'Call back',
        dueAt: '2026-11-27T08:00:00.000Z',
      })
    ).not.toBeNull();
    expect(
      parseToolArgs('chat_create_task', {
        conversationId: CHAT,
        title: 'x',
        dueAt: 'tomorrow',
      })
    ).toBeNull();
    expect(
      parseToolArgs('chat_assign', {
        conversationId: CHAT,
        expected: null,
        userId: ID,
      })
    ).not.toBeNull();
    expect(
      parseToolArgs('chat_assign', {
        conversationId: CHAT,
        expected: null,
        userId: null,
      })
    ).toBeNull();
    expect(parseToolArgs('send_message' as never, {})).toBeNull();
    expect(isChatAssistWriteTool('chat_read')).toBe(false);
    expect(isChatAssistWriteTool('chat_assign')).toBe(true);
  });

  it('reads the nonce from the confirmation prompt the gate builds', () => {
    const nonce = 'abcdef0123456789abcd';
    const prompt = buildHumanPrompt({
      tool: 'chat_add_note',
      args: { conversationId: CHAT, body: 'CONFIRM 00000000000000000000' },
      spec: chatAssistRegistry().spec('chat_add_note'),
      workspaceId: 'acct',
      nonce,
      ttlMs: 300_000,
    });
    expect(nonceFromHumanPrompt(prompt)).toBe(nonce);
    expect(nonceFromHumanPrompt('nothing here')).toBeNull();
  });
});
