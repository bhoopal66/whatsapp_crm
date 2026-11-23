'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { MessageTemplate } from '@/types';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import { Step4ScheduleSend } from '@/components/broadcasts/step4-schedule-send';
import {
  useBroadcastSending,
  type AudienceConfig,
  type VariableMapping,
} from '@/hooks/use-broadcast-sending';
import { pickTemplateVariables } from '@/lib/broadcasts/variables';
import type { QuietHours } from '@/lib/broadcasts/quiet-hours';
import {
  deserializeDraft,
  draftResumeStep,
  findDraftTemplate,
  reopenedSchedule,
  serializeDraft,
} from '@/lib/broadcasts/draft-state';
import {
  saveDraft,
  sendReopenedDraft,
  type SaveDraftResult,
} from '@/lib/broadcasts/draft-send';
import { readContactsAudience } from '@/lib/broadcasts/audience-handoff';
import { readRecycleAudience } from '@/lib/recycle/handoff';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';

const steps = [
  { label: 'template', key: 'template' },
  { label: 'audience', key: 'audience' },
  { label: 'personalize', key: 'personalize' },
  { label: 'send', key: 'send' },
] as const;

export default function NewBroadcastPage() {
  // useSearchParams (the ?draft= id) needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <NewBroadcastWizard />
    </Suspense>
  );
}

function NewBroadcastWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const draftParam = searchParams.get('draft');
  const t = useTranslations('Broadcasts.new');
  const { accountId } = useAuth();
  const { createAndSendBroadcast, isProcessing, progress } =
    useBroadcastSending();

  const [currentStep, setCurrentStep] = useState(0);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [audience, setAudience] = useState<AudienceConfig>(
    () => readRecycleAudience() ?? readContactsAudience() ?? { type: 'all' }
  );
  const [variables, setVariables] = useState<Record<string, VariableMapping>>(
    {}
  );
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [name, setName] = useState('');
  const [scheduledAt, setScheduledAt] = useState<Date | null>(null);
  const [quietHours, setQuietHours] = useState<QuietHours | null>(null);
  const [followUpFlowId, setFollowUpFlowId] = useState<string | null>(null);
  // Track D U14: the draft row this wizard continues, so "Save draft"
  // updates it and a send claims (deletes) it first.
  const [draftId, setDraftId] = useState<string | null>(draftParam);
  // One save or send at a time: the claim and the insert run before
  // `isProcessing` disables the buttons, and a double click would lose
  // its own claim or leave two drafts.
  const busyRef = useRef(false);

  // Reopen a saved draft: restore the whole wizard state and land on the
  // furthest step whose input exists.
  useEffect(() => {
    if (!draftParam) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from('broadcasts')
        .select('id, name, status')
        .eq('id', draftParam)
        .maybeSingle();
      if (cancelled) return;
      // The wizard state lives in `broadcast_drafts` (migration 256),
      // admins and owners only by RLS.
      let stateError: unknown = null;
      let rawState: unknown = null;
      if (!error && data && data.status === 'draft') {
        const res = await supabase
          .from('broadcast_drafts')
          .select('state')
          .eq('broadcast_id', draftParam)
          .maybeSingle();
        if (cancelled) return;
        stateError = res.error;
        rawState = res.data?.state ?? null;
      }
      const state = rawState ? deserializeDraft(rawState) : null;
      if (error || stateError || !state) {
        setDraftId(null);
        toast.error(t('toastDraftCannotOpen'));
        return;
      }
      let found: MessageTemplate | null = null;
      if (state.template) {
        found = await findDraftTemplate(supabase, state.template);
        if (!found) toast.error(t('toastDraftTemplateGone'));
      }
      if (cancelled) return;
      setTemplate(found);
      setAudience(state.audience);
      setVariables(state.variables);
      setHeaderMediaUrl(state.headerMediaUrl);
      setName(state.name || data?.name || '');
      const schedule = reopenedSchedule(state.scheduledAt);
      setScheduledAt(schedule.at);
      if (schedule.dropped) {
        // Without it the send button means "now": say so for longer than
        // an ordinary toast.
        toast.warning(
          t('toastDraftSchedulePast', {
            when: schedule.dropped.toLocaleString(),
          }),
          { duration: 20_000 }
        );
      }
      setQuietHours(state.quietHours);
      setFollowUpFlowId(state.followUpFlowId);
      if (state.csvDropped) toast.message(t('toastDraftCsvDropped'));
      setCurrentStep(draftResumeStep(state, found !== null));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftParam]);

  async function handleSend() {
    if (!template || busyRef.current) return;
    busyRef.current = true;
    try {
      await sendCampaign(template);
    } finally {
      busyRef.current = false;
    }
  }

  async function sendCampaign(template: MessageTemplate) {
    const result = await sendReopenedDraft({
      draftId,
      claim: (id) =>
        createClient()
          .from('broadcasts')
          .delete()
          .eq('id', id)
          .eq('status', 'draft')
          .select('id'),
      create: (onCampaignCreated) =>
        createAndSendBroadcast({
          name,
          template,
          audience: {
            type: audience.type,
            chatTagIds: audience.chatTagIds,
            customField: audience.customField,
            csvContacts: audience.csvContacts,
            csvColumns: audience.csvColumns,
            // Not `compassSample`: that is the preview row, and the send
            // re-reads the whole slice from this selection.
            compass: audience.compass,
            excludeChatTagIds: audience.excludeChatTagIds,
            skipRecentDays: audience.skipRecentDays,
            chatTagMatch: audience.chatTagMatch,
            bankCodes: audience.bankCodes,
            bankSource: audience.bankSource,
            leadSources: audience.leadSources,
          },
          // Only this template's variables: mappings made for another
          // template earlier in the wizard would shift the values.
          variables: pickTemplateVariables(variables, template.body_text),
          headerMediaUrl,
          scheduledAt,
          quietHours,
          followUpFlowId,
          onCampaignCreated,
        }),
      restore: () => writeDraft(template, null),
    });

    switch (result.kind) {
      case 'sent': {
        const { broadcastId, scheduledFor } = result.outcome;
        if (scheduledFor) {
          toast.success(
            t('toastScheduled', { when: scheduledFor.toLocaleString() })
          );
        }
        router.push(`/broadcasts/${broadcastId}`);
        return;
      }
      // `draftId` stays set in both: clearing it would let the next
      // click send the wizard unclaimed.
      case 'claim_lost':
        toast.error(t('toastDraftGone'));
        return;
      case 'claim_failed':
        toast.error(t('toastDraftClaimFailed', { error: result.message }));
        return;
      case 'failed': {
        // Previously swallowed with console.error — the wizard would
        // just no-op, leaving the user confused. Surface the reason.
        const { error, campaignId, restored } = result;
        console.error('Broadcast failed:', error);
        toast.error(
          error instanceof Error ? error.message : 'Broadcast failed'
        );
        if (!draftId) return;
        if (campaignId) {
          // The draft is spent: continue from the campaign, where a
          // second click resumes it instead of sending it again.
          toast.message(t('toastDraftCampaignExists'));
          router.push(`/broadcasts/${campaignId}`);
          return;
        }
        // This tab alone claimed the draft, so it may go on without one.
        setDraftId(restored && restored.kind !== 'gone' ? restored.id : null);
        if (restored?.kind === 'saved') toast.message(t('toastDraftRestored'));
        else toast.error(t('toastDraftNotRestored'));
      }
    }
  }

  /**
   * Writes (or, given an id, updates) a draft broadcast row — no
   * recipients, no sending. The whole wizard state goes into
   * `broadcast_drafts.state` (migration 256, admin-only) so "Open draft"
   * on the list brings the person back to exactly here. A send deletes
   * the draft broadcasts row, which cascades the state.
   */
  async function writeDraft(
    template: MessageTemplate,
    id: string | null
  ): Promise<SaveDraftResult> {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) return { kind: 'failed', id, message: t('toastNotSignedIn') };
    if (!accountId) return { kind: 'failed', id, message: t('toastNotLinked') };

    const draftState = serializeDraft({
      template,
      audience,
      variables: pickTemplateVariables(variables, template.body_text),
      headerMediaUrl,
      name: name.trim(),
      scheduledAt,
      quietHours,
      followUpFlowId,
    });
    const fields = {
      name: name.trim(),
      template_name: template.name,
      template_language: template.language ?? 'en_US',
      template_variables: pickTemplateVariables(variables, template.body_text),
      audience_filter: {
        type: audience.type,
        chatTagIds: audience.chatTagIds,
        chatTagMatch: audience.chatTagMatch,
        excludeChatTagIds: audience.excludeChatTagIds,
        bankCodes: audience.bankCodes,
        bankSource: audience.bankSource,
        leadSources: audience.leadSources,
        compass: audience.type === 'compass' ? audience.compass : undefined,
      },
      header_media_url: headerMediaUrl.trim() || null,
      quiet_hours: quietHours,
      follow_up_flow_id: followUpFlowId,
    };
    return saveDraft({
      draftId: id,
      update: (draft) =>
        supabase
          .from('broadcasts')
          .update(fields)
          .eq('id', draft)
          .eq('status', 'draft')
          .select('id'),
      insert: () =>
        supabase
          .from('broadcasts')
          .insert({
            ...fields,
            user_id: user.id,
            account_id: accountId,
            status: 'draft',
            total_recipients: 0,
            sent_count: 0,
            delivered_count: 0,
            read_count: 0,
            replied_count: 0,
            failed_count: 0,
          })
          .select('id')
          .single(),
      saveState: (draft) =>
        supabase.from('broadcast_drafts').upsert(
          {
            broadcast_id: draft,
            account_id: accountId,
            state: draftState,
            updated_by: user.id,
          },
          { onConflict: 'broadcast_id' }
        ),
    });
  }

  async function handleSaveDraft() {
    if (!template || !name.trim()) {
      toast.error(t('toastGiveName'));
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const result = await writeDraft(template, draftId);
      if (result.kind === 'gone') {
        toast.error(t('toastDraftGone'));
        return;
      }
      // A retry after a failed state write updates this row, not a new one.
      setDraftId(result.id);
      if (result.kind === 'failed') {
        toast.error(t('toastFailedDraft', { error: result.message }));
        return;
      }
      toast.success(t('toastDraftSaved'));
      router.push('/broadcasts');
    } finally {
      busyRef.current = false;
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('subtitle')}</p>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center justify-between">
        {steps.map((step, index) => {
          const isActive = index === currentStep;
          const isCompleted = index < currentStep;

          return (
            <div key={step.key} className="flex flex-1 items-center">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all ${
                    isCompleted
                      ? 'bg-primary text-primary-foreground'
                      : isActive
                        ? 'border-primary bg-primary/10 text-primary border-2'
                        : 'border-border bg-muted text-muted-foreground border'
                  }`}
                >
                  {isCompleted ? <Check className="h-4 w-4" /> : index + 1}
                </div>
                <span
                  className={`hidden text-sm font-medium sm:block ${
                    isActive
                      ? 'text-foreground'
                      : isCompleted
                        ? 'text-primary'
                        : 'text-muted-foreground'
                  }`}
                >
                  {t(`steps.${step.label}`)}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={`mx-3 h-px flex-1 ${
                    index < currentStep ? 'bg-primary' : 'bg-muted'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="relative min-h-[400px]">
        <div
          className="transition-all duration-300 ease-in-out"
          style={{
            opacity: isProcessing ? 0.6 : 1,
            pointerEvents: isProcessing ? 'none' : 'auto',
          }}
        >
          {currentStep === 0 && (
            <Step1ChooseTemplate
              selectedTemplate={template}
              onSelect={setTemplate}
              onNext={() => setCurrentStep(1)}
              onBack={() => router.push('/broadcasts')}
            />
          )}
          {currentStep === 1 && (
            <Step2SelectAudience
              audience={audience}
              onUpdate={setAudience}
              onNext={() => setCurrentStep(2)}
              onBack={() => setCurrentStep(0)}
            />
          )}
          {currentStep === 2 && template && (
            <Step3Personalize
              template={template}
              audience={audience}
              variables={variables}
              onUpdate={setVariables}
              headerMediaUrl={headerMediaUrl}
              onHeaderMediaUrlChange={setHeaderMediaUrl}
              onNext={() => setCurrentStep(3)}
              onBack={() => setCurrentStep(1)}
            />
          )}
          {currentStep === 3 && template && (
            <Step4ScheduleSend
              name={name}
              onNameChange={setName}
              template={template}
              audience={audience}
              scheduledAt={scheduledAt}
              onScheduledAtChange={setScheduledAt}
              quietHours={quietHours}
              onQuietHoursChange={setQuietHours}
              followUpFlowId={followUpFlowId}
              onFollowUpFlowIdChange={setFollowUpFlowId}
              onSend={handleSend}
              onSaveDraft={handleSaveDraft}
              onBack={() => setCurrentStep(2)}
              isProcessing={isProcessing}
              progress={progress}
            />
          )}
        </div>
      </div>
    </div>
  );
}
