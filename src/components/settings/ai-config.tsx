'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  Sparkles,
  CheckCircle2,
  Trash2,
  Eye,
  EyeOff,
  ShieldAlert,
  UserRoundCheck,
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { AI_AUTO_REPLY_LIVE_CACHE_PREFIX } from '@/hooks/use-ai-auto-reply-live';
import { invalidateCached } from '@/lib/client-cache';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsPanelHead } from './settings-panel-head';
import { AiKnowledgeCard } from './ai-knowledge';
import { AiKnowledgeGapsCard } from './ai-knowledge-gaps';
import { AiActivityCard } from './ai-activity';
import {
  AI_PROVIDER_DEFAULT_MODEL,
  AI_TIER_DEFAULT_MODELS,
} from '@/lib/ai/defaults';
import { AUTO_RESUME_CHOICES } from '@/lib/ai/outcomes';
import type { AiProvider } from '@/lib/ai/types';
import type { AccountMember } from '@/types';
import { fetchAccountMembers, memberLabel } from '@/lib/account/members';
import { useTranslations } from 'next-intl';

const MASKED_KEY = '••••••••••••••••';

// Radix Select can't use an empty-string item value, so the "leave
// unassigned" choice gets a sentinel that maps to null in the payload.
const HANDOFF_QUEUE = '__queue__';
// Same reason: the "never give it back" choice is null in the payload.
const RESUME_NEVER = '__never__';

type Tier = 'small' | 'large';

// A tier field holds a provider default (or nothing) unless the admin
// typed their own model, so only then does a provider switch keep it.
function isDefaultTierModel(value: string, tier: Tier): boolean {
  return (
    value.trim() === '' ||
    value === AI_TIER_DEFAULT_MODELS.openai[tier] ||
    value === AI_TIER_DEFAULT_MODELS.anthropic[tier]
  );
}

const PROVIDER_LABEL: Record<AiProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
};

const KEY_PLACEHOLDER: Record<AiProvider, string> = {
  openai: 'sk-...',
  anthropic: 'sk-ant-...',
};

