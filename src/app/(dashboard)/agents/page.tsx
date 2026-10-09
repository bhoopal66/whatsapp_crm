'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Bot, Loader2 } from 'lucide-react';

import { AiAgentsArea } from '@/components/agents/ai-agents-area';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { resolveAgentTab, type AgentTab } from '@/lib/ai/agent-tabs';

export default function AgentsPage() {
  const t = useTranslations('AiAgents');
  return (
    <div>
      <div className="flex items-center gap-2">
        <Bot className="text-primary h-6 w-6" />
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          {t('title')}
        </h1>
      </div>
      <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>

      <div className="mt-6">
        {/* useSearchParams opts this subtree out of prerendering. */}
        <Suspense fallback={<TabsLoading />}>
          <AgentsTabs />
        </Suspense>
      </div>
    </div>
  );
}

function TabsLoading() {
  const t = useTranslations('AiAgents');
  return (
    <div className="text-muted-foreground flex items-center justify-center py-16 text-sm">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
    </div>
  );
}

/**
 * `?tab=` ↔ the area. The tab is derived from the URL alone: a change is
 * a `history.pushState`, which Next syncs into `useSearchParams`, so
 * back/forward re-renders the right tab without local state.
 */
function AgentsTabs() {
  const searchParams = useSearchParams();
  const { accountRole, profileLoading } = useAuth();
  const canViewUsage = accountRole ? canEditSettings(accountRole) : false;
  // Decides the landing tab: Overview once configured, else Assistant.
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/config');
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setConfigured(Boolean(data?.configured));
      } catch {
        if (!cancelled) setConfigured(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onTabChange = useCallback((next: AgentTab) => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('tab') === next) return;
    params.set('tab', next);
    window.history.pushState(null, '', `?${params.toString()}`);
  }, []);

  if (configured === null || profileLoading) return <TabsLoading />;

  const tab = resolveAgentTab(searchParams.get('tab'), {
    configured,
    canViewUsage,
  });
  return <AiAgentsArea tab={tab} onTabChange={onTabChange} />;
}
