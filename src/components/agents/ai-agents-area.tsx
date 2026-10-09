'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import {
  BarChart3,
  BookOpen,
  Bot,
  LayoutDashboard,
  Loader2,
  MessageSquareReply,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollFadeRow } from '@/components/ui-ext/scroll-fade-row';
import { AiActivityCard } from '@/components/settings/ai-activity';
import {
  AiSafetyPanel,
  effectiveState,
} from '@/components/settings/ai-safety-panel';
import { canOpenSection } from '@/components/settings/settings-sections';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { FORM_TABS, type AgentTab } from '@/lib/ai/agent-tabs';
import {
  autoReplyDot,
  autoReplyScopeMessage,
  partnerBankCount,
  safetyDot,
  summariseAgentOverview,
  type StatusDot,
} from '@/lib/ai/agent-overview';
import type { TsSettingsResponse } from '@/lib/typesafe/admin-types';
import { cn } from '@/lib/utils';
import { AiPlayground } from './ai-playground';
import { AiUsageCard } from './ai-usage';
import {
  AssistantSection,
  AutoReplySection,
  GuardrailRetryRow,
  KnowledgeSection,
  TabHead,
} from './ai-config-sections';
import { useAiConfigForm, type AiConfigForm } from './use-ai-config-form';

const TAB_ICONS: Record<AgentTab, typeof Bot> = {
  overview: LayoutDashboard,
  assistant: Bot,
  'auto-reply': MessageSquareReply,
  knowledge: BookOpen,
  safety: ShieldCheck,
  playground: Sparkles,
  usage: BarChart3,
};

// tabs.tsx is generated and styles the active tab with `dark:`, which
// matches nothing here (dark mode is html[data-mode='dark']).
const TRIGGER_DARK =
  '[[data-mode=dark]_&]:text-muted-foreground [[data-mode=dark]_&]:hover:text-foreground [[data-mode=dark]_&]:data-active:border-input [[data-mode=dark]_&]:data-active:bg-input/30 [[data-mode=dark]_&]:data-active:text-foreground';

const DOT_CLASS: Record<'green' | 'amber', string> = {
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
};

