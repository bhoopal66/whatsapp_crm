'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, KeyRound, Loader2, UserPen } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

import {
  CATEGORY_ICONS,
  SECTION_META,
  canOpenSection,
  type SettingsSection,
} from './settings-sections';
import { StatusDot } from './settings-chip';
import {
  isPlainClick,
  settingsHref,
  type SettingsNavGroup,
} from './settings-nav';

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

/**
 * The Settings landing: who you are, then one card per group listing
 * every section you may open, each with a live status where there is
 * one (WhatsApp connection, members, templates, fields, AI) and a
 * one-line explanation otherwise — a map of all of Settings.
 */
export function SettingsOverview({
  groups,
  onSelect,
}: {
  /** The caller's visible groups (`visibleCategories`), Overview
   *  included; it gets no card of its own. */
  groups: SettingsNavGroup[];
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
  const tSettings = useTranslations('Settings');

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

  // Live statuses, by section. `null` counts render as a graceful
  // fallback so a single failed query never blanks a row; a section
  // with no status shows its hint instead.
  const status: Partial<
    Record<SettingsSection, { loading: boolean; content: ReactNode }>
  > = {
    whatsapp: {
      loading: whatsappLoading,
      content: !whatsapp?.configured ? (
        <>
          <StatusDot tone="warn" /> {t('notSetup')}
        </>
      ) : whatsapp.connected ? (
        <>
          <StatusDot tone="ok" /> {t('connected')}
        </>
      ) : (
        <>
          <StatusDot tone="warn" /> {t('needsReconnecting')}
        </>
      ),
    },
    // The roster is admin-only: a team leader, who opens Members to
    // invite, gets the hint rather than a count of nobody.
    ...(canManageMembers
      ? {
          members: {
            loading: countsLoading,
            content:
              counts?.members == null
                ? t('viewTeamMembers')
                : `${t('membersCount', { count: counts.members })}${
                    counts.pendingInvites
                      ? ` · ${t('pendingInvites', { count: counts.pendingInvites })}`
                      : ''
                  }`,
          },
        }
      : {}),
    templates: {
      loading: countsLoading,
      content:
        counts?.templates == null
          ? t('manageTemplates')
          : `${t('templatesCount', { count: counts.templates })}${
              counts.templatesPending
                ? ` · ${t('pendingReview', { count: counts.templatesPending })}`
                : ''
            }`,
    },
    fields: {
      loading: countsLoading,
      content: t('fieldsCount', { count: counts?.customFields ?? 0 }),
    },
    ai: {
      loading: false,
      content:
        ai === null ? (
          tSettings('hints.ai')
        ) : (
          <>
            <StatusDot
              tone={ai === 'aiOn' || ai === 'aiAutoReply' ? 'ok' : 'muted'}
            />{' '}
            {t(ai)}
          </>
        ),
    },
  };

  // The groups come from `visibleCategories`, the same gate as the
  // menu: the Overview is the landing every member sees, and a row the
  // role could not open would be a door that bounces them straight back
  // here.
  const cards = groups.filter((g) => g.id !== 'overview');
  const canOpenSecurity = canOpenSection(
    'security',
    profileLoading ? null : accountRole
  );

  return (
    <section className="animate-in fade-in-50 space-y-5 duration-200">
      {/* Identity — role and dates live in My account → Profile. */}
      <Card className="flex-row flex-wrap items-center gap-4 px-5 py-5">
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
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            render={<a href={settingsHref('profile')} />}
            nativeButton={false}
            onClick={(e) => {
              if (!isPlainClick(e)) return;
              e.preventDefault();
              onSelect('profile');
            }}
          >
            <UserPen className="size-4" />
            {t('editProfile')}
          </Button>
          {canOpenSecurity ? (
            <Button
              variant="outline"
              size="sm"
              render={<a href={settingsHref('security')} />}
              nativeButton={false}
              onClick={(e) => {
                if (!isPlainClick(e)) return;
                e.preventDefault();
                onSelect('security');
              }}
            >
              <KeyRound className="size-4" />
              {t('changePassword')}
            </Button>
          ) : null}
        </div>
      </Card>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        {cards.map((group) => {
          const GroupIcon = CATEGORY_ICONS[group.id];
          return (
            <Card key={group.id} className="gap-0 py-0">
              <div className="border-border flex items-center gap-3 border-b px-4 py-3">
                <span className="bg-primary-soft text-primary flex size-8 shrink-0 items-center justify-center rounded-lg">
                  <GroupIcon aria-hidden className="size-4" />
                </span>
                <div className="min-w-0">
                  <h2 className="text-foreground text-sm font-semibold">
                    {tSettings(`categories.${group.id}`)}
                  </h2>
                  <p className="text-muted-foreground text-xs">
                    {tSettings(`categoryHints.${group.id}`)}
                  </p>
                </div>
              </div>
              <ul className="divide-border divide-y">
                {group.sections.map((section) => {
                  const Icon = SECTION_META[section].icon;
                  const live = status[section];
                  return (
                    <li key={section}>
                      <a
                        href={settingsHref(section)}
                        onClick={(e) => {
                          if (!isPlainClick(e)) return;
                          e.preventDefault();
                          onSelect(section);
                        }}
                        className="group hover:bg-card-2 focus-visible:bg-card-2 flex items-center gap-3 px-4 py-2.5 transition-colors outline-none"
                      >
                        <Icon
                          aria-hidden
                          className="text-muted-foreground group-hover:text-primary size-4 shrink-0 transition-colors"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="text-foreground block text-sm font-medium">
                            {tSettings(`sections.${section}`)}
                          </span>
                          <span className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
                            {live?.loading ? (
                              <>
                                <Loader2 className="size-3 animate-spin" />{' '}
                                {t('loading')}
                              </>
                            ) : (
                              (live?.content ?? tSettings(`hints.${section}`))
                            )}
                          </span>
                        </span>
                        <ChevronRight
                          aria-hidden
                          className="text-muted-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5"
                        />
                      </a>
                    </li>
                  );
                })}
              </ul>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
