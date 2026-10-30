import { describe, expect, it } from 'vitest';

import { blockFromError } from '../composer';
import {
  composerControls,
  countsAsChannelAdmin,
  everyoneRefusal,
  mentionsEveryone,
  needsGuestLookup,
  offersEveryone,
  postingBlock,
  postingBlockMessage,
  sensitiveDecision,
  sensitiveScopeApplies,
  stripMentionTokens,
} from '../composer-gating';
import { ALL_ALLOWED, type ChatCapability } from '../permissions';
import { sensitiveKinds } from '@/lib/kb/sensitive';

const can = (denied: ChatCapability[] = []) =>
  Object.fromEntries(
    Object.keys(ALL_ALLOWED.can).map((k) => [
      k,
      !denied.includes(k as ChatCapability),
    ])
  ) as Record<ChatCapability, boolean>;

describe('countsAsChannelAdmin', () => {
  it('counts a channel admin and a workspace admin, never a bank guest', () => {
    const base = {
      workspaceAdmin: false,
      role: 'member' as const,
      bankGuest: false,
    };
    expect(countsAsChannelAdmin(base)).toBe(false);
    expect(countsAsChannelAdmin({ ...base, role: 'admin' })).toBe(true);
    expect(
      countsAsChannelAdmin({ ...base, role: null, workspaceAdmin: true })
    ).toBe(true);
    expect(
      countsAsChannelAdmin({ ...base, role: 'admin', bankGuest: true })
    ).toBe(false);
  });
});

describe('composerControls', () => {
  it('shows attach and mic only with their permissions', () => {
    expect(composerControls(can())).toEqual({ attach: true, voice: true });
    expect(composerControls(can(['upload_files']))).toEqual({
      attach: false,
      voice: true,
    });
    expect(composerControls(can(['send_voice']))).toEqual({
      attach: true,
      voice: false,
    });
  });
});

describe('@channel / @here', () => {
  it('detects them as the server does', () => {
    expect(mentionsEveryone('@channel standup')).toBe(true);
    expect(mentionsEveryone('hi @HERE!')).toBe(true);
    expect(mentionsEveryone('mail me@here.com')).toBe(false);
    expect(mentionsEveryone('@channels')).toBe(false);
    expect(mentionsEveryone('a_@here')).toBe(false);
    expect(mentionsEveryone('no mention')).toBe(false);
  });

  const allowed = {
    can: can(),
    rule: 'everyone' as const,
    channelAdmin: false,
  };

  it('offers them only in broadcast kinds with the permission and the rule', () => {
    expect(offersEveryone({ ...allowed, broadcastKind: true })).toBe(true);
    expect(offersEveryone({ ...allowed, broadcastKind: false })).toBe(false);
    expect(
      offersEveryone({
        ...allowed,
        broadcastKind: true,
        can: can(['mention_everyone']),
      })
    ).toBe(false);
    expect(
      offersEveryone({ ...allowed, broadcastKind: true, rule: 'admins' })
    ).toBe(false);
    expect(
      offersEveryone({
        ...allowed,
        broadcastKind: true,
        rule: 'admins',
        channelAdmin: true,
      })
    ).toBe(true);
  });

  it('refuses a typed one only when not allowed', () => {
    expect(everyoneRefusal('@here quick one', allowed)).toBeNull();
    expect(everyoneRefusal('@here', { ...allowed, rule: 'admins' })).toBe(
      'mentionEveryoneRestricted'
    );
    expect(
      everyoneRefusal('@here', { ...allowed, can: can(['mention_everyone']) })
    ).toBe('mentionEveryoneRestricted');
    expect(everyoneRefusal('hello', { ...allowed, rule: 'admins' })).toBeNull();
  });
});

