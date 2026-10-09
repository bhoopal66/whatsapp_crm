/**
 * The AI Agents screen's sub-tabs (`/agents?tab=<id>`). Pure, so the
 * URL parsing and the landing rule are unit-tested.
 */
export const AGENT_TABS = [
  'overview',
  'assistant',
  'auto-reply',
  'knowledge',
  'safety',
  'playground',
  'usage',
] as const;

export type AgentTab = (typeof AGENT_TABS)[number];

/** Tabs whose controls belong to the AI-config form (the save bar). */
export const FORM_TABS: readonly AgentTab[] = [
  'assistant',
  'auto-reply',
  'knowledge',
  'safety',
];

export function isAgentTab(value: unknown): value is AgentTab {
  return (
    typeof value === 'string' &&
    (AGENT_TABS as readonly string[]).includes(value)
  );
}

/**
 * The tab to show for a raw `?tab=` value. Unknown, missing or not
 * permitted (`usage` without `canViewUsage`) lands on the default:
 * Overview once the AI is configured, else Assistant (setup first).
 */
export function resolveAgentTab(
  raw: string | null | undefined,
  { configured, canViewUsage }: { configured: boolean; canViewUsage: boolean }
): AgentTab {
  // Older links: the pre-tabs "Setup", and Settings' section id.
  const value =
    raw === 'setup' ? 'assistant' : raw === 'ai-safety' ? 'safety' : raw;
  if (isAgentTab(value) && (value !== 'usage' || canViewUsage)) return value;
  return configured ? 'overview' : 'assistant';
}
