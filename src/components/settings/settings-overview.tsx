'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { aiConfigFormFromResponse } from '@/lib/ai/config-form';
import {
  agentTileStatus,
  summariseAgentOverview,
  type AgentTileStatus,
} from '@/lib/ai/agent-overview';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

import {
  SECTION_META,
  canOpenSection,
  type SettingsSection,
} from './settings-sections';
import { StatusDot } from './settings-chip';

interface OverviewCounts {
  members: number | null;
  pendingInvites: number | null;
  templates: number | null;
  templatesPending: number | null;
  customFields: number | null;
}

interface WhatsAppStatus {
  configured: boolean;
  connected: boolean;
}

export function SettingsOverview({
  onSelect,
}: {
  onSelect: (tab: SettingsSection) => void;
}) {
  const {
    user,
    profile,
    accountId,
    accountRole,
    canManageMembers,
    profileLoading,
  } = useAuth();
  const t = useTranslations('Settings.overview');
  const tSections = useTranslations('Settings.sections');
  const tCategories = useTranslations('Settings.categories');

  const [counts, setCounts] = useState<OverviewCounts | null>(null);
  const [countsLoading, setCountsLoading] = useState(true);
  // WhatsApp status is tracked separately: its health check decrypts the
  // token and pings Meta, which is far slower than the cheap count
  // queries. Gating it independently keeps a slow/flaky Meta round-trip
  // from blanking the rest of the landing.
  const [whatsapp, setWhatsapp] = useState<WhatsAppStatus | null>(null);
  const [whatsappLoading, setWhatsappLoading] = useState(true);
  // The AI Agents tile: is the assistant on, and does it auto-reply.
  const [ai, setAi] = useState<AgentTileStatus | null>(null);

  useEffect(() => {
    if (!user || !accountId) return;
    let cancelled = false;
    const supabase = createClient();
    const acctId = accountId;

    // Cheap counts — resolve fast, render immediately.
    (async () => {
      setCountsLoading(true);
      const [
        membersRes,
        invitesRes,
        templatesTotal,
        templatesPending,
        fieldsRes,
      ] = await Promise.allSettled([
        // Admin-only endpoint now, and the tile it feeds is filtered
        // out below for everyone else — so don't bother asking.
        canManageMembers
          ? fetch('/api/account/members', { cache: 'no-store' }).then((r) =>
              r.json()
            )
          : Promise.resolve({ members: [] }),
        canManageMembers
          ? fetch('/api/account/invitations', { cache: 'no-store' }).then((r) =>
              r.json()
            )
          : Promise.resolve(null),
        // Account-wide, matching the Templates panel: a synced or
        // teammate-created template counts too.
        supabase
          .from('message_templates')
          .select('id', { count: 'exact', head: true }),
        supabase
          .from('message_templates')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'PENDING'),
        supabase
          .from('custom_fields')
          .select('id', { count: 'exact', head: true }),
      ]);

      if (cancelled) return;

      const members =
        membersRes.status === 'fulfilled' &&
        Array.isArray(membersRes.value?.members)
          ? membersRes.value.members.length
          : null;
      const pendingInvites =
        invitesRes.status === 'fulfilled' &&
        invitesRes.value &&
        Array.isArray(invitesRes.value.invitations)
          ? invitesRes.value.invitations.length
          : null;

      setCounts({
        members,
        pendingInvites,
        templates:
          templatesTotal.status === 'fulfilled'
            ? (templatesTotal.value.count ?? null)
            : null,
        templatesPending:
          templatesPending.status === 'fulfilled'
            ? (templatesPending.value.count ?? null)
            : null,
        customFields:
          fieldsRes.status === 'fulfilled'
            ? (fieldsRes.value.count ?? null)
            : null,
      });
      setCountsLoading(false);
    })();

    // WhatsApp connection status — slower, independent. Skipped for
    // non-admins: the tile is filtered out of `visibleTiles` below and
    // /api/whatsapp/config now answers them with a 403, so the request
    // would be a guaranteed-useless round trip.
    (async () => {
      if (!canOpenSection('whatsapp', profileLoading ? null : accountRole)) {
        setWhatsappLoading(false);
        return;
      }
      setWhatsappLoading(true);
      const [row, health] = await Promise.allSettled([
        supabase
          .from('whatsapp_config')
          .select('phone_number_id')
          .eq('account_id', acctId)
          // Show the primary channel; an account may hold two.
          .order('is_primary', { ascending: false })
          .limit(1)
          .maybeSingle(),
        fetch('/api/whatsapp/config', { cache: 'no-store' }).then((r) =>
          r.json()
        ),
      ]);
      if (cancelled) return;
      setWhatsapp({
        configured:
          row.status === 'fulfilled' && !!row.value.data?.phone_number_id,
        connected: health.status === 'fulfilled' && !!health.value?.connected,
      });
      setWhatsappLoading(false);
    })();

    // AI status — admin-only like the AI Agents category itself.
    (async () => {
      if (!canOpenSection('ai', profileLoading ? null : accountRole)) return;
      try {
        const res = await fetch('/api/ai/config', { cache: 'no-store' });
        const data = await res.json();
        if (cancelled || !res.ok) return;
        setAi(
          agentTileStatus(
            summariseAgentOverview({
              configured: data?.configured === true,
              saved: aiConfigFormFromResponse(data ?? {}),
              aiReplyRoute: null,
              numbers: [],
            })
          )
        );
      } catch {
        // The tile falls back to its plain label.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id, accountId, canManageMembers]);

  const displayName = profile?.full_name || profile?.email || t('yourAccount');
  const initial = (profile?.full_name || profile?.email || 'U')
    .charAt(0)
    .toUpperCase();

  // Per-tile loading + subtitle. `null` counts render as a graceful
  // fallback so a single failed query never blanks a tile.
  const tiles: {
    section: SettingsSection;
    loading: boolean;
    subtitle: ReactNode;
  }[] = [
    {
      section: 'whatsapp',
      loading: whatsappLoading,
      subtitle: !whatsapp?.configured ? (
        t('notSetup')
      ) : whatsapp.connected ? (
        <>
          <StatusDot tone="ok" /> {t('connected')}
        </>
      ) : (
        <>
          <StatusDot tone="muted" /> {t('needsReconnecting')}
        </>
      ),
    },
    {
      section: 'members',
      loading: countsLoading,
      subtitle:
        counts?.members == null
          ? t('viewTeamMembers')
          : `${t('membersCount', { count: counts.members })}${
              counts.pendingInvites
                ? ` · ${t('pendingInvites', { count: counts.pendingInvites })}`
                : ''
            }`,
    },
    {
      section: 'templates',
      loading: countsLoading,
      subtitle:
        counts?.templates == null
          ? t('manageTemplates')
          : `${t('templatesCount', { count: counts.templates })}${
              counts.templatesPending
                ? ` · ${t('pendingReview', { count: counts.templatesPending })}`
                : ''
            }`,
    },
    {
      section: 'fields',
      loading: countsLoading,
      subtitle: t('fieldsCount', { count: counts?.customFields ?? 0 }),
    },
    {
      section: 'ai',
      loading: false,
      subtitle: ai === null ? tSections('ai') : t(ai),
    },
  ];

  // The Overview is the landing every member sees, and its tiles are a
  // second way into each section — so they need the same gate as the
  // rail, or a viewer would be looking at a grid of doors that bounce
  // them straight back here.
  const visibleTiles = tiles.filter(({ section }) =>
    canOpenSection(section, profileLoading ? null : accountRole)
  );

  return (
    <section className="animate-in fade-in-50 duration-200">
      {/* Identity — role and dates live in My account → Profile. */}
      <Card className="flex-row items-center gap-4 px-5 py-5">
        <Avatar size="lg" className="size-14">
          {profile?.avatar_url ? (
            <AvatarImage src={profile.avatar_url} alt={displayName} />
          ) : null}
          <AvatarFallback className="bg-primary/10 text-primary text-xl">
            {initial}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="text-foreground truncate text-base font-semibold">
            {displayName}
          </div>
          {profile?.email ? (
            <div className="text-muted-foreground truncate text-sm">
              {profile.email}
            </div>
          ) : null}
        </div>
      </Card>

      {/* Status tiles */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {visibleTiles.map(({ section, loading, subtitle }) => {
          const meta = SECTION_META[section];
          const Icon = meta.icon;
          return (
            <button
              key={section}
              type="button"
              onClick={() => onSelect(section)}
              className={cn(
                'group border-border bg-card flex items-start gap-3.5 rounded-xl border p-4 text-left transition-colors',
                'hover:border-primary-soft-2 hover:bg-card-2'
              )}
            >
              <span className="bg-primary-soft text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-foreground block text-sm font-semibold">
                  {section === 'whatsapp'
                    ? tCategories('whatsapp')
                    : tSections(section)}
                </span>
                <span className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
                  {loading ? (
                    <>
                      <Loader2 className="size-3 animate-spin" /> {t('loading')}
                    </>
                  ) : (
                    subtitle
                  )}
                </span>
              </span>
              <ChevronRight className="text-muted-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
            </button>
          );
        })}
      </div>
    </section>
  );
}
