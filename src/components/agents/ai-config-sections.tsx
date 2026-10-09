'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  CheckCircle2,
  ChevronRight,
  Eye,
  EyeOff,
  Loader2,
  MessagesSquare,
  Sparkles,
  Trash2,
  UserRoundCheck,
} from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { AiKnowledgeCard } from '@/components/settings/ai-knowledge';
import { AiKnowledgeGapsCard } from '@/components/settings/ai-knowledge-gaps';
import {
  AI_PROVIDER_DEFAULT_MODEL,
  AI_TIER_DEFAULT_MODELS,
} from '@/lib/ai/defaults';
import { AUTO_RESUME_CHOICES } from '@/lib/ai/outcomes';
import type { AiProvider } from '@/lib/ai/types';
import { memberLabel } from '@/lib/account/members';
import { cn } from '@/lib/utils';
import type { AiConfigForm } from './use-ai-config-form';

// Select can't use an empty-string item value: sentinels map to null.
const HANDOFF_QUEUE = '__queue__';
const RESUME_NEVER = '__never__';

const PROVIDER_LABEL: Record<AiProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
};

const KEY_PLACEHOLDER: Record<AiProvider, string> = {
  openai: 'sk-...',
  anthropic: 'sk-ant-...',
};

/** One tab's heading: a title and a one-line description. */
export function TabHead({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-4">
      <h2 className="text-foreground text-lg font-semibold">{title}</h2>
      <p className="text-muted-foreground text-sm">{description}</p>
    </div>
  );
}

export function SwitchRow({
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  title: string;
  description: ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="border-border flex items-center justify-between gap-4 rounded-md border p-3">
      <div>
        <p className="text-foreground text-sm font-medium">{title}</p>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={title}
      />
    </div>
  );
}

/** A collapsed-by-default group for rarely needed controls. */
export function AdvancedSection({ children }: { children: ReactNode }) {
  const t = useTranslations('AiAgents');
  return (
    <details className="group border-border rounded-md border">
      <summary className="text-foreground flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium select-none">
        <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
        {t('advanced')}
      </summary>
      <div className="space-y-4 border-t px-3 py-3">{children}</div>
    </details>
  );
}

function GroupTitle({ icon, children }: { icon: ReactNode; children: string }) {
  return (
    <CardTitle className="flex items-center gap-2 text-base">
      {icon} {children}
    </CardTitle>
  );
}

// ------------------------------------------------------------------
// Assistant
// ------------------------------------------------------------------

