'use client';

import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';

import { useAuth } from '@/hooks/use-auth';
import {
  SettingsMenuButton,
  SettingsNav,
} from '@/components/settings/settings-nav';
import { SettingsOverview } from '@/components/settings/settings-overview';
import { ConfirmDialog } from '@/components/ui-ext/confirm-dialog';
import {
  aiTabParam,
  inAppLeaveTarget,
  leavesAiArea,
  resolveSettingsLocation,
  settingsParamsFor,
  visibleCategories,
  type SettingsSection,
} from '@/components/settings/settings-sections';
import { canEditSettings } from '@/lib/auth/roles';
import { resolveAgentTab, type AgentTab } from '@/lib/ai/agent-tabs';

// Only one panel is ever on screen, but importing all fifteen
// statically shipped every one of them (~8.5k lines, recharts included
// via the costs panel) in the settings route's first chunk. Each panel
// now loads on demand; Overview, the landing section, stays eager.
function PanelLoading() {
  return (
    <div className="space-y-3" aria-busy="true">
      <div className="bg-muted h-6 w-48 animate-pulse rounded" />
      <div className="bg-muted/50 h-40 w-full animate-pulse rounded-xl" />
    </div>
  );
}

const ProfileForm = dynamic(
  () => import('@/components/settings/profile-form').then((m) => m.ProfileForm),
  { loading: PanelLoading }
);
const WorkspacesPanel = dynamic(
  () =>
    import('@/components/settings/workspaces-panel').then(
      (m) => m.WorkspacesPanel
    ),
  { loading: PanelLoading }
);
const SecurityPanel = dynamic(
  () =>
    import('@/components/settings/security-panel').then((m) => m.SecurityPanel),
  { loading: PanelLoading }
);
const AppearancePanel = dynamic(
  () =>
    import('@/components/settings/appearance-panel').then(
      (m) => m.AppearancePanel
    ),
  { loading: PanelLoading }
);
const NotificationsSettings = dynamic(
  () =>
    import('@/components/settings/notifications-settings').then(
      (m) => m.NotificationsSettings
    ),
  { loading: PanelLoading }
);
const WhapiNumberPanels = dynamic(
  () =>
    import('@/components/settings/whapi-number-panels').then(
      (m) => m.WhapiNumberPanels
    ),
  { loading: PanelLoading }
);
const WhatsAppNumbers = dynamic(
  () =>
    import('@/components/settings/whatsapp-numbers').then(
      (m) => m.WhatsAppNumbers
    ),
  { loading: PanelLoading }
);
const MetaChannelConfig = dynamic(
  () =>
    import('@/components/settings/meta-channel-config').then(
      (m) => m.MetaChannelConfig
    ),
  { loading: PanelLoading }
);
const WhatsAppRouting = dynamic(
  () =>
    import('@/components/settings/whatsapp-routing').then(
      (m) => m.WhatsAppRouting
    ),
  { loading: PanelLoading }
);
const WhatsAppCosts = dynamic(
  () =>
    import('@/components/settings/whatsapp-costs').then((m) => m.WhatsAppCosts),
  { loading: PanelLoading }
);
const TemplateManager = dynamic(
  () =>
    import('@/components/settings/template-manager').then(
      (m) => m.TemplateManager
    ),
  { loading: PanelLoading }
);
const QuickRepliesManager = dynamic(
  () =>
    import('@/components/settings/quick-replies-manager').then(
      (m) => m.QuickRepliesManager
    ),
  { loading: PanelLoading }
);
const ChatTagsPanel = dynamic(
  () =>
    import('@/components/settings/chat-tags-panel').then(
      (m) => m.ChatTagsPanel
    ),
  { loading: PanelLoading }
);
const CustomFieldsSettings = dynamic(
  () =>
    import('@/components/settings/custom-fields-panel').then(
      (m) => m.CustomFieldsSettings
    ),
  { loading: PanelLoading }
);
const JourneyBotSettings = dynamic(
  () =>
    import('@/components/settings/journey-bot-settings').then(
      (m) => m.JourneyBotSettings
    ),
  { loading: PanelLoading }
);
const DealsSettings = dynamic(
  () =>
    import('@/components/settings/deals-settings').then((m) => m.DealsSettings),
  { loading: PanelLoading }
);
const WorkspacePanel = dynamic(
  () =>
    import('@/components/settings/workspace-panel').then(
      (m) => m.WorkspacePanel
    ),
  { loading: PanelLoading }
);
const MembersTab = dynamic(
  () => import('@/components/settings/members-tab').then((m) => m.MembersTab),
  { loading: PanelLoading }
);
const TeamsTab = dynamic(
  () => import('@/components/settings/teams-tab').then((m) => m.TeamsTab),
  { loading: PanelLoading }
);
const TeamChatSettings = dynamic(
  () =>
    import('@/components/settings/team-chat-settings').then(
      (m) => m.TeamChatSettings
    ),
  { loading: PanelLoading }
);
const ApiKeysSettings = dynamic(
  () =>
    import('@/components/settings/api-keys-settings').then(
      (m) => m.ApiKeysSettings
    ),
  { loading: PanelLoading }
);
const PhoneSystemPanel = dynamic(
  () =>
    import('@/components/settings/phone-system/phone-system-panel').then(
      (m) => m.PhoneSystemPanel
    ),
  { loading: PanelLoading }
);
const ConsentRetentionPanel = dynamic(
  () =>
    import('@/components/settings/consent-retention-panel').then(
      (m) => m.ConsentRetentionPanel
    ),
  { loading: PanelLoading }
);
const DealRoomsPanel = dynamic(
  () =>
    import('@/components/settings/deal-rooms-panel').then(
      (m) => m.DealRoomsPanel
    ),
  { loading: PanelLoading }
);
const CasesSettingsPanel = dynamic(
  () =>
    import('@/components/settings/cases-settings-panel').then(
      (m) => m.CasesSettingsPanel
    ),
  { loading: PanelLoading }
);
const VaultPanel = dynamic(
  () => import('@/components/settings/vault-panel').then((m) => m.VaultPanel),
  { loading: PanelLoading }
);
const AuditLogPanel = dynamic(
  () =>
    import('@/components/settings/audit-log-panel').then(
      (m) => m.AuditLogPanel
    ),
  { loading: PanelLoading }
);
const AiAgentsArea = dynamic(
  () =>
    import('@/components/agents/ai-agents-area').then((m) => m.AiAgentsArea),
  { loading: PanelLoading }
);

