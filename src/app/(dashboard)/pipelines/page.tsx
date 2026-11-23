'use client';

import {
  Fragment,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { updateRow } from '@/lib/supabase/changed-rows';
import { createClient } from '@/lib/supabase/client';
import type { Pipeline } from '@/types';
import { BOARD_DEAL_SELECT, type BoardDeal } from '@/lib/pipelines/board-deal';
import { loadBoardDeals } from '@/lib/pipelines/board-pages';
import { PipelineBoard } from '@/components/pipelines/pipeline-board';
import { PipelineSettings } from '@/components/pipelines/pipeline-settings';
import { DealForm } from '@/components/pipelines/deal-form';
import { PipelineAnalytics } from '@/components/pipelines/pipeline-analytics';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  ArrowDownWideNarrow,
  CircleAlert,
  GitBranch,
  Plus,
  ChevronDown,
  Settings,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@/hooks/use-can';
import { useAuth } from '@/hooks/use-auth';
import { GatedButton } from '@/components/ui/gated-button';
import { useTranslations } from 'next-intl';
import { useSessionQuery } from '@/hooks/use-session-query';
import { sessionCache, sessionKey } from '@/lib/session-cache';
import {
  canUseSpeculativeDeals,
  dealsQuestion,
  PIPELINES_QUESTION,
  planFirstWave,
} from '@/lib/pipelines/load-plan';
import {
  boardStages,
  resolveSelectedPipeline,
  splitPipelineRows,
  unknownStagesRefreshKey,
  type PipelineWithStages,
} from '@/lib/pipelines/board-stages';
import { useDealPeople } from '@/components/pipelines/use-deal-people';
import { moveDeal } from '@/lib/pipelines/deal-move';
import { dealOwnerOrFilter, ownerFilterOptions } from '@/lib/pipelines/owner';
import { useDealSignals } from '@/components/pipelines/use-deal-signals';
import { useInsightSettings } from '@/hooks/use-insight-settings';
import {
  leadScore,
  stageProgress,
  type LeadScore,
} from '@/lib/pipelines/lead-score';

// Pipeline creation is admin-class (settings-tier write under
// the new RLS); deal creation is operational and only requires
// agent+. The two CTAs gate on different `useCan` capabilities,
// not on different copy.

/**
 * localStorage key holding the pipeline selected on the last visit.
 * Its deals are requested in parallel with the pipeline list instead
 * of after it (one round trip saved, ~700ms through the tunnel); if
 * the guess no longer matches what gets selected it is just dropped.
 */
const INITIAL_PIPELINE_KEY = 'pipelines:initial-id';

function readInitialPipelineGuess(): string | null {
  try {
    return window.localStorage.getItem(INITIAL_PIPELINE_KEY);
  } catch {
    return null;
  }
}

function writeInitialPipelineGuess(id: string) {
  try {
    window.localStorage.setItem(INITIAL_PIPELINE_KEY, id);
  } catch {
    // Storage blocked (private mode etc.) — the guess is an optimisation.
  }
}

// Spec-defined seed — name and color per the product spec.
const SPEC_DEFAULT_STAGES = [
  { name: 'New Lead', color: '#3b82f6', position: 0 }, // blue
  { name: 'Qualified', color: '#eab308', position: 1 }, // yellow
  { name: 'Proposal Sent', color: '#f97316', position: 2 }, // orange
  { name: 'Negotiation', color: '#8b5cf6', position: 3 }, // purple
  { name: 'Won', color: '#22c55e', position: 4 }, // green
];

export default function PipelinesPage() {
  const t = useTranslations('Pipelines.page');
  const supabase = createClient();
  const canEditSettings = useCan('edit-settings');
  const canCreateDeals = useCan('send-messages');
  const { accountId, user, profileLoading } = useAuth();
  const userId = user?.id ?? null;
  // Whose deals the board shows (migration 080). RLS already returns
  // only what this member may see; the picker narrows within that, in
  // the query, so the board, the analytics and the counts agree.
  const people = useDealPeople();
  const { role, me, members, ledUserIds } = people;
  const ownerOptions = useMemo(
    () => ownerFilterOptions({ role, me, members, ledUserIds }),
    [role, me, members, ledUserIds]
  );
  const [ownerKey, setOwnerKey] = useState<string | null>(null);
  const selectedOwner =
    ownerOptions.find((o) => o.key === ownerKey) ?? ownerOptions[0] ?? null;
  const ownerFilter = useMemo(
    () =>
      selectedOwner && 'person' in selectedOwner
        ? dealOwnerOrFilter(selectedOwner.person)
        : null,
    [selectedOwner]
  );

  // The pipeline the user picked; what is on screen is
  // `selectedPipelineId` below, which falls back when it is gone.
  const [chosenPipelineId, setSelectedPipelineId] = useState<string>('');

  // Dialog / sheet state
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState('');
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Deal form state is lifted here so both the top-bar "Add Deal" and
  // the per-column "+" trigger the same Sheet.
  const [dealFormOpen, setDealFormOpen] = useState(false);
  const [editingDeal, setEditingDeal] = useState<BoardDeal | null>(null);
  const [defaultStageId, setDefaultStageId] = useState<string>('');

  // Guard against double-seeding (React StrictMode double-effect in dev).
  const seedAttempted = useRef(false);

  // Read by the seed through a ref so the initial-load effect does not
  // depend on it: `accountId` resolves after mount on a full page load,
  // and depending on it re-ran the whole load (pipelines, stages and
  // deals fetched twice).
  const accountIdRef = useRef(accountId);
  // Only an admin may create pipelines (RLS), so only an admin seeds.
  const canSeedRef = useRef(canEditSettings);
  useEffect(() => {
    accountIdRef.current = accountId;
    canSeedRef.current = canEditSettings;
  }, [accountId, canEditSettings]);

  // Deals requested speculatively alongside the pipeline list, with no
  // owner filter (the default view); used only if that still holds.
  const prefetchedDeals = useRef<{
    id: string;
    promise: Promise<BoardDeal[]>;
  } | null>(null);
  const firstWaveStarted = useRef(false);

  const loadDeals = useCallback(
    async (pipelineId: string, owner: string | null = null) =>
      loadBoardDeals<BoardDeal>((from, to) => {
        let query = supabase
          .from('deals')
          .select(BOARD_DEAL_SELECT, { count: 'exact' })
          .eq('pipeline_id', pipelineId);
        if (owner) query = query.or(owner);
        return query
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to)
          .overrideTypes<BoardDeal[], { merge: false }>();
      }),
    [supabase]
  );

  const seedDefaultPipeline =
    useCallback(async (): Promise<Pipeline | null> => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user || !canSeedRef.current) return null;
      // pipelines.account_id is NOT NULL post-017 with no DB default.
      const accountId = accountIdRef.current;
      if (!accountId) return null;

      const { data: pipeline, error } = await supabase
        .from('pipelines')
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: 'Sales Pipeline',
        })
        .select()
        .single();

      if (error || !pipeline) {
        console.error('Failed to seed pipeline:', error?.message);
        return null;
      }

      const stagesPayload = SPEC_DEFAULT_STAGES.map((s) => ({
        pipeline_id: pipeline.id,
        name: s.name,
        color: s.color,
        position: s.position,
      }));
      await supabase.from('pipeline_stages').insert(stagesPayload);

      return pipeline as Pipeline;
    }, [supabase]);

  // First wave: the remembered pipeline's deals start alongside the
  // pipeline list (stages embedded) instead of after it. Only on a
  // visit with no list held yet; with one, the board's own deals read
  // starts at once anyway. A wrong guess is just dropped.
  const pipelinesKey = sessionKey(accountId, userId, PIPELINES_QUESTION);
  useEffect(() => {
    if (firstWaveStarted.current) return;
    firstWaveStarted.current = true;
    if (pipelinesKey && sessionCache.peek(pipelinesKey)) return;
    const { dealsFor } = planFirstWave(readInitialPipelineGuess(), null);
    if (!dealsFor) return;
    const promise = loadDeals(dealsFor);
    promise.catch(() => {});
    prefetchedDeals.current = { id: dealsFor, promise };
  }, [pipelinesKey, loadDeals]);

  // The pipeline list with every pipeline's stages, as screen data:
  // shown at once from the last visit and always revalidated, so a
  // stage or pipeline another admin added appears when the screen is
  // shown. An empty first read seeds the default pipeline (admins only,
  // once) and reads again.
  const pipelinesQuery = useSessionQuery<PipelineWithStages[]>(
    pipelinesKey,
    async () => {
      const fetchRows = async () => {
        const { data, error } = await supabase
          .from('pipelines')
          .select('*, pipeline_stages(*)')
          .order('created_at')
          .order('position', { referencedTable: 'pipeline_stages' });
        // Throw rather than answer [] so a failed refresh keeps the
        // list on screen (and never seeds over a failed read).
        if (error) throw new Error(error.message);
        return (data ?? []) as PipelineWithStages[];
      };
      const rows = await fetchRows();
      if (rows.length > 0 || seedAttempted.current) return rows;
      seedAttempted.current = true;
      const seeded = await seedDefaultPipeline();
      return seeded ? fetchRows() : rows;
    }
  );
  const refreshPipelinesQuery = pipelinesQuery.refresh;
  const { pipelines, stagesByPipeline } = useMemo(
    () => splitPipelineRows(pipelinesQuery.data ?? []),
    [pipelinesQuery.data]
  );
  const selectedPipelineId = resolveSelectedPipeline(
    chosenPipelineId,
    pipelines
  );
  const loading =
    (!pipelinesKey && profileLoading) ||
    (pipelinesQuery.loading && !pipelinesQuery.error);

  // What a fresh visit selects first, remembered for the next first wave.
  const firstPipelineId = pipelines[0]?.id;
  useEffect(() => {
    if (firstPipelineId) writeInitialPipelineGuess(firstPipelineId);
  }, [firstPipelineId]);

  // Deals: shown at once from the last visit, always revalidated.
  const dealsKey = sessionKey(
    accountId,
    userId,
    dealsQuestion(selectedPipelineId, ownerFilter)
  );
  const dealsQuery = useSessionQuery<BoardDeal[]>(
    selectedPipelineId ? dealsKey : null,
    () => {
      const started = prefetchedDeals.current;
      prefetchedDeals.current = null; // one use only; later loads are fresh
      if (
        started &&
        canUseSpeculativeDeals(started, selectedPipelineId, ownerFilter)
      )
        return started.promise;
      return loadDeals(selectedPipelineId, ownerFilter);
    },
    // A drag patches the board while a revalidate may be running: keep
    // the patch rather than let the older answer move the card back.
    { keepLocalWrites: true }
  );
  const deals = useMemo(() => dealsQuery.data ?? [], [dealsQuery.data]);
  const refreshDealsQuery = dealsQuery.refresh;
  const setDeals = useCallback(
    (fn: (prev: BoardDeal[]) => BoardDeal[]) => {
      if (dealsKey) sessionCache.update<BoardDeal[]>(dealsKey, fn);
    },
    [dealsKey]
  );

  // The held list's stages for this pipeline, plus a placeholder column
  // for any deal on a stage the list does not have yet (another admin
  // added it since the list was read), so no deal is ever left undrawn.
  // Such a deal re-reads the list once per distinct set of stages, after
  // any read already running has answered.
  const knownStages = useMemo(
    () => stagesByPipeline.get(selectedPipelineId) ?? [],
    [stagesByPipeline, selectedPipelineId]
  );
  const board = useMemo(
    () => boardStages(knownStages, deals, t('unknownStage')),
    [knownStages, deals, t]
  );
  const stages = board.stages;
  const unknownRefreshAttempt = useRef<string | null>(null);
  const pipelinesFetching = pipelinesQuery.loading || pipelinesQuery.refreshing;
  useEffect(() => {
    // Ask the cache, not the render: on a revisit the mount revalidate
    // has started in an earlier effect of this same commit, so
    // `refreshing` is still false here and a refresh would race it.
    if (pipelinesFetching) return;
    if (pipelinesKey && sessionCache.isFetching(pipelinesKey)) return;
    const key = unknownStagesRefreshKey(
      board.unknownStageIds,
      unknownRefreshAttempt.current
    );
    if (!key) return;
    unknownRefreshAttempt.current = key;
    void refreshPipelinesQuery();
  }, [
    board.unknownStageIds,
    pipelinesFetching,
    pipelinesKey,
    refreshPipelinesQuery,
  ]);

  // Lead scores (docs/jev-insights.md): only while Customer insights
  // are on, from one batched read of the deals' conversations.
  const tScore = useTranslations('LeadScore');
  const { settings: insightSettings } = useInsightSettings();
  const signalsOn = insightSettings?.signalsEnabled === true;
  const [sortByScore, setSortByScore] = useState(false);
  const dealContactIds = useMemo(
    () => deals.flatMap((d) => (d.contact_id ? [d.contact_id] : [])),
    [deals]
  );
  const signals = useDealSignals(dealContactIds, signalsOn);
  const scores = useMemo(() => {
    if (!signals) return null;
    const map = new Map<string, LeadScore | null>();
    for (const d of deals) {
      map.set(
        d.id,
        leadScore({
          status: d.status,
          dealCreatedAt: d.created_at,
          stageProgress: stageProgress(d.stage_id, stages),
          conversation: d.contact_id
            ? (signals.byContact.get(d.contact_id) ?? null)
            : null,
          now: signals.at,
        })
      );
    }
    return map;
  }, [signals, deals, stages]);

  // Stage and pipeline edits re-read the one entry that carries both;
  // the selection falls back by itself if the chosen pipeline is gone.
  const refreshPipelines = useCallback(async () => {
    await refreshPipelinesQuery();
  }, [refreshPipelinesQuery]);

  const refreshDeals = useCallback(async () => {
    if (!selectedPipelineId) return;
    await refreshDealsQuery();
  }, [refreshDealsQuery, selectedPipelineId]);

  const handleDealMoved = useCallback(
    async (dealId: string, newStageId: string) => {
      // Optimistic update — board already animated; just persist.
      const moved = await moveDeal({
        deals,
        dealId,
        to: newStageId,
        setDeals,
        write: () =>
          updateRow(supabase, 'deals', dealId, { stage_id: newStageId }),
        refresh: refreshDeals,
      });
      if (moved === 'failed') toast.error(t('toastFailedMoveDeal'));
      else if (moved === 'none') toast.error(t('toastDealNotMoved'));
    },
    [supabase, deals, refreshDeals, setDeals, t]
  );

  const handleAddDeal = useCallback(
    (stageId?: string) => {
      setEditingDeal(null);
      setDefaultStageId(stageId ?? stages[0]?.id ?? '');
      setDealFormOpen(true);
    },
    [stages]
  );

  const handleEditDeal = useCallback((deal: BoardDeal) => {
    setEditingDeal(deal);
    setDefaultStageId(deal.stage_id);
    setDealFormOpen(true);
  }, []);

  async function handleCreatePipeline() {
    const name = newPipelineName.trim();
    if (!name) return;
    setCreating(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      setCreating(false);
      return;
    }
    // pipelines.account_id is NOT NULL post-017 with no DB default.
    if (!accountId) {
      toast.error(t('toastNotLinkedToAccount'));
      setCreating(false);
      return;
    }

    const { data: pipeline, error } = await supabase
      .from('pipelines')
      .insert({ user_id: user.id, account_id: accountId, name })
      .select()
      .single();

    if (error || !pipeline) {
      toast.error(t('toastFailedCreatePipeline'));
      setCreating(false);
      return;
    }

    const stagesPayload = SPEC_DEFAULT_STAGES.map((s) => ({
      pipeline_id: pipeline.id,
      name: s.name,
      color: s.color,
      position: s.position,
    }));
    await supabase.from('pipeline_stages').insert(stagesPayload);

    setNewPipelineName('');
    setNewPipelineOpen(false);
    setSelectedPipelineId(pipeline.id);
    await refreshPipelines();
    setCreating(false);
    toast.success(t('toastPipelineCreated'));
  }

  const selectedPipeline = pipelines.find((p) => p.id === selectedPipelineId);

  function ownerOptionLabel(o: (typeof ownerOptions)[number]): string {
    switch (o.kind) {
      case 'everyone':
        return t('ownerEveryone');
      case 'team':
        return t('ownerMyTeam');
      case 'mine':
        return t('ownerMine');
      case 'person':
        return o.person.full_name || o.person.email;
    }
  }

  // Nothing cached for this board yet: the skeleton, as before.
  const boardLoading =
    loading ||
    (!!selectedPipelineId && dealsQuery.loading && !dealsQuery.error);

  if (boardLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="bg-muted h-8 w-48 animate-pulse rounded" />
          <div className="bg-muted h-9 w-28 animate-pulse rounded-lg" />
        </div>
        <div className="flex gap-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="bg-muted/50 h-96 w-72 animate-pulse rounded-xl"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* Pipeline selector dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger className="border-border bg-card text-foreground hover:bg-muted data-[popup-open]:bg-muted inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors">
              <GitBranch className="text-primary h-4 w-4" />
              <span className="font-semibold">
                {selectedPipeline?.name ?? t('selectPipeline')}
              </span>
              <ChevronDown className="text-muted-foreground h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover text-popover-foreground w-64"
            >
              {pipelines.length === 0 && (
                <DropdownMenuItem disabled className="text-muted-foreground">
                  {t('noPipelinesYet')}
                </DropdownMenuItem>
              )}
              {pipelines.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onClick={() => setSelectedPipelineId(p.id)}
                  className={
                    p.id === selectedPipelineId
                      ? 'text-primary'
                      : 'text-popover-foreground'
                  }
                >
                  <GitBranch className="me-2 h-3.5 w-3.5" />
                  {p.name}
                </DropdownMenuItem>
              ))}
              {canEditSettings && selectedPipeline && (
                <DropdownMenuSeparator className="bg-border" />
              )}
              {canEditSettings && selectedPipeline && (
                <DropdownMenuItem
                  onClick={() => setSettingsOpen(true)}
                  className="text-popover-foreground"
                >
                  <Settings className="me-2 h-3.5 w-3.5" />
                  {t('managePipelines')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Whose deals — admins and team leaders only; anyone else
              is already narrowed to their own by RLS. */}
          {selectedOwner && (
            <DropdownMenu>
              <DropdownMenuTrigger className="border-border bg-card text-foreground hover:bg-muted data-[popup-open]:bg-muted inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors">
                <Users className="text-muted-foreground h-4 w-4" />
                <span className="text-muted-foreground">{t('showing')}</span>
                <span className="max-w-40 truncate font-medium">
                  {ownerOptionLabel(selectedOwner)}
                </span>
                <ChevronDown className="text-muted-foreground h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover text-popover-foreground max-h-80 w-64 overflow-y-auto"
              >
                {ownerOptions.map((o, i) => (
                  <Fragment key={o.key}>
                    {i === 2 && <DropdownMenuSeparator className="bg-border" />}
                    <DropdownMenuItem
                      onClick={() => setOwnerKey(o.key)}
                      className={
                        o.key === selectedOwner.key
                          ? 'text-primary'
                          : 'text-popover-foreground'
                      }
                    >
                      <span className="truncate">{ownerOptionLabel(o)}</span>
                    </DropdownMenuItem>
                  </Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <div className="flex items-center gap-2">
          {scores && (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`${tScore('sortLabel')}: ${tScore(sortByScore ? 'sortByScore' : 'sortDefault')}`}
                className="border-border bg-card text-foreground hover:bg-muted data-[popup-open]:bg-muted inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors"
              >
                <ArrowDownWideNarrow className="text-muted-foreground h-4 w-4" />
                <span className="font-medium">
                  {sortByScore ? tScore('sortByScore') : tScore('sortDefault')}
                </span>
                <ChevronDown className="text-muted-foreground h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="border-border bg-popover text-popover-foreground w-56"
              >
                <DropdownMenuItem
                  onClick={() => setSortByScore(false)}
                  className={
                    !sortByScore ? 'text-primary' : 'text-popover-foreground'
                  }
                >
                  {tScore('sortDefault')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setSortByScore(true)}
                  className={
                    sortByScore ? 'text-primary' : 'text-popover-foreground'
                  }
                >
                  {tScore('sortByScore')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <GatedButton
            variant="outline"
            canAct={canEditSettings}
            gateReason="create pipelines"
            onClick={() => setNewPipelineOpen(true)}
            className="border-border bg-card text-foreground hover:bg-muted"
          >
            <Plus className="me-1 h-4 w-4" />
            {t('addPipeline')}
          </GatedButton>
          <GatedButton
            canAct={canCreateDeals}
            gateReason="create deals"
            disabled={!selectedPipelineId || stages.length === 0}
            onClick={() => handleAddDeal()}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="me-1 h-4 w-4" />
            {t('addDeal')}
          </GatedButton>
        </div>
      </div>

      {/* Board */}
      {pipelines.length === 0 ? (
        <div className="border-border flex flex-col items-center justify-center rounded-xl border border-dashed py-20">
          <GitBranch className="text-muted-foreground h-12 w-12" />
          <h2 className="text-foreground mt-4 text-lg font-medium">
            {t('noPipelinesYet')}
          </h2>
          <p className="text-muted-foreground mt-2 text-sm">
            {t('createToStartTracking')}
          </p>
          <GatedButton
            canAct={canEditSettings}
            gateReason="create pipelines"
            onClick={() => setNewPipelineOpen(true)}
            className="bg-primary text-primary-foreground hover:bg-primary/90 mt-4"
          >
            <Plus className="me-1 h-4 w-4" />
            {t('createPipeline')}
          </GatedButton>
        </div>
      ) : dealsQuery.error && !dealsQuery.data ? (
        <div
          role="alert"
          className="border-border flex flex-col items-center justify-center rounded-xl border border-dashed py-20"
        >
          <CircleAlert className="text-destructive h-12 w-12" />
          <p className="text-foreground mt-4 text-sm">{t('dealsLoadFailed')}</p>
          <Button
            variant="outline"
            onClick={() => void refreshDeals()}
            className="mt-4"
          >
            {t('retry')}
          </Button>
        </div>
      ) : (
        <>
          <PipelineAnalytics stages={stages} deals={deals} />
          <PipelineBoard
            stages={stages}
            deals={deals}
            members={people.members}
            readOnly={!canCreateDeals}
            onDealMoved={handleDealMoved}
            onAddDeal={handleAddDeal}
            onEditDeal={handleEditDeal}
            scores={scores}
            sortByScore={sortByScore}
          />
        </>
      )}

      {/* New Pipeline Dialog */}
      <Dialog open={newPipelineOpen} onOpenChange={setNewPipelineOpen}>
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('newPipeline')}
            </DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Label className="text-muted-foreground">{t('pipelineName')}</Label>
            <Input
              value={newPipelineName}
              onChange={(e) => setNewPipelineName(e.target.value)}
              placeholder={t('pipelineNamePlaceholder')}
              className="border-border text-foreground mt-2"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreatePipeline();
              }}
            />
            <p className="text-muted-foreground mt-2 text-xs">
              {t('defaultStagesDesc')}
            </p>
          </div>
          <DialogFooter className="bg-popover/50 border-border">
            <Button
              variant="outline"
              onClick={() => setNewPipelineOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleCreatePipeline}
              disabled={creating || !newPipelineName.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {creating ? t('creating') : t('createPipelineBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pipeline Settings */}
      {canEditSettings && selectedPipeline && (
        <PipelineSettings
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          pipeline={selectedPipeline}
          stages={knownStages}
          onPipelinesChanged={refreshPipelines}
          onStagesChanged={refreshPipelines}
          onCreateNewPipeline={() => {
            setSettingsOpen(false);
            setNewPipelineOpen(true);
          }}
        />
      )}

      {/* Deal Form (Sheet) */}
      <DealForm
        open={dealFormOpen}
        onOpenChange={setDealFormOpen}
        deal={editingDeal}
        pipelineId={selectedPipelineId}
        stages={stages}
        defaultStageId={defaultStageId}
        onSaved={refreshDeals}
      />
    </div>
  );
}