export function AssistantSection({ form }: { form: AiConfigForm }) {
  const t = useTranslations('Settings.aiConfig');
  const ta = useTranslations('AiAgents');
  const [showKey, setShowKey] = useState(false);
  const { values: v, set } = form;
  const disabled = !form.canEdit || form.saving;

  return (
    <div className="space-y-6">
      <TabHead
        title={ta('tabs.assistant')}
        description={ta('desc.assistant')}
      />
      <SwitchRow
        title={ta('assistantOn')}
        description={t('enableAssistantDesc')}
        checked={v.isActive}
        onCheckedChange={(x) => set('isActive', x)}
        disabled={disabled}
      />

      <Card>
        <CardHeader>
          <GroupTitle icon={<Sparkles className="text-primary h-4 w-4" />}>
            {t('providerAndKey')}
          </GroupTitle>
          <CardDescription>{t('encryptionNotice')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>{t('provider')}</Label>
              <Select
                value={v.provider}
                onValueChange={(x) => form.changeProvider(x as AiProvider)}
                disabled={disabled}
              >
                <SelectTrigger>
                  <SelectValue>{PROVIDER_LABEL[v.provider]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">
                    {PROVIDER_LABEL.openai}
                  </SelectItem>
                  <SelectItem value="anthropic">
                    {PROVIDER_LABEL.anthropic}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ai-model">{t('model')}</Label>
              <Input
                id="ai-model"
                value={v.model}
                onChange={(e) => set('model', e.target.value)}
                placeholder={AI_PROVIDER_DEFAULT_MODEL[v.provider]}
                disabled={disabled}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="ai-key">{t('apiKey')}</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="ai-key"
                  type={showKey ? 'text' : 'password'}
                  value={v.apiKey}
                  onChange={(e) => {
                    set('apiKey', e.target.value);
                    set('keyEdited', true);
                  }}
                  onFocus={() => {
                    if (!v.keyEdited && form.hasStoredKey) {
                      set('apiKey', '');
                      set('keyEdited', true);
                    }
                  }}
                  placeholder={KEY_PLACEHOLDER[v.provider]}
                  disabled={disabled}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((s) => !s)}
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                  tabIndex={-1}
                >
                  {showKey ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
              <Button
                variant="outline"
                onClick={() => void form.test()}
                disabled={disabled || form.testing}
              >
                {form.testing ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                )}
                {t('testKey')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{ta('modelsTitle')}</CardTitle>
          <CardDescription>{t('modelRoutingDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <SwitchRow
            title={t('modelRouting')}
            description={t('modelRoutingDesc')}
            checked={v.modelRouting}
            onCheckedChange={(x) => set('modelRouting', x)}
            disabled={disabled}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ai-model-small">{t('smallModel')}</Label>
              <Input
                id="ai-model-small"
                value={v.modelSmall}
                onChange={(e) => set('modelSmall', e.target.value)}
                placeholder={AI_TIER_DEFAULT_MODELS[v.provider].small}
                disabled={disabled}
              />
              <p className="text-muted-foreground text-xs">
                {t('smallModelDesc')}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ai-model-large">{t('largeModel')}</Label>
              <Input
                id="ai-model-large"
                value={v.modelLarge}
                onChange={(e) => set('modelLarge', e.target.value)}
                placeholder={AI_TIER_DEFAULT_MODELS[v.provider].large}
                disabled={disabled}
              />
              <p className="text-muted-foreground text-xs">
                {t('largeModelDesc')}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('businessContext')}</CardTitle>
          <CardDescription>{t('behaviourDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            id="ai-prompt"
            aria-label={t('businessContext')}
            value={v.systemPrompt}
            onChange={(e) => set('systemPrompt', e.target.value)}
            placeholder={t('promptPlaceholder')}
            rows={6}
            disabled={disabled}
          />
        </CardContent>
      </Card>

      {form.configured ? (
        <div>
          <Button
            variant="ghost"
            onClick={() => void form.remove()}
            disabled={!form.canEdit || form.removing}
            className="text-destructive hover:text-destructive"
          >
            {form.removing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="mr-2 h-4 w-4" />
            )}
            {t('remove')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------
// Auto-reply
// ------------------------------------------------------------------

export function AutoReplySection({ form }: { form: AiConfigForm }) {
  const t = useTranslations('Settings.aiConfig');
  const ta = useTranslations('AiAgents');
  const { values: v, set } = form;
  const disabled = !form.canEdit || form.saving;
  const off = disabled || !v.autoReplyEnabled;

  const resumeLabel = (minutes: number | null) =>
    minutes === null
      ? t('autoResumeNever')
      : minutes % 60 === 0
        ? t('autoResumeHours', { count: minutes / 60 })
        : t('autoResumeMinutes', { count: minutes });
  // A value saved through the API that is not a choice shows as itself.
  const resumeChoices = AUTO_RESUME_CHOICES.includes(v.autoResumeMinutes)
    ? AUTO_RESUME_CHOICES
    : [...AUTO_RESUME_CHOICES, v.autoResumeMinutes];

  // "Only on" always names one number: with no explicit route saved the
  // default number is preselected, and saving pins it (buildAiSavePlan).
  const pickedNumber = form.aiReplyRoute ?? form.defaultRouteId;
  const routeLabel =
    pickedNumber === null
      ? null
      : (form.numbers.find((n) => n.id === pickedNumber)?.name ?? pickedNumber);

  return (
    <div className="space-y-6">
      <TabHead
        title={ta('tabs.auto-reply')}
        description={ta('desc.auto-reply')}
      />

      <SwitchRow
        title={t('autoReply')}
        description={v.isActive ? t('autoReplyDesc') : ta('assistantFirst')}
        checked={v.autoReplyEnabled}
        onCheckedChange={(x) => set('autoReplyEnabled', x)}
        disabled={disabled || !v.isActive}
      />

      <Card>
        <CardHeader>
          <GroupTitle
            icon={<MessagesSquare className="text-primary h-4 w-4" />}
          >
            {ta('whichChats')}
          </GroupTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <p className="text-foreground text-sm font-medium" id="ai-reply-on">
              {ta('replyOn.title')}
            </p>
            {!v.autoReplyEnabled ? (
              <p className="text-muted-foreground text-xs">
                {ta('replyOn.whenOff')}
              </p>
            ) : null}
            {/* Editable while auto-reply is off, so it is set before the
                bot starts. */}
            <RadioGroup
              aria-labelledby="ai-reply-on"
              value={v.replyOnAllNumbers ? 'all' : 'only'}
              onValueChange={(x) => set('replyOnAllNumbers', x === 'all')}
              disabled={disabled}
              className="gap-2"
            >
              {(['all', 'only'] as const).map((mode) => (
                <label
                  key={mode}
                  className={cn(
                    'border-border flex cursor-pointer items-start gap-3 rounded-md border p-3',
                    (v.replyOnAllNumbers ? 'all' : 'only') === mode &&
                      'border-primary-soft-2 bg-primary-soft',
                    disabled && 'cursor-not-allowed opacity-60'
                  )}
                >
                  <RadioGroupItem value={mode} className="mt-0.5" />
                  <span className="min-w-0 flex-1 space-y-2">
                    <span className="text-foreground block text-sm font-medium">
                      {ta(`replyOn.${mode}`)}
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {ta(`replyOn.${mode}Desc`)}
                    </span>
                    {mode === 'only' && !v.replyOnAllNumbers ? (
                      <>
                        <Select
                          value={pickedNumber}
                          onValueChange={(x) => {
                            if (x) form.setAiReplyRoute(x);
                          }}
                          disabled={disabled}
                        >
                          <SelectTrigger
                            className="w-full sm:max-w-xs"
                            aria-label={ta('replyOn.only')}
                          >
                            <SelectValue>{routeLabel}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {form.numbers.map((n) => (
                              <SelectItem key={n.id} value={n.id}>
                                {n.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {form.savedAiReplyRoute === null ? (
                          <span className="text-muted-foreground block text-xs">
                            {ta('replyOn.lockHint')}
                          </span>
                        ) : null}
                      </>
                    ) : null}
                  </span>
                </label>
              ))}
            </RadioGroup>
          </div>

          <SwitchRow
            title={t('campaignOnly')}
            description={t('campaignOnlyDesc')}
            checked={v.autoReplyCampaignOnly}
            onCheckedChange={(x) => set('autoReplyCampaignOnly', x)}
            disabled={off}
          />

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="ai-max">{t('maxAutoReplies')}</Label>
              <p className="text-muted-foreground text-xs">
                {t('maxAutoRepliesDesc')}
              </p>
            </div>
            <Input
              id="ai-max"
              type="number"
              min={1}
              max={20}
              value={v.maxPerConversation}
              onChange={(e) =>
                set(
                  'maxPerConversation',
                  Math.min(20, Math.max(1, Number(e.target.value) || 1))
                )
              }
              disabled={off}
              className="w-20"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <GroupTitle
            icon={<UserRoundCheck className="text-primary h-4 w-4" />}
          >
            {ta('handOver')}
          </GroupTitle>
          <CardDescription>{t('handoverDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ai-handoff">{t('handoffTo')}</Label>
            <p className="text-muted-foreground text-xs">
              {t('handoffToDesc')}
            </p>
            <Select
              value={v.handoffAgentId || HANDOFF_QUEUE}
              onValueChange={(x) =>
                set('handoffAgentId', !x || x === HANDOFF_QUEUE ? '' : x)
              }
              disabled={off}
            >
              <SelectTrigger id="ai-handoff">
                <SelectValue>
                  {(() => {
                    const m = form.members.find(
                      (m) => m.user_id === v.handoffAgentId
                    );
                    return m ? memberLabel(m) : t('handoffQueue');
                  })()}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={HANDOFF_QUEUE}>
                  {t('handoffQueue')}
                </SelectItem>
                {/* Deactivated members (069) can't take a hand-off —
                    except one already saved here. */}
                {form.members
                  .filter(
                    (m) => !m.deactivated_at || m.user_id === v.handoffAgentId
                  )
                  .map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {memberLabel(m)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="ai-handoff-message">{t('handoffMessage')}</Label>
            <p className="text-muted-foreground text-xs">
              {t('handoffMessageDesc')}
            </p>
            <Textarea
              id="ai-handoff-message"
              value={v.handoffMessage}
              onChange={(e) => set('handoffMessage', e.target.value)}
              placeholder={t('handoffMessagePlaceholder')}
              rows={3}
              maxLength={1000}
              disabled={off}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="ai-escalation">{t('escalationKeywords')}</Label>
            <p className="text-muted-foreground text-xs">
              {t('escalationKeywordsDesc')}
            </p>
            <Textarea
              id="ai-escalation"
              value={v.escalationKeywords}
              onChange={(e) => set('escalationKeywords', e.target.value)}
              placeholder={t('escalationKeywordsPlaceholder')}
              rows={4}
              disabled={off}
            />
          </div>

          <SwitchRow
            title={t('pauseOnAgentReply')}
            description={t('pauseOnAgentReplyDesc')}
            checked={v.pauseOnAgentReply}
            onCheckedChange={(x) => set('pauseOnAgentReply', x)}
            disabled={disabled}
          />

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="ai-auto-resume">{t('autoResume')}</Label>
              <p className="text-muted-foreground text-xs">
                {t('autoResumeDesc')}
              </p>
            </div>
            <Select
              value={
                v.autoResumeMinutes === null
                  ? RESUME_NEVER
                  : String(v.autoResumeMinutes)
              }
              onValueChange={(x) =>
                set(
                  'autoResumeMinutes',
                  !x || x === RESUME_NEVER ? null : Number(x)
                )
              }
              disabled={disabled || !v.pauseOnAgentReply}
            >
              <SelectTrigger id="ai-auto-resume" className="w-32">
                <SelectValue>{resumeLabel(v.autoResumeMinutes)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {resumeChoices.map((m) => (
                  <SelectItem
                    key={m ?? RESUME_NEVER}
                    value={m === null ? RESUME_NEVER : String(m)}
                  >
                    {resumeLabel(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------
// Knowledge
// ------------------------------------------------------------------

export function KnowledgeSection({ form }: { form: AiConfigForm }) {
  const t = useTranslations('Settings.aiConfig');
  const ta = useTranslations('AiAgents');
  const { values: v, set } = form;
  const disabled = !form.canEdit || form.saving;

  return (
    <div className="space-y-6">
      <TabHead
        title={ta('tabs.knowledge')}
        description={ta('desc.knowledge')}
      />

      <SwitchRow
        title={t('strictGrounding')}
        description={t('strictGroundingDesc')}
        checked={v.strictGrounding}
        onCheckedChange={(x) => set('strictGrounding', x)}
        disabled={disabled || !v.isActive}
      />

      <AiKnowledgeCard
        accountId={form.accountId}
        canEdit={form.canEdit}
        hasEmbeddingsKey={
          v.embeddingsKeyEdited
            ? v.embeddingsKey.trim().length > 0
            : form.hasStoredEmbeddingsKey
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('embeddingsKey')}</CardTitle>
          <CardDescription>{t('optionalSemanticSearch')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Input
              id="ai-embeddings-key"
              aria-label={t('embeddingsKey')}
              type="password"
              value={v.embeddingsKey}
              onChange={(e) => {
                set('embeddingsKey', e.target.value);
                set('embeddingsKeyEdited', true);
              }}
              onFocus={() => {
                if (!v.embeddingsKeyEdited && form.hasStoredEmbeddingsKey) {
                  set('embeddingsKey', '');
                  set('embeddingsKeyEdited', true);
                }
              }}
              placeholder="sk-... (OpenAI)"
              disabled={disabled}
              autoComplete="off"
            />
            <p className="text-muted-foreground text-xs">
              {t('embeddingsHint', {
                sameKeyText: v.provider === 'openai' ? t('sameKeyText') : '',
              })}
            </p>
          </div>

          <AdvancedSection>
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="ai-threshold">{t('retrievalThreshold')}</Label>
                <p className="text-muted-foreground text-xs">
                  {t('retrievalThresholdDesc')} {ta('needsEmbeddingsKey')}
                </p>
              </div>
              <Input
                id="ai-threshold"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={v.retrievalMinScore}
                onChange={(e) => set('retrievalMinScore', e.target.value)}
                placeholder={t('retrievalThresholdOff')}
                disabled={disabled || !v.autoReplyEnabled}
                className="w-24"
              />
            </div>
          </AdvancedSection>
        </CardContent>
      </Card>

      <AiKnowledgeGapsCard accountId={form.accountId} canEdit={form.canEdit} />
    </div>
  );
}

/** The guardrail's "rewrite once" switch, mounted in the safety panel. */
export function GuardrailRetryRow({ form }: { form: AiConfigForm }) {
  const t = useTranslations('Settings.aiConfig');
  return (
    <SwitchRow
      title={t('guardrailRetry')}
      description={t('guardrailRetryDesc')}
      checked={form.values.guardrailRetry}
      onCheckedChange={(x) => form.set('guardrailRetry', x)}
      disabled={!form.canEdit || form.saving}
    />
  );
}
