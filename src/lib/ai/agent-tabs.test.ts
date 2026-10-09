import { describe, expect, it } from 'vitest';

import { AGENT_TABS, isAgentTab, resolveAgentTab } from './agent-tabs';

const ctx = { configured: true, canViewUsage: true };

describe('resolveAgentTab', () => {
  it('accepts every known tab', () => {
    for (const tab of AGENT_TABS) expect(resolveAgentTab(tab, ctx)).toBe(tab);
  });

  it('defaults to overview when configured, assistant when not', () => {
    expect(resolveAgentTab(null, ctx)).toBe('overview');
    expect(resolveAgentTab('nope', ctx)).toBe('overview');
    expect(resolveAgentTab(undefined, { ...ctx, configured: false })).toBe(
      'assistant'
    );
  });

  it('keeps usage from roles that cannot see it', () => {
    expect(resolveAgentTab('usage', { ...ctx, canViewUsage: false })).toBe(
      'overview'
    );
  });

  it('maps legacy ids', () => {
    expect(resolveAgentTab('setup', ctx)).toBe('assistant');
    expect(resolveAgentTab('ai-safety', ctx)).toBe('safety');
  });

  it('isAgentTab rejects non-strings', () => {
    expect(isAgentTab(3)).toBe(false);
    expect(isAgentTab('safety')).toBe(true);
  });
});