function Dot({ dot, label }: { dot: StatusDot; label: string }) {
  if (!dot) return null;
  return (
    <span
      className={cn('size-1.5 shrink-0 rounded-full', DOT_CLASS[dot])}
      title={label}
    >
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * The AI Agents area: a tab bar over the AI-config form (one state for
 * every tab, one save bar), the safety panel, playground and usage.
 * Owns no URL state — `/agents` maps `?tab=` onto it, and Settings
 * mounts it too.
 */
export function AiAgentsArea({
  tab,
  onTabChange,
  onDirtyChange,
}: {
  tab: AgentTab;
  onTabChange: (t: AgentTab) => void;
  /** Unsaved edits the caller would drop by unmounting this area.
   *  Reported false again on unmount. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const t = useTranslations('AiAgents');
  const tSafety = useTranslations('Settings.aiSafety');
  const form = useAiConfigForm();
  const { accountRole, profileLoading } = useAuth();
  const role = profileLoading ? null : accountRole;
  const canViewUsage = role ? canEditSettings(role) : false;
  const canViewSafety = canOpenSection('ai', role);

  // The safety settings: loaded here for the Overview and the tab dot,
  // then kept current by the panel's own loads and saves.
  // Keyed on the account, so an in-place account switch never shows the
  // previous account's state while the new one loads.
  const [safetyLoad, setSafetyLoad] = useState<{
    accountId: string | null;
    data: TsSettingsResponse | null;
    failed: boolean;
  } | null>(null);
  const accountIdRef = useRef(form.accountId);
  useEffect(() => {
    accountIdRef.current = form.accountId;
  }, [form.accountId]);
  const onSafetyData = useCallback(
    (data: TsSettingsResponse) =>
      setSafetyLoad({ accountId: accountIdRef.current, data, failed: false }),
    []
  );
  const safetyAccountRef = useRef<string | null>(null);
  useEffect(() => {
    const accountId = form.accountId;
    if (!canViewSafety || !accountId) return;
    if (safetyAccountRef.current === accountId) return;
    safetyAccountRef.current = accountId;
    void (async () => {
      let data: TsSettingsResponse | null = null;
      try {
        const res = await fetch('/api/typesafe/settings', {
          cache: 'no-store',
        });
        const json = await res.json().catch(() => null);
        if (res.ok && json?.settings && json?.status) data = json;
      } catch {
        // The Overview shows the safety card as unavailable.
      }
      // The panel's data, if it already arrived, is at least as new.
      setSafetyLoad((prev) =>
        prev?.accountId === accountId && prev.data
          ? prev
          : { accountId, data, failed: data === null }
      );
    })();
  }, [canViewSafety, form.accountId]);
  const current =
    safetyLoad && safetyLoad.accountId === form.accountId ? safetyLoad : null;
  const safety = current?.data ?? null;
  const safetyFailed = current?.failed ?? false;

  // A reload or closed tab would drop edits; switching tabs keeps them.
  useEffect(() => {
    if (!form.dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older browsers need a truthy returnValue to show the prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [form.dirty]);

  // In-app navigation unmounts this area without a beforeunload, so
  // the host asks before leaving. Only edits that could be saved count.
  const unsaved = form.dirty && form.canEdit;
  useEffect(() => {
    onDirtyChange?.(unsaved);
    return () => onDirtyChange?.(false);
  }, [onDirtyChange, unsaved]);

  const overview = summariseAgentOverview({
    configured: form.configured,
    saved: form.savedValues,
    aiReplyRoute: form.savedAiReplyRoute,
    numbers: form.numbers,
  });
  const safetyState = safety
    ? effectiveState(safety.settings, safety.status)
    : null;

  const dots: Partial<Record<AgentTab, { dot: StatusDot; label: string }>> = {
    'auto-reply': { dot: autoReplyDot(overview), label: t('dot.green') },
    safety: {
      dot: safetyDot(safetyState),
      label: safetyState ? tSafety(`state.${safetyState}`) : '',
    },
  };

  const tabs: AgentTab[] = [
    'overview',
    'assistant',
    'auto-reply',
    'knowledge',
    'safety',
    'playground',
    ...(canViewUsage ? (['usage'] as const) : []),
  ];

  const showSaveBar = FORM_TABS.includes(tab) && form.dirty && form.canEdit;

  return (
    <Tabs value={tab} onValueChange={(v) => onTabChange(v as AgentTab)}>
      <ScrollFadeRow activeKey={tab} className="-mx-1 px-1 pb-1">
        <TabsList>
          {tabs.map((id) => {
            const Icon = TAB_ICONS[id];
            const dot = dots[id];
            return (
              <TabsTrigger
                key={id}
                value={id}
                className={cn('px-2.5', TRIGGER_DARK)}
              >
                <Icon />
                {t(`tabs.${id}`)}
                {dot ? <Dot dot={dot.dot} label={dot.label} /> : null}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </ScrollFadeRow>

      <TabsContent value="overview" className="mt-4">
        {form.loading ? (
          <AreaLoading />
        ) : (
          <OverviewTab
            form={form}
            overview={overview}
            canViewSafety={canViewSafety}
            safetyState={safetyState}
            safetyFailed={safetyFailed}
            partnerBanks={
              safety
                ? partnerBankCount(safety.partner_banks, safety.bank_catalogue)
                : null
            }
            onTabChange={onTabChange}
          />
        )}
      </TabsContent>

      <TabsContent value="assistant" className="mt-4">
        <FormTab form={form}>
          <AssistantSection form={form} />
        </FormTab>
      </TabsContent>
      <TabsContent value="auto-reply" className="mt-4">
        <FormTab form={form}>
          <AutoReplySection form={form} />
        </FormTab>
      </TabsContent>
      <TabsContent value="knowledge" className="mt-4">
        <FormTab form={form}>
          <KnowledgeSection form={form} />
        </FormTab>
      </TabsContent>
      <TabsContent value="safety" className="mt-4">
        <AiSafetyPanel
          guardrailExtra={<GuardrailRetryRow form={form} />}
          onDataChange={onSafetyData}
        />
      </TabsContent>
      <TabsContent value="playground" className="mt-4">
        <AiPlayground onGoToSetup={() => onTabChange('assistant')} />
      </TabsContent>
      {canViewUsage ? (
        <TabsContent value="usage" className="mt-4">
          <AiUsageCard />
        </TabsContent>
      ) : null}

      {showSaveBar ? (
        <div className="border-border bg-card/95 supports-[backdrop-filter]:bg-card/80 sticky bottom-0 z-10 mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 shadow-sm backdrop-blur">
          <p className="text-foreground text-sm font-medium">
            {t('saveBar.unsaved')}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={form.discard}
              disabled={form.saving}
            >
              {t('saveBar.discard')}
            </Button>
            <Button onClick={() => void form.save()} disabled={form.saving}>
              {form.saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('saveBar.saving')}
                </>
              ) : (
                t('saveBar.save')
              )}
            </Button>
          </div>
        </div>
      ) : null}
    </Tabs>
  );
}

function AreaLoading() {
  const t = useTranslations('AiAgents');
  return (
    <div className="text-muted-foreground flex items-center justify-center py-16 text-sm">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
    </div>
  );
}

/** A form tab: a loader until the config arrives, and the read-only
 *  notice for roles that cannot change it. */
function FormTab({
  form,
  children,
}: {
  form: AiConfigForm;
  children: ReactNode;
}) {
  const t = useTranslations('Settings.aiConfig');
  if (form.loading) return <AreaLoading />;
  return (
    <>
      {!form.canEdit ? (
        <p className="border-border bg-muted/40 text-muted-foreground mb-4 rounded-md border px-3 py-2 text-sm">
          {t('adminOnlyConfig')}
        </p>
      ) : null}
      {children}
    </>
  );
}

function StatusCard({
  icon: Icon,
  title,
  value,
  dot,
  detail,
  onChange,
}: {
  icon: typeof Bot;
  title: string;
  value: string;
  dot: StatusDot;
  detail?: string;
  onChange: () => void;
}) {
  const t = useTranslations('AiAgents');
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Icon className="text-primary mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <p className="text-muted-foreground text-xs">{title}</p>
            <p className="text-foreground flex items-center gap-1.5 text-sm font-medium">
              {dot ? <Dot dot={dot} label={value} /> : null}
              {value}
            </p>
            {detail ? (
              <p className="text-muted-foreground truncate text-xs">{detail}</p>
            ) : null}
          </div>
        </div>
        <Button
          variant="link"
          size="sm"
          className="h-auto shrink-0 px-0"
          onClick={onChange}
        >
          {t('overview.change')}
        </Button>
      </CardContent>
    </Card>
  );
}

function OverviewTab({
  form,
  overview,
  canViewSafety,
  safetyState,
  safetyFailed,
  partnerBanks,
  onTabChange,
}: {
  form: AiConfigForm;
  overview: ReturnType<typeof summariseAgentOverview>;
  canViewSafety: boolean;
  safetyState: ReturnType<typeof effectiveState> | null;
  safetyFailed: boolean;
  partnerBanks: number | null;
  onTabChange: (t: AgentTab) => void;
}) {
  const t = useTranslations('AiAgents');
  const tSafety = useTranslations('Settings.aiSafety');

  // The same list the Knowledge tab loads (title and date only): its
  // length is the document count.
  const [documents, setDocuments] = useState<number | null | 'error'>(null);
  const { accountId } = form;
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/ai/knowledge');
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        setDocuments(
          res.ok && Array.isArray(data?.documents)
            ? data.documents.length
            : 'error'
        );
      } catch {
        if (!cancelled) setDocuments('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const onOff = (on: boolean) => (on ? t('overview.on') : t('overview.off'));
  // Worded by the pure helper so a no-route account is never described
  // as pinned to one number (it answers on every number of that type).
  const scopeMessage = autoReplyScopeMessage(overview.autoReply.scope);
  const scopeText =
    'values' in scopeMessage
      ? t(scopeMessage.key, scopeMessage.values)
      : t(scopeMessage.key);

  return (
    <div className="space-y-6">
      <TabHead title={t('tabs.overview')} description={t('overview.desc')} />
      <div className="grid gap-4 sm:grid-cols-2">
        <StatusCard
          icon={Bot}
          title={t('tabs.assistant')}
          value={
            overview.assistant.configured
              ? onOff(overview.assistant.on)
              : t('overview.notSetUp')
          }
          dot={overview.assistant.on ? 'green' : null}
          onChange={() => onTabChange('assistant')}
        />
        <StatusCard
          icon={MessageSquareReply}
          title={t('tabs.auto-reply')}
          value={onOff(overview.autoReply.on)}
          dot={autoReplyDot(overview)}
          detail={scopeText}
          onChange={() => onTabChange('auto-reply')}
        />
        {canViewSafety ? (
          <StatusCard
            icon={ShieldCheck}
            title={t('tabs.safety')}
            value={
              safetyState
                ? tSafety(`state.${safetyState}`)
                : safetyFailed
                  ? t('overview.unavailable')
                  : t('loading')
            }
            dot={safetyDot(safetyState)}
            detail={
              partnerBanks === null
                ? undefined
                : t('overview.partnerBanks', { count: partnerBanks })
            }
            onChange={() => onTabChange('safety')}
          />
        ) : null}
        <StatusCard
          icon={BookOpen}
          title={t('tabs.knowledge')}
          value={
            documents === null
              ? t('loading')
              : documents === 'error'
                ? t('overview.unavailable')
                : t('overview.documents', { count: documents })
          }
          dot={null}
          onChange={() => onTabChange('knowledge')}
        />
      </div>
      <AiActivityCard accountId={form.accountId} canEdit={form.canEdit} />
    </div>
  );
}