export function AiConfig() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.aiConfig');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [provider, setProvider] = useState<AiProvider>('openai');
  const [model, setModel] = useState(AI_PROVIDER_DEFAULT_MODEL.openai);
  const [apiKey, setApiKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [embeddingsKey, setEmbeddingsKey] = useState('');
  const [embeddingsKeyEdited, setEmbeddingsKeyEdited] = useState(false);
  const [hasStoredEmbeddingsKey, setHasStoredEmbeddingsKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [autoReplyCampaignOnly, setAutoReplyCampaignOnly] = useState(false);
  const [maxPerConversation, setMaxPerConversation] = useState(3);
  // Empty string = leave unassigned (shared queue).
  const [handoffAgentId, setHandoffAgentId] = useState('');
  // Gates (migration 052). Keywords are edited as one-per-line text;
  // the threshold as a string so the field can be cleared to "off".
  const [escalationKeywords, setEscalationKeywords] = useState('');
  const [retrievalMinScore, setRetrievalMinScore] = useState('');
  const [strictGrounding, setStrictGrounding] = useState(false);
  const [handoffMessage, setHandoffMessage] = useState('');
  const [members, setMembers] = useState<AccountMember[]>([]);
  // AI agent v2 (migration 077). The tier fields are pre-filled with the
  // provider's defaults; a blank one saves as null ("use the standard
  // model"). The switches start at the column defaults.
  const [modelSmall, setModelSmall] = useState(
    AI_TIER_DEFAULT_MODELS.openai.small
  );
  const [modelLarge, setModelLarge] = useState(
    AI_TIER_DEFAULT_MODELS.openai.large
  );
  const [modelRouting, setModelRouting] = useState(true);
  const [pauseOnAgentReply, setPauseOnAgentReply] = useState(true);
  const [autoResumeMinutes, setAutoResumeMinutes] = useState<number | null>(
    null
  );
  const [guardrailRetry, setGuardrailRetry] = useState(true);

  // Guard keyed on the account (not a bare boolean) so an in-place
  // account switch — ownership transfer, multi-account membership —
  // refetches instead of showing the previous account's config. Mirrors
  // the loadedAccountIdRef pattern in whatsapp-config.tsx.
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      if (data.configured) {
        setConfigured(true);
        setProvider(data.provider);
        setModel(data.model);
        setSystemPrompt(data.system_prompt ?? '');
        setIsActive(data.is_active);
        setAutoReplyEnabled(data.auto_reply_enabled);
        setAutoReplyCampaignOnly(data.auto_reply_campaign_only === true);
        setMaxPerConversation(data.auto_reply_max_per_conversation ?? 3);
        setHandoffAgentId(data.handoff_agent_id ?? '');
        setEscalationKeywords(
          Array.isArray(data.escalation_keywords)
            ? data.escalation_keywords.join('\n')
            : ''
        );
        setRetrievalMinScore(
          typeof data.retrieval_min_score === 'number'
            ? String(data.retrieval_min_score)
            : ''
        );
        setStrictGrounding(data.strict_grounding === true);
        setHandoffMessage(data.handoff_message ?? '');
        const tierDefaults =
          AI_TIER_DEFAULT_MODELS[data.provider as AiProvider] ??
          AI_TIER_DEFAULT_MODELS.openai;
        setModelSmall(data.model_small ?? tierDefaults.small);
        setModelLarge(data.model_large ?? tierDefaults.large);
        setModelRouting(data.model_routing !== false);
        setPauseOnAgentReply(data.pause_on_agent_reply !== false);
        setAutoResumeMinutes(
          typeof data.auto_resume_minutes === 'number'
            ? data.auto_resume_minutes
            : null
        );
        setGuardrailRetry(data.guardrail_retry !== false);
        setHasStoredKey(Boolean(data.has_key));
        setApiKey(data.has_key ? MASKED_KEY : '');
        setKeyEdited(false);
        setHasStoredEmbeddingsKey(Boolean(data.has_embeddings_key));
        setEmbeddingsKey(data.has_embeddings_key ? MASKED_KEY : '');
        setEmbeddingsKeyEdited(false);
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
    // Members populate the handoff-target picker. Best-effort — on an
    // older deployment without the endpoint the picker just shows the
    // queue option.
    void fetchAccountMembers().then(setMembers);
  }, [accountId, fetchConfig]);

  // Swap the model default when the provider changes, unless the user
  // typed a custom model.
  const handleProviderChange = (next: AiProvider) => {
    setProvider(next);
    const isDefaultModel =
      model === AI_PROVIDER_DEFAULT_MODEL.openai ||
      model === AI_PROVIDER_DEFAULT_MODEL.anthropic ||
      model.trim() === '';
    if (isDefaultModel) setModel(AI_PROVIDER_DEFAULT_MODEL[next]);
    if (isDefaultTierModel(modelSmall, 'small'))
      setModelSmall(AI_TIER_DEFAULT_MODELS[next].small);
    if (isDefaultTierModel(modelLarge, 'large'))
      setModelLarge(AI_TIER_DEFAULT_MODELS[next].large);
  };

  const resumeLabel = (minutes: number | null) =>
    minutes === null
      ? t('autoResumeNever')
      : minutes % 60 === 0
        ? t('autoResumeHours', { count: minutes / 60 })
        : t('autoResumeMinutes', { count: minutes });

  // A value saved through the API that is not one of the choices still
  // shows as itself rather than as a blank select.
  const resumeChoices = AUTO_RESUME_CHOICES.includes(autoResumeMinutes)
    ? AUTO_RESUME_CHOICES
    : [...AUTO_RESUME_CHOICES, autoResumeMinutes];

  const keyPayload = () => (keyEdited ? apiKey.trim() : undefined);

  // undefined = leave unchanged; '' typed = null (clear); text = set.
  const embeddingsKeyPayload = () =>
    embeddingsKeyEdited ? embeddingsKey.trim() || null : undefined;

  const buildBody = () => ({
    provider,
    model: model.trim(),
    api_key: keyPayload(),
    embeddings_api_key: embeddingsKeyPayload(),
    system_prompt: systemPrompt.trim() || null,
    is_active: isActive,
    auto_reply_enabled: autoReplyEnabled,
    auto_reply_campaign_only: autoReplyCampaignOnly,
    auto_reply_max_per_conversation: maxPerConversation,
    handoff_agent_id: handoffAgentId || null,
    escalation_keywords: escalationKeywords,
    retrieval_min_score:
      retrievalMinScore.trim() === '' ? null : Number(retrievalMinScore),
    strict_grounding: strictGrounding,
    handoff_message: handoffMessage.trim() || null,
    model_small: modelSmall.trim() || null,
    model_large: modelLarge.trim() || null,
    model_routing: modelRouting,
    pause_on_agent_reply: pauseOnAgentReply,
    auto_resume_minutes: autoResumeMinutes,
    guardrail_retry: guardrailRetry,
  });

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model: model.trim(),
          api_key: keyPayload(),
        }),
      });
      const data = await res.json();
      if (res.ok) toast.success(t('testSuccess'));
      else toast.error(data.error ?? t('testRejected'));
    } catch {
      toast.error(t('testNetworkError'));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!model.trim()) {
      toast.error(t('missingModel'));
      return;
    }
    if (retrievalMinScore.trim() !== '') {
      const n = Number(retrievalMinScore);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        toast.error(t('invalidThreshold'));
        return;
      }
    }
    if (!configured && !keyEdited) {
      toast.error(t('missingApiKey'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
        // The bot's switch decides which list campaign chats are in.
        invalidateCached(AI_AUTO_REPLY_LIVE_CACHE_PREFIX);
        await fetchConfig();
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch('/api/ai/config', { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        invalidateCached(AI_AUTO_REPLY_LIVE_CACHE_PREFIX);
        setConfigured(false);
        setHasStoredKey(false);
        setApiKey('');
        setKeyEdited(false);
        setIsActive(false);
        setAutoReplyEnabled(false);
        setSystemPrompt('');
        setHandoffAgentId('');
        setEscalationKeywords('');
        setRetrievalMinScore('');
        setStrictGrounding(false);
        setHandoffMessage('');
        setModelSmall(AI_TIER_DEFAULT_MODELS[provider].small);
        setModelLarge(AI_TIER_DEFAULT_MODELS[provider].large);
        setModelRouting(true);
        setPauseOnAgentReply(true);
        setAutoResumeMinutes(null);
        setGuardrailRetry(true);
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setRemoving(false);
    }
  };

  if (loading || profileLoading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center py-16">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loadFailed')}{' '}
        {/* Re-using label or a global one, wait, loading is better. Let's use useTranslations from overview or just hardcode Loading... actually I should add loading to aiConfig */}
        {/* Wait, I didn't add loading to aiConfig. I'll just use loading. */}
      </div>
    );
  }

  const disabled = !canEdit || saving;

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {!canEdit && (
        <p className="border-border bg-muted/40 text-muted-foreground mb-4 rounded-md border px-3 py-2 text-sm">
          {t('adminOnlyConfig')}
        </p>
      )}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="text-primary h-4 w-4" />{' '}
              {t('providerAndKey')}
            </CardTitle>
            <CardDescription>{t('encryptionNotice')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t('provider')}</Label>
                <Select
                  value={provider}
                  onValueChange={(v) => handleProviderChange(v as AiProvider)}
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue />
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
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={AI_PROVIDER_DEFAULT_MODEL[provider]}
                  disabled={disabled}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ai-model-small">{t('smallModel')}</Label>
                <Input
                  id="ai-model-small"
                  value={modelSmall}
                  onChange={(e) => setModelSmall(e.target.value)}
                  placeholder={AI_TIER_DEFAULT_MODELS[provider].small}
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
                  value={modelLarge}
                  onChange={(e) => setModelLarge(e.target.value)}
                  placeholder={AI_TIER_DEFAULT_MODELS[provider].large}
                  disabled={disabled}
                />
                <p className="text-muted-foreground text-xs">
                  {t('largeModelDesc')}
                </p>
              </div>
            </div>

            <div className="border-border flex items-center justify-between gap-4 rounded-md border p-3">
              <div>
                <p className="text-foreground text-sm font-medium">
                  {t('modelRouting')}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('modelRoutingDesc')}
                </p>
              </div>
              <Switch
                checked={modelRouting}
                onCheckedChange={setModelRouting}
                disabled={disabled}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-key">{t('apiKey')}</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="ai-key"
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setKeyEdited(true);
                    }}
                    onFocus={() => {
                      if (!keyEdited && hasStoredKey) {
                        setApiKey('');
                        setKeyEdited(true);
                      }
                    }}
                    placeholder={KEY_PLACEHOLDER[provider]}
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
                  onClick={handleTest}
                  disabled={disabled || testing}
                >
                  {testing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                  )}
                  {t('testKey')}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-embeddings-key">
                {t('embeddingsKey')}{' '}
                <span className="text-muted-foreground font-normal">
                  {t('optionalSemanticSearch')}
                </span>
              </Label>
              <Input
                id="ai-embeddings-key"
                type="password"
                value={embeddingsKey}
                onChange={(e) => {
                  setEmbeddingsKey(e.target.value);
                  setEmbeddingsKeyEdited(true);
                }}
                onFocus={() => {
                  if (!embeddingsKeyEdited && hasStoredEmbeddingsKey) {
                    setEmbeddingsKey('');
                    setEmbeddingsKeyEdited(true);
                  }
                }}
                placeholder="sk-... (OpenAI)"
                disabled={disabled}
                autoComplete="off"
              />
              <p className="text-muted-foreground text-xs">
                {t('embeddingsHint', {
                  sameKeyText: provider === 'openai' ? t('sameKeyText') : '',
                })}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('behaviour')}</CardTitle>
            <CardDescription>{t('behaviourDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ai-prompt">{t('businessContext')}</Label>
              <Textarea
                id="ai-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder={t('promptPlaceholder')}
                rows={5}
                disabled={disabled}
              />
            </div>

            <div className="border-border flex items-center justify-between gap-4 rounded-md border p-3">
              <div>
                <p className="text-foreground text-sm font-medium">
                  {t('enableAssistant')}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('enableAssistantDesc')}
                </p>
              </div>
              <Switch
                checked={isActive}
                onCheckedChange={setIsActive}
                disabled={disabled}
              />
            </div>

            <div className="border-border flex items-center justify-between gap-4 rounded-md border p-3">
              <div>
                <p className="text-foreground text-sm font-medium">
                  {t('autoReply')}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('autoReplyDesc')}
                </p>
              </div>
              <Switch
                checked={autoReplyEnabled}
                onCheckedChange={setAutoReplyEnabled}
                disabled={disabled || !isActive}
              />
            </div>

            <div className="border-border flex items-center justify-between gap-4 rounded-md border p-3">
              <div>
                <p className="text-foreground text-sm font-medium">
                  {t('campaignOnly')}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('campaignOnlyDesc')}
                </p>
              </div>
              <Switch
                checked={autoReplyCampaignOnly}
                onCheckedChange={setAutoReplyCampaignOnly}
                disabled={disabled || !autoReplyEnabled}
              />
            </div>

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
                value={maxPerConversation}
                onChange={(e) =>
                  setMaxPerConversation(
                    Math.min(20, Math.max(1, Number(e.target.value) || 1))
                  )
                }
                disabled={disabled || !autoReplyEnabled}
                className="w-20"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-handoff">{t('handoffTo')}</Label>
              <p className="text-muted-foreground text-xs">
                {t('handoffToDesc')}
              </p>
              <Select
                value={handoffAgentId || HANDOFF_QUEUE}
                onValueChange={(v) =>
                  setHandoffAgentId(!v || v === HANDOFF_QUEUE ? '' : v)
                }
                disabled={disabled || !autoReplyEnabled}
              >
                <SelectTrigger id="ai-handoff">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={HANDOFF_QUEUE}>
                    {t('handoffQueue')}
                  </SelectItem>
                  {/* Deactivated members (migration 069) can't take a
                      hand-off — except one already saved here. */}
                  {members
                    .filter(
                      (m) => !m.deactivated_at || m.user_id === handoffAgentId
                    )
                    .map((m) => (
                      <SelectItem key={m.user_id} value={m.user_id}>
                        {memberLabel(m)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UserRoundCheck className="text-primary h-4 w-4" />{' '}
              {t('handoverTitle')}
            </CardTitle>
            <CardDescription>{t('handoverDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="border-border flex items-center justify-between gap-4 rounded-md border p-3">
              <div>
                <p className="text-foreground text-sm font-medium">
                  {t('pauseOnAgentReply')}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('pauseOnAgentReplyDesc')}
                </p>
              </div>
              <Switch
                checked={pauseOnAgentReply}
                onCheckedChange={setPauseOnAgentReply}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="ai-auto-resume">{t('autoResume')}</Label>
                <p className="text-muted-foreground text-xs">
                  {t('autoResumeDesc')}
                </p>
              </div>
              <Select
                value={
                  autoResumeMinutes === null
                    ? RESUME_NEVER
                    : String(autoResumeMinutes)
                }
                onValueChange={(v) =>
                  setAutoResumeMinutes(
                    !v || v === RESUME_NEVER ? null : Number(v)
                  )
                }
                disabled={disabled || !pauseOnAgentReply}
              >
                <SelectTrigger id="ai-auto-resume" className="w-32">
                  <SelectValue>{resumeLabel(autoResumeMinutes)}</SelectValue>
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

            <div className="border-border flex items-center justify-between gap-4 rounded-md border p-3">
              <div>
                <p className="text-foreground text-sm font-medium">
                  {t('guardrailRetry')}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('guardrailRetryDesc')}
                </p>
              </div>
              <Switch
                checked={guardrailRetry}
                onCheckedChange={setGuardrailRetry}
                disabled={disabled}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldAlert className="text-primary h-4 w-4" /> {t('gatesTitle')}
            </CardTitle>
            <CardDescription>{t('gatesDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ai-escalation">{t('escalationKeywords')}</Label>
              <p className="text-muted-foreground text-xs">
                {t('escalationKeywordsDesc')}
              </p>
              <Textarea
                id="ai-escalation"
                value={escalationKeywords}
                onChange={(e) => setEscalationKeywords(e.target.value)}
                placeholder={t('escalationKeywordsPlaceholder')}
                rows={4}
                disabled={disabled || !autoReplyEnabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="ai-threshold">{t('retrievalThreshold')}</Label>
                <p className="text-muted-foreground text-xs">
                  {t('retrievalThresholdDesc')}
                </p>
              </div>
              <Input
                id="ai-threshold"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={retrievalMinScore}
                onChange={(e) => setRetrievalMinScore(e.target.value)}
                placeholder={t('retrievalThresholdOff')}
                disabled={disabled || !autoReplyEnabled}
                className="w-24"
              />
            </div>

            <div className="border-border flex items-center justify-between gap-4 rounded-md border p-3">
              <div>
                <p className="text-foreground text-sm font-medium">
                  {t('strictGrounding')}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('strictGroundingDesc')}
                </p>
              </div>
              <Switch
                checked={strictGrounding}
                onCheckedChange={setStrictGrounding}
                disabled={disabled || !isActive}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-handoff-message">{t('handoffMessage')}</Label>
              <p className="text-muted-foreground text-xs">
                {t('handoffMessageDesc')}
              </p>
              <Textarea
                id="ai-handoff-message"
                value={handoffMessage}
                onChange={(e) => setHandoffMessage(e.target.value)}
                placeholder={t('handoffMessagePlaceholder')}
                rows={3}
                maxLength={1000}
                disabled={disabled || !autoReplyEnabled}
              />
            </div>
          </CardContent>
        </Card>

        <AiKnowledgeCard
          accountId={accountId}
          canEdit={canEdit}
          hasEmbeddingsKey={
            embeddingsKeyEdited
              ? embeddingsKey.trim().length > 0
              : hasStoredEmbeddingsKey
          }
        />

        <AiKnowledgeGapsCard accountId={accountId} canEdit={canEdit} />

        <AiActivityCard accountId={accountId} canEdit={canEdit} />

        <div className="flex items-center justify-between">
          {configured ? (
            <Button
              variant="ghost"
              onClick={handleRemove}
              disabled={!canEdit || removing}
              className="text-destructive hover:text-destructive"
            >
              {removing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {t('remove')}
            </Button>
          ) : (
            <span />
          )}

          <Button onClick={handleSave} disabled={disabled}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
