'use client';

import { Suspense, useEffect, useState } from 'react';
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
  reopenedScheduledAt,
  serializeDraft,
} from '@/lib/broadcasts/draft-state';
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
  const [audience, setAudience] = useState<AudienceConfig>({ type: 'all' });
  const [variables, setVariables] = useState<Record<string, VariableMapping>>(
    {}
  );
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [name, setName] = useState('');
  const [scheduledAt, setScheduledAt] = useState<Date | null>(null);
  const [quietHours, setQuietHours] = useState<QuietHours | null>(null);
  const [followUpFlowId, setFollowUpFlowId] = useState<string | null>(null);
  // Track D U14: the draft row this wizard continues, so "Save draft"
  // updates it and a send removes it.
  const [draftId, setDraftId] = useState<string | null>(draftParam);

  // Reopen a saved draft: restore the whole wizard state and land on the
  // furthest step whose input exists.
  useEffect(() => {
    if (!draftParam) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from('broadcasts')
        .select('id, name, status, draft_state')
        .eq('id', draftParam)
        .maybeSingle();
      if (cancelled) return;
      const state =
        data && data.status === 'draft'
          ? deserializeDraft(data.draft_state)
          : null;
      if (error || !state) {
        setDraftId(null);
        toast.error(t('toastDraftCannotOpen'));
        return;
      }
      let found: MessageTemplate | null = null;
      if (state.template) {
        const { data: tpl } = await supabase
          .from('message_templates')
          .select('*')
          .eq('name', state.template.name)
          .eq('language', state.template.language)
          .limit(1)
          .maybeSingle();
        found = (tpl as MessageTemplate | null) ?? null;
        if (!found) toast.error(t('toastDraftTemplateGone'));
      }
      if (cancelled) return;
      setTemplate(found);
      setAudience(state.audience);
      setVariables(state.variables);
      setHeaderMediaUrl(state.headerMediaUrl);
      setName(state.name || data?.name || '');
      setScheduledAt(reopenedScheduledAt(state.scheduledAt));
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
    if (!template) return;

    try {
      const { broadcastId, scheduledFor } = await createAndSendBroadcast({
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
      });
      // The real campaign exists now: the draft it came from is spent
      // (deleted, so the list never shows both). Best-effort.
      if (draftId) {
        await createClient()
          .from('broadcasts')
          .delete()
          .eq('id', draftId)
          .eq('status', 'draft');
      }
      if (scheduledFor) {
        toast.success(
          t('toastScheduled', { when: scheduledFor.toLocaleString() })
        );
      }
      router.push(`/broadcasts/${broadcastId}`);
    } catch (err) {
      // Previously swallowed with console.error — the wizard would
      // just no-op, leaving the user confused. Surface the reason.
      const message = err instanceof Error ? err.message : 'Broadcast failed';
      console.error('Broadcast failed:', err);
      toast.error(message);
    }
  }

  /**
   * Writes (or, when this wizard was opened from a draft, updates) a
   * draft broadcast row — no recipients, no sending. The whole wizard
   * state goes into `draft_state` (migration 252) so "Open draft" on the
   * list brings the person back to exactly here.
   */
  async function handleSaveDraft() {
    if (!template || !name.trim()) {
      toast.error(t('toastGiveName'));
      return;
    }
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error(t('toastNotSignedIn'));
      return;
    }
    if (!accountId) {
      toast.error(t('toastNotLinked'));
      return;
    }

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
      draft_state: draftState,
    };
    const { error } = draftId
      ? await supabase
          .from('broadcasts')
          .update(fields)
          .eq('id', draftId)
          .eq('status', 'draft')
      : await supabase.from('broadcasts').insert({
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
        });

    if (error) {
      toast.error(t('toastFailedDraft', { error: error.message }));
      return;
    }
    toast.success(t('toastDraftSaved'));
    router.push('/broadcasts');
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