// `useSearchParams` opts this page out of static prerendering unless it
// sits under a Suspense boundary. Without one, the production build hits
// the "missing Suspense with CSR bailout" error and the whole page bails
// to client-side rendering — shipping a settings screen whose rail never
// wires up its click handlers. You land on the section the URL carried
// (the account menu's Profile link points at `?tab=profile`) and can't
// navigate away. Mirror the login/signup split: a thin wrapper supplies
// the boundary; the inner component reads the query string.
export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsPageInner />
    </Suspense>
  );
}

function SettingsPageInner() {
  const searchParams = useSearchParams();
  const { profileLoading, accountRole } = useAuth();
  const t = useTranslations('Settings');

  // The URL (`?tab=<section>`) is the single source of truth: the group
  // is derived from it, legacy ids resolve onto their new home, and a
  // section above the caller's role lands on the Overview.
  const role = profileLoading ? null : accountRole;
  const { section, agentTab } = resolveSettingsLocation(searchParams, role);
  const groups = visibleCategories(role);
  // A bank guest has one section (Workspaces): no menu to show. Nor
  // while the role loads: with no role yet, every personal section
  // looks openable, so a guest would see a menu and Overview flash by
  // and an admin's menu would grow under their pointer.
  const showMenu =
    !profileLoading && groups.flatMap((g) => g.sections).length > 1;

  // Switch tabs with the native History API, not `router.replace`.
  // Every panel is a client component that fetches its own data, so a
  // tab change needs nothing from the server — but `router.replace`
  // still makes an RSC round trip and only updates the URL once it
  // returns. Behind the Cloudflare tunnel that request can stall, and
  // the tabs then "do nothing at all" on every click. Next keeps
  // `useSearchParams` in sync with `history.replaceState`, so this
  // re-renders the new tab instantly with no request.
  const switchTab = (nextTab: string) => {
    const params = settingsParamsFor(searchParams.toString(), nextTab);
    window.history.replaceState(null, '', `/settings?${params.toString()}`);
  };

  // A new section starts at its top. The shell scrolls <main>, not the
  // window, and the menu stays put (sticky), so without this a section
  // opened from deep in a long one would open part-way down. Only when
  // the page is scrolled past its title: a banner above it (the push
  // offer) stays where it is.
  const topRef = useRef<HTMLDivElement>(null);
  const shownSection = useRef(section);
  useEffect(() => {
    if (shownSection.current === section) return;
    shownSection.current = section;
    const top = topRef.current;
    const scroller = top?.closest('main');
    if (
      top &&
      scroller &&
      top.getBoundingClientRect().top < scroller.getBoundingClientRect().top
    ) {
      top.scrollIntoView({ block: 'start' });
    }
  }, [section]);

  // Unsaved AI edits live in the AI Agents area and die with it, and an
  // in-app move (a tab here, a sidebar link) fires no beforeunload. So
  // every way out of the area asks first while it reports edits.
  const router = useRouter();
  const [aiDirty, setAiDirty] = useState(false);
  const [leaving, setLeaving] = useState<
    { tab: string } | { href: string } | null
  >(null);

  const go = (nextTab: string) => {
    if (aiDirty && leavesAiArea(searchParams.get('tab'), nextTab)) {
      setLeaving({ tab: nextTab });
      return;
    }
    switchTab(nextTab);
  };
  const confirmLeave = () => {
    const target = leaving;
    setLeaving(null);
    if (!target) return;
    if ('tab' in target) switchTab(target.tab);
    else router.push(target.href);
  };

  // Links anywhere on the page (sidebar, header, account menu). Capture
  // phase on the document runs before React's root listener, and Next's
  // <Link> skips navigating a click that is already defaultPrevented.
  // The Settings menu's own links (`data-settings-nav`) go through `go`,
  // which asks by itself.
  useEffect(() => {
    if (!aiDirty) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor =
        e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.hasAttribute('data-settings-nav')) return;
      if (anchor.hasAttribute('download')) return;
      const target = anchor.getAttribute('target');
      if (target && target !== '_self') return;
      const href = inAppLeaveTarget(
        anchor.getAttribute('href') ?? '',
        window.location.origin
      );
      if (!href) return;
      e.preventDefault();
      setLeaving({ href });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [aiDirty]);

  const panel: Record<SettingsSection, ReactNode> = {
    overview: <SettingsOverview groups={groups} onSelect={go} />,
    profile: <ProfileForm />,
    workspaces: <WorkspacesPanel />,
    security: <SecurityPanel />,
    appearance: <AppearancePanel />,
    notifications: <NotificationsSettings />,
    whatsapp: (
      // The Whapi channel (one of several since 060, with a switcher)
      // and the Meta Cloud API number. Routing between them is its own
      // sub-tab.
      <div className="space-y-6">
        <WhapiNumberPanels />
        <MetaChannelConfig />
      </div>
    ),
    numbers: <WhatsAppNumbers />,
    routing: <WhatsAppRouting onOpenAi={() => go(aiTabParam('auto-reply'))} />,
    costs: <WhatsAppCosts />,
    templates: <TemplateManager />,
    'deal-rooms': (
      <DealRoomsPanel onOpenConsent={() => go('consent-retention')} />
    ),
    'quick-replies': <QuickRepliesManager />,
    'chat-tags': <ChatTagsPanel />,
    fields: <CustomFieldsSettings />,
    'journey-bot': (
      <JourneyBotSettings onOpenTemplates={() => go('templates')} />
    ),
    deals: <DealsSettings />,
    workspace: <WorkspacePanel />,
    members: <MembersTab />,
    teams: <TeamsTab />,
    'team-chat': <TeamChatSettings />,
    cases: <CasesSettingsPanel />,
    vault: <VaultPanel />,
    'consent-retention': <ConsentRetentionPanel />,
    'audit-log': <AuditLogPanel />,
    api: <ApiKeysSettings />,
    'phone-system': <PhoneSystemPanel />,
    ai: (
      <SettingsAiAgents
        agentTab={agentTab}
        onTabChange={(next) => go(aiTabParam(next))}
        onDirtyChange={setAiDirty}
      />
    ),
  };

  return (
    <div ref={topRef} className="scroll-mt-6">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          {t('pageTitle')}
        </h1>
        {/* It points at the menu, which a bank guest does not get. */}
        {showMenu ? (
          <p className="text-muted-foreground mt-1 text-sm">{t('pageDesc')}</p>
        ) : null}
      </div>

      {/* Wide screens: the menu in a column of its own, sticky while the
          section scrolls (and scrolling itself when taller than the
          screen). Narrower: a bar naming the section opens it in a
          sheet. */}
      <div
        className={
          showMenu
            ? 'mt-6 xl:grid xl:grid-cols-[15rem_minmax(0,1fr)] xl:items-start xl:gap-8'
            : 'mt-6'
        }
      >
        {showMenu ? (
          <aside
            data-settings-scroll=""
            className="hidden xl:sticky xl:top-6 xl:block xl:max-h-[calc(100dvh-6.5rem)] xl:overflow-y-auto xl:pr-1 xl:pb-2"
          >
            <SettingsNav
              groups={groups}
              section={section}
              searchClassName="bg-background"
              onSelect={go}
            />
          </aside>
        ) : null}
        <div className="min-w-0">
          {showMenu ? (
            <SettingsMenuButton
              groups={groups}
              section={section}
              onSelect={go}
              className="mb-5 xl:hidden"
            />
          ) : null}
          {profileLoading ? <PanelLoading /> : panel[section]}
        </div>
      </div>

      <ConfirmDialog
        open={leaving !== null}
        onOpenChange={(open) => {
          if (!open) setLeaving(null);
        }}
        title={t('leaveGuard.title')}
        description={t('leaveGuard.body')}
        cancelLabel={t('leaveGuard.stay')}
        confirmLabel={t('leaveGuard.leave')}
        onConfirm={confirmLeave}
        destructive
      />
    </div>
  );
}

