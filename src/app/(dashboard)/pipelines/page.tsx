'use client';

import {
  Fragment,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Pipeline, PipelineStage, Deal } from '@/types';
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
import { GitBranch, Plus, ChevronDown, Settings, Users } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@/hooks/use-can';
import { useAuth } from '@/hooks/use-auth';
import { GatedButton } from '@/components/ui/gated-button';
import { useTranslations } from 'next-intl';
import { useDealPeople } from '@/components/pipelines/use-deal-people';
import { dealOwnerOrFilter, ownerFilterOptions } from '@/lib/pipelines/owner';

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

type PipelineWithStages = Pipeline & {
  pipeline_stages?: PipelineStage[] | null;
};

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
  const { accountId } = useAuth();
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

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>('');
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);

  // Dialog / sheet state
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState('');
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Deal form state is lifted here so both the top-bar "Add Deal" and
  // the per-column "+" trigger the same Sheet.
  const [dealFormOpen, setDealFormOpen] = useState(false);
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null);
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

  // Stages arrive embedded with the pipeline list, so switching the
  // selection only needs the deals.
  const stagesByPipeline = useRef(new Map<string, PipelineStage[]>());
  // Deals requested speculatively alongside the pipeline list, with no
  // owner filter (the default view); used only if that still holds.
  const prefetchedDeals = useRef<{
    id: string;
    promise: Promise<Deal[]>;
  } | null>(null);

  const loadPipelines = useCallback(async (): Promise<Pipeline[]> => {
    const { data, error } = await supabase
      .from('pipelines')
      .select('*, pipeline_stages(*)')
      .order('created_at')
      .order('position', { referencedTable: 'pipeline_stages' });
    if (error) {
      console.error('Failed to load pipelines:', error.message);
      return [];
    }
    const map = new Map<string, PipelineStage[]>();
    const list = ((data ?? []) as PipelineWithStages[]).map(
      ({ pipeline_stages, ...p }) => {
        map.set(p.id, pipeline_stages ?? []);
        return p as Pipeline;
      }
    );
    stagesByPipeline.current = map;
    return list;
  }, [supabase]);

  const loadStages = useCallback(
    async (pipelineId: string) => {
      const { data } = await supabase
        .from('pipeline_stages')
        .select('*')
        .eq('pipeline_id', pipelineId)
        .order('position');
      return data ?? [];
    },
    [supabase]
  );

  const loadDeals = useCallback(
    async (pipelineId: string, owner: string | null = null) => {
      let query = supabase
        .from('deals')
        .select(
          '*, contact:contacts(*), assignee:profiles!deals_assigned_to_fkey(*)'
        )
        .eq('pipeline_id', pipelineId);
      if (owner) query = query.or(owner);
      const { data } = await query.order('created_at', { ascending: false });
      return (data ?? []) as Deal[];
    },
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

  // Initial load + seed-if-empty
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const guess = readInitialPipelineGuess();
      if (guess)
        prefetchedDeals.current = { id: guess, promise: loadDeals(guess) };
      let list = await loadPipelines();

      if (list.length === 0 && !seedAttempted.current) {
        seedAttempted.current = true;
        const seeded = await seedDefaultPipeline();
        if (seeded) list = await loadPipelines();
      }

      if (cancelled) return;
      setPipelines(list);
      if (list.length > 0) {
        setSelectedPipelineId((prev) => {
          const next =
            prev && list.some((p) => p.id === prev) ? prev : list[0].id;
          writeInitialPipelineGuess(next);
          return next;
        });
      } else {
        setSelectedPipelineId('');
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadPipelines, loadDeals, seedDefaultPipeline]);

  // Load stages + deals whenever selected pipeline changes.
  // Clearing on no-selection is a legitimate sync with URL/prop
  // state; the load completion uses async setters inside promise
  // callbacks (not synchronous in the effect body).
  useEffect(() => {
    if (!selectedPipelineId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStages([]);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDeals([]);
      return;
    }
    let cancelled = false;
    const prefetched = prefetchedDeals.current;
    prefetchedDeals.current = null; // one use only; later loads are fresh
    const cachedStages = stagesByPipeline.current.get(selectedPipelineId);
    (async () => {
      const [s, d] = await Promise.all([
        cachedStages ?? loadStages(selectedPipelineId),
        prefetched?.id === selectedPipelineId && !ownerFilter
          ? prefetched.promise
          : loadDeals(selectedPipelineId, ownerFilter),
      ]);
      if (cancelled) return;
      setStages(s);
      setDeals(d);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPipelineId, ownerFilter, loadStages, loadDeals]);

  const refreshPipelines = useCallback(async () => {
    const list = await loadPipelines();
    setPipelines(list);
    if (list.length === 0) setSelectedPipelineId('');
    else if (!list.some((p) => p.id === selectedPipelineId))
      setSelectedPipelineId(list[0].id);
  }, [loadPipelines, selectedPipelineId]);

  const refreshStages = useCallback(async () => {
    if (!selectedPipelineId) return;
    const fresh = await loadStages(selectedPipelineId);
    // Keep the embedded copy in step, or switching away and back would
    // show the stages as they were before the edit.
    stagesByPipeline.current.set(selectedPipelineId, fresh);
    setStages(fresh);
  }, [loadStages, selectedPipelineId]);

  const refreshDeals = useCallback(async () => {
    if (!selectedPipelineId) return;
    setDeals(await loadDeals(selectedPipelineId, ownerFilter));
  }, [loadDeals, selectedPipelineId, ownerFilter]);

  const handleDealMoved = useCallback(
    async (dealId: string, newStageId: string) => {
      // Optimistic update — board already animated; just persist.
      setDeals((prev) =>
        prev.map((d) => (d.id === dealId ? { ...d, stage_id: newStageId } : d))
      );
      const { error } = await supabase
        .from('deals')
        .update({ stage_id: newStageId })
        .eq('id', dealId);
      if (error) {
        toast.error(t('toastFailedMoveDeal'));
        refreshDeals();
      }
    },
    [supabase, refreshDeals, t]
  );

  const handleAddDeal = useCallback(
    (stageId?: string) => {
      setEditingDeal(null);
      setDefaultStageId(stageId ?? stages[0]?.id ?? '');
      setDealFormOpen(true);
    },
    [stages]
  );

  const handleEditDeal = useCallback((deal: Deal) => {
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

  if (loading) {
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
                  <GitBranch className="mr-2 h-3.5 w-3.5" />
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
                  <Settings className="mr-2 h-3.5 w-3.5" />
                  {t('managePipelines')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Whose deals — admins and team leaders only; anyone else
              is already narrowed to their own by RLS. */}
          {selectedOwner && (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t('showing')}
                className="border-border bg-card text-foreground hover:bg-muted data-[popup-open]:bg-muted inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors"
              >
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
          <GatedButton
            variant="outline"
            canAct={canEditSettings}
            gateReason="create pipelines"
            onClick={() => setNewPipelineOpen(true)}
            className="border-border bg-card text-foreground hover:bg-muted"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t('addPipeline')}
          </GatedButton>
          <GatedButton
            canAct={canCreateDeals}
            gateReason="create deals"
            disabled={!selectedPipelineId || stages.length === 0}
            onClick={() => handleAddDeal()}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t('addDeal')}
          </GatedButton>
        </div>
      </div>

      {/* Board */}
      {pipelines.length === 0 ? (
        <div className="border-border flex flex-col items-center justify-center rounded-xl border border-dashed py-20">
          <GitBranch className="text-muted-foreground h-12 w-12" />
          <h3 className="text-foreground mt-4 text-lg font-medium">
            {t('noPipelinesYet')}
          </h3>
          <p className="text-muted-foreground mt-2 text-sm">
            {t('createToStartTracking')}
          </p>
          <GatedButton
            canAct={canEditSettings}
            gateReason="create pipelines"
            onClick={() => setNewPipelineOpen(true)}
            className="bg-primary text-primary-foreground hover:bg-primary/90 mt-4"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t('createPipeline')}
          </GatedButton>
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
          stages={stages}
          onPipelinesChanged={refreshPipelines}
          onStagesChanged={refreshStages}
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