describe('posting rules', () => {
  const base = {
    threadRootId: null,
    posting: 'everyone' as const,
    threadReplies: 'everyone' as const,
    channelAdmin: false,
  };

  it('blocks a non-admin top-level post in an admins-only channel', () => {
    expect(postingBlock(base)).toBeNull();
    expect(postingBlock({ ...base, posting: 'admins' })).toBe(
      'postingRestricted'
    );
    expect(
      postingBlock({ ...base, posting: 'admins', channelAdmin: true })
    ).toBeNull();
    // The thread composer obeys thread_replies, not posting.
    expect(
      postingBlock({ ...base, posting: 'admins', threadRootId: 'r' })
    ).toBeNull();
  });

  it('blocks a non-admin thread reply when replies are admins-only', () => {
    const thread = {
      ...base,
      threadRootId: 'r',
      threadReplies: 'admins' as const,
    };
    expect(postingBlock(thread)).toBe('repliesRestricted');
    expect(postingBlock({ ...thread, channelAdmin: true })).toBeNull();
    // The main composer ignores thread_replies.
    expect(postingBlock({ ...thread, threadRootId: null })).toBeNull();
  });

  it('drops the thread clause when replies are admins-only too', () => {
    expect(postingBlockMessage('postingRestricted', 'everyone')).toBe(
      'postingRestricted'
    );
    expect(postingBlockMessage('postingRestricted', 'admins')).toBe(
      'postingRestrictedNoReplies'
    );
    expect(postingBlockMessage('repliesRestricted', 'admins')).toBe(
      'repliesRestricted'
    );
  });

  it('maps the server refusals to blocks', () => {
    expect(blockFromError('postingRestricted')).toBe('postingRestricted');
    expect(blockFromError('repliesRestricted')).toBe('repliesRestricted');
    expect(blockFromError('outsideAudience')).toBe('outsideAudience');
    expect(blockFromError('mentionEveryoneRestricted')).toBeNull();
  });
});

describe('sensitive data', () => {
  const CARD = '4111 1111 1111 1111';
  const UUID = '12345678-1234-4234-8234-123456789012';

  it('strips mention tokens before looking', () => {
    expect(stripMentionTokens(`hi <@${UUID}>`)).toBe('hi  ');
    expect(
      sensitiveKinds(stripMentionTokens(`<@${UUID}> pay ${CARD}`))
    ).toEqual(['card']);
  });

  it('applies scope all everywhere, guests only to team/private channels with a guest', () => {
    expect(
      sensitiveScopeApplies({ scope: 'all', kind: 'dm', hasGuest: null })
    ).toBe(true);
    expect(
      sensitiveScopeApplies({ scope: 'guests', kind: 'team', hasGuest: true })
    ).toBe(true);
    expect(
      sensitiveScopeApplies({
        scope: 'guests',
        kind: 'private',
        hasGuest: false,
      })
    ).toBe(false);
    expect(
      sensitiveScopeApplies({
        scope: 'guests',
        kind: 'deal_room',
        hasGuest: true,
      })
    ).toBe(false);
    expect(
      sensitiveScopeApplies({ scope: 'guests', kind: 'dm', hasGuest: true })
    ).toBe(false);
    expect(
      sensitiveScopeApplies({ scope: 'guests', kind: 'team', hasGuest: null })
    ).toBe(false);
  });

  it('looks guests up only when the answer matters', () => {
    const g = { mode: 'warn' as const, scope: 'guests' as const };
    expect(needsGuestLookup(g, 'team', ['card'])).toBe(true);
    expect(needsGuestLookup(g, 'team', [])).toBe(false);
    expect(needsGuestLookup(g, 'deal_room', ['card'])).toBe(false);
    expect(needsGuestLookup({ ...g, scope: 'all' }, 'team', ['card'])).toBe(
      false
    );
    expect(needsGuestLookup({ ...g, mode: 'off' }, 'team', ['card'])).toBe(
      false
    );
  });

  it('warns, blocks or sends', () => {
    const at = (
      mode: 'off' | 'warn' | 'block',
      scope: 'guests' | 'all',
      hasGuest: boolean | null
    ) =>
      sensitiveDecision({
        kinds: ['card', 'iban'],
        guard: { mode, scope },
        kind: 'team',
        hasGuest,
      });
    expect(at('off', 'all', null)).toEqual({ action: 'send' });
    expect(at('warn', 'guests', true)).toEqual({
      action: 'warn',
      kinds: ['card', 'iban'],
      guests: true,
    });
    expect(at('warn', 'all', null)).toEqual({
      action: 'warn',
      kinds: ['card', 'iban'],
      guests: false,
    });
    expect(at('block', 'all', null)).toEqual({
      action: 'block',
      kinds: ['card', 'iban'],
    });
    expect(at('block', 'guests', false)).toEqual({ action: 'send' });
    expect(
      sensitiveDecision({
        kinds: [],
        guard: { mode: 'block', scope: 'all' },
        kind: 'dm',
        hasGuest: null,
      })
    ).toEqual({ action: 'send' });
  });
});