/**
 * The AI Agents area as a Settings category (it was /agents). Its tab
 * is `?tab=ai-<tab>`; a bare `?tab=ai` lands on Overview once the AI is
 * configured, else Assistant (setup first).
 */
function SettingsAiAgents({
  agentTab,
  onTabChange,
  onDirtyChange,
}: {
  agentTab: string | null;
  onTabChange: (t: AgentTab) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { accountRole, accountId } = useAuth();
  const canViewUsage = accountRole ? canEditSettings(accountRole) : false;
  // Decides the landing tab, per account.
  const [configured, setConfigured] = useState<{
    accountId: string | null;
    value: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let value = false;
      try {
        const res = await fetch('/api/ai/config');
        const data = await res.json().catch(() => ({}));
        value = Boolean(data?.configured);
      } catch {
        // Not configured, as far as the landing tab is concerned.
      }
      if (!cancelled) setConfigured({ accountId, value });
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  if (!configured || configured.accountId !== accountId) {
    return <PanelLoading />;
  }
  const tab = resolveAgentTab(agentTab, {
    configured: configured.value,
    canViewUsage,
  });
  return (
    <AiAgentsArea
      tab={tab}
      onTabChange={onTabChange}
      onDirtyChange={onDirtyChange}
    />
  );
}
