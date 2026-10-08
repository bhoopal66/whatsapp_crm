'use client';

import { Suspense, useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';

import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { SettingsRail } from '@/components/settings/settings-rail';
import { SettingsOverview } from '@/components/settings/settings-overview';
import {
  DEFAULT_SECTION,
  canOpenSection,
  resolveSection,
  type SettingsSection,
} from '@/components/settings/settings-sections';

// Only one panel is ever on screen, but importing all fifteen
// statically shipped every one of them (~8.5k lines, recharts included
// via the costs panel) in the settings route's first chunk. Each panel
// now loads on demand; Overview, the landing section, stays eager.
function PanelLoading() {
  return (
    <div className="space-y-3" aria-busy="true">
      <div className="h-6 w-48 animate-pulse rounded bg-muted" />
      <div className="h-40 w-full animate-pulse rounded-xl bg-muted/50" />
    </div>
  );
}

const ProfileForm = dynamic(
  () => import('@/components/settings/profile-form').then((m) => m.ProfileForm),
  { loading: PanelLoading },
);
const SecurityPanel = dynamic(
  () => import('@/components/settings/security-panel').then((m) => m.SecurityPanel),
  { loading: PanelLoading },
);
const AppearancePanel = dynamic(
  () => import('@/components/settings/appearance-panel').then((m) => m.AppearancePanel),
  { loading: PanelLoading },
);
const WhapiNumberPanels = dynamic(
  () => import('@/components/settings/whapi-number-panels').then((m) => m.WhapiNumberPanels),
  { loading: PanelLoading },
);
const WhatsAppNumbers = dynamic(
  () => import('@/components/settings/whatsapp-numbers').then((m) => m.WhatsAppNumbers),
  { loading: PanelLoading },
);
const MetaChannelConfig = dynamic(
  () => import('@/components/settings/meta-channel-config').then((m) => m.MetaChannelConfig),
  { loading: PanelLoading },
);
const WhatsAppRouting = dynamic(
  () => import('@/components/settings/whatsapp-routing').then((m) => m.WhatsAppRouting),
  { loading: PanelLoading },
);
const WhatsAppCosts = dynamic(
  () => import('@/components/settings/whatsapp-costs').then((m) => m.WhatsAppCosts),
  { loading: PanelLoading },
);
const TemplateManager = dynamic(
  () => import('@/components/settings/template-manager').then((m) => m.TemplateManager),
  { loading: PanelLoading },
);
const QuickRepliesManager = dynamic(
  () => import('@/components/settings/quick-replies-manager').then((m) => m.QuickRepliesManager),
  { loading: PanelLoading },
);
const ChatTagsPanel = dynamic(
  () => import('@/components/settings/chat-tags-panel').then((m) => m.ChatTagsPanel),
  { loading: PanelLoading },
);
const FieldsAndTagsPanel = dynamic(
  () => import('@/components/settings/fields-and-tags-panel').then((m) => m.FieldsAndTagsPanel),
  { loading: PanelLoading },
);
const DealsSettings = dynamic(
  () => import('@/components/settings/deals-settings').then((m) => m.DealsSettings),
  { loading: PanelLoading },
);
const MembersTab = dynamic(
  () => import('@/components/settings/members-tab').then((m) => m.MembersTab),
  { loading: PanelLoading },
);
const TeamsTab = dynamic(
  () => import('@/components/settings/teams-tab').then((m) => m.TeamsTab),
  { loading: PanelLoading },
);
const ApiKeysSettings = dynamic(
  () => import('@/components/settings/api-keys-settings').then((m) => m.ApiKeysSettings),
  { loading: PanelLoading },
);
const AiSafetyPanel = dynamic(
  () => import('@/components/settings/ai-safety-panel').then((m) => m.AiSafetyPanel),
  { loading: PanelLoading },
);

// `useSearchParams` opts this page out of static prerendering unless it
// sits under a Suspense boundary. Without one, the production build hits
// the "missing Suspense with CSR bailout" error and the whole page bails
// to client-side rendering — shipping a settings screen whose rail never
// wires up its click handlers. You land on the section the URL carried
// (the account-menu Settings link points at `?tab=whatsapp`) and can't
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
  const { defaultCurrency, profileLoading, accountRole } = useAuth();
  const { mode } = useTheme();
  const t = useTranslations('Settings');

  // The URL (`?tab=`) is the single source of truth for the active
  // section — deep-linkable, and it keeps the existing links in the
  // app sidebar/header working. Legacy tab values (tags, custom-fields)
  // resolve onto their new home; unknown/empty → the Overview landing.
  const requested = resolveSection(searchParams.get('tab'));

  // `?tab=` is user-supplied, so resolving it is not the same as being
  // allowed to see it. Anyone below the section's minimum role lands
  // on Overview instead — which every member can see — rather than
  // rendering a panel the rail deliberately hides. Also covers the
  // admin who gets demoted with a workspace tab still open.
  const role = profileLoading ? null : accountRole;
  const section = canOpenSection(requested, role) ? requested : DEFAULT_SECTION;

  // Switch sections with the native History API, not `router.replace`.
  // Every panel is a client component that fetches its own data, so a
  // section change needs nothing from the server — but `router.replace`
  // still makes an RSC round trip and only updates the URL once it
  // returns. Behind the Cloudflare tunnel that request can stall, and
  // the rail then "does nothing at all" on every click. Next keeps
  // `useSearchParams` in sync with `history.replaceState`, so this
  // re-renders the new section instantly with no request.
  const go = (next: SettingsSection) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    window.history.replaceState(null, '', `/settings?${params.toString()}`);
  };

  // Cheap, fetch-free rail hints. The Overview landing carries the
  // full live status/counts; the rail just surfaces the two that are
  // already in context.
  const hints: Partial<Record<SettingsSection, ReactNode>> = useMemo(
    () => ({
      appearance: mode.charAt(0).toUpperCase() + mode.slice(1),
      deals: defaultCurrency,
    }),
    [mode, defaultCurrency],
  );

  const panel: Record<SettingsSection, ReactNode> = {
    overview: <SettingsOverview onSelect={go} />,
    profile: <ProfileForm />,
    security: <SecurityPanel />,
    appearance: <AppearancePanel />,
    whatsapp: (
      // Three stacked panels since migration 046: the Whapi channel
      // (one of several since 060, with a switcher), the Meta Cloud API
      // number, and the selector that decides which of them carries
      // each kind of message. Ordered the way an operator sets them up.
      <div className="space-y-6">
        <WhapiNumberPanels />
        <MetaChannelConfig />
        <WhatsAppRouting />
      </div>
    ),
    numbers: <WhatsAppNumbers />,
    costs: <WhatsAppCosts />,
    templates: <TemplateManager />,
    'quick-replies': <QuickRepliesManager />,
    'chat-tags': <ChatTagsPanel />,
    fields: <FieldsAndTagsPanel />,
    deals: <DealsSettings />,
    members: <MembersTab />,
    teams: <TeamsTab />,
    api: <ApiKeysSettings />,
    'ai-safety': <AiSafetyPanel />,
  };

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {t('pageTitle')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('pageDesc')}
        </p>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[236px_minmax(0,1fr)] lg:items-start">
        <SettingsRail active={section} onSelect={go} hints={hints} />
        <div className="min-w-0">{panel[section]}</div>
      </div>
    </div>
  );
}
