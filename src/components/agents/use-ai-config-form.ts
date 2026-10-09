'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { AI_AUTO_REPLY_LIVE_CACHE_PREFIX } from '@/hooks/use-ai-auto-reply-live';
import { invalidateCached } from '@/lib/client-cache';
import { canEditSettings } from '@/lib/auth/roles';
import { fetchAccountMembers } from '@/lib/account/members';
import {
  AI_PROVIDER_DEFAULT_MODEL,
  AI_TIER_DEFAULT_MODELS,
} from '@/lib/ai/defaults';
import {
  aiConfigFormFromResponse,
  emptyAiConfigForm,
  isAiConfigFormDirty,
  type AiConfigFormValues,
} from '@/lib/ai/config-form';
import type { AiProvider } from '@/lib/ai/types';
import type { AccountMember } from '@/types';

/** A connected number, as GET /api/whatsapp/routes lists it. */
export interface ReplyNumber {
  id: string;
  name: string;
  isPrimary: boolean;
}

// A tier field holds a provider default (or nothing) unless the admin
// typed their own model, so only then does a provider switch keep it.
function isDefaultTierModel(value: string, tier: 'small' | 'large'): boolean {
  return (
    value.trim() === '' ||
    value === AI_TIER_DEFAULT_MODELS.openai[tier] ||
    value === AI_TIER_DEFAULT_MODELS.anthropic[tier]
  );
}

/**
 * The AI-config form behind the AI Agents tabs: one state, loaded once
 * per account, so switching tabs keeps unsaved edits; one Save (the
 * page's save bar). Also owns the `ai_reply` route, which the Auto-reply
 * tab's "Reply on" edits together with `reply_on_all_numbers`; it is
 * written through PUT /api/whatsapp/routes, which leaves every other
 * surface alone.
 */
export function useAiConfigForm() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.aiConfig');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [hasStoredEmbeddingsKey, setHasStoredEmbeddingsKey] = useState(false);
  const [loaded, setLoaded] = useState<AiConfigFormValues>(emptyAiConfigForm);
  const [values, setValues] = useState<AiConfigFormValues>(emptyAiConfigForm);
  const [members, setMembers] = useState<AccountMember[]>([]);
  // The `ai_reply` route: null = the default number.
  const [numbers, setNumbers] = useState<ReplyNumber[]>([]);
  const [loadedRoute, setLoadedRoute] = useState<string | null>(null);
  const [aiReplyRoute, setAiReplyRoute] = useState<string | null>(null);

  // Keyed on the account so an in-place account switch refetches.
  const loadedAccountIdRef = useRef<string | null>(null);

  const set = useCallback(
    <K extends keyof AiConfigFormValues>(
      field: K,
      value: AiConfigFormValues[K]
    ) => setValues((v) => ({ ...v, [field]: value })),
    []
  );

  const fetchRoutes = useCallback(async () => {
    // Best-effort: without it "Only on" offers just the default number.
    try {
      const res = await fetch('/api/whatsapp/routes');
      if (!res.ok) return;
      const data = await res.json();
      const list: ReplyNumber[] = (data.channels ?? []).map(
        (c: {
          id: string;
          label: string | null;
          waba_id: string | null;
          phone_number_id: string;
          is_primary: boolean;
        }) => ({
          id: c.id,
          name: c.label || c.waba_id || c.phone_number_id,
          isPrimary: c.is_primary,
        })
      );
      const row = (data.routes ?? []).find(
        (r: { surface: string }) => r.surface === 'ai_reply'
      );
      setNumbers(list);
      setLoadedRoute(row?.config_id ?? null);
      setAiReplyRoute(row?.config_id ?? null);
    } catch {
      // No picker.
    }
  }, []);

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
        const next = aiConfigFormFromResponse(data);
        setConfigured(true);
        setHasStoredKey(Boolean(data.has_key));
        setHasStoredEmbeddingsKey(Boolean(data.has_embeddings_key));
        setLoaded(next);
        setValues(next);
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
    void fetchRoutes();
    void fetchAccountMembers().then(setMembers);
  }, [accountId, fetchConfig, fetchRoutes]);

  // Swap the model defaults when the provider changes, unless the user
  // typed a custom model.
  const changeProvider = (next: AiProvider) =>
    setValues((v) => {
      const isDefaultModel =
        v.model === AI_PROVIDER_DEFAULT_MODEL.openai ||
        v.model === AI_PROVIDER_DEFAULT_MODEL.anthropic ||
        v.model.trim() === '';
      return {
        ...v,
        provider: next,
        model: isDefaultModel ? AI_PROVIDER_DEFAULT_MODEL[next] : v.model,
        modelSmall: isDefaultTierModel(v.modelSmall, 'small')
          ? AI_TIER_DEFAULT_MODELS[next].small
          : v.modelSmall,
        modelLarge: isDefaultTierModel(v.modelLarge, 'large')
          ? AI_TIER_DEFAULT_MODELS[next].large
          : v.modelLarge,
      };
    });

  const keyPayload = () =>
    values.keyEdited ? values.apiKey.trim() : undefined;

  const buildBody = () => ({
    provider: values.provider,
    model: values.model.trim(),
    api_key: keyPayload(),
    // undefined = leave unchanged; '' typed = null (clear); text = set.
    embeddings_api_key: values.embeddingsKeyEdited
      ? values.embeddingsKey.trim() || null
      : undefined,
    system_prompt: values.systemPrompt.trim() || null,
    is_active: values.isActive,
    auto_reply_enabled: values.autoReplyEnabled,
    auto_reply_campaign_only: values.autoReplyCampaignOnly,
    auto_reply_max_per_conversation: values.maxPerConversation,
    handoff_agent_id: values.handoffAgentId || null,
    escalation_keywords: values.escalationKeywords,
    retrieval_min_score:
      values.retrievalMinScore.trim() === ''
        ? null
        : Number(values.retrievalMinScore),
    strict_grounding: values.strictGrounding,
    handoff_message: values.handoffMessage.trim() || null,
    model_small: values.modelSmall.trim() || null,
    model_large: values.modelLarge.trim() || null,
    model_routing: values.modelRouting,
    pause_on_agent_reply: values.pauseOnAgentReply,
    reply_on_all_numbers: values.replyOnAllNumbers,
    auto_resume_minutes: values.autoResumeMinutes,
    guardrail_retry: values.guardrailRetry,
  });

  const routeDirty = aiReplyRoute !== loadedRoute;
  const dirty = isAiConfigFormDirty(loaded, values) || routeDirty;

  const test = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: values.provider,
          model: values.model.trim(),
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

  const save = async () => {
    if (!values.model.trim()) {
      toast.error(t('missingModel'));
      return;
    }
    if (values.retrievalMinScore.trim() !== '') {
      const n = Number(values.retrievalMinScore);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        toast.error(t('invalidThreshold'));
        return;
      }
    }
    if (!configured && !values.keyEdited) {
      toast.error(t('missingApiKey'));
      return;
    }
    setSaving(true);
    try {
      if (isAiConfigFormDirty(loaded, values) || !configured) {
        const res = await fetch('/api/ai/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildBody()),
        });
        const data = await res.json();
        if (!res.ok) {
          toast.error(data.error ?? t('saveFailed'));
          return;
        }
      }
      if (routeDirty) {
        // Only the ai_reply surface: the PUT leaves absent ones alone.
        const res = await fetch('/api/whatsapp/routes', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ routes: { ai_reply: aiReplyRoute } }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? t('saveFailed'));
          return;
        }
        setLoadedRoute(aiReplyRoute);
      }
      toast.success(t('saveSuccess'));
      // The bot's switch decides which list campaign chats are in.
      invalidateCached(AI_AUTO_REPLY_LIVE_CACHE_PREFIX);
      await fetchConfig();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setValues(loaded);
    setAiReplyRoute(loadedRoute);
  };

  const remove = async () => {
    setRemoving(true);
    try {
      const res = await fetch('/api/ai/config', { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        invalidateCached(AI_AUTO_REPLY_LIVE_CACHE_PREFIX);
        const blank = emptyAiConfigForm(values.provider);
        setConfigured(false);
        setHasStoredKey(false);
        setHasStoredEmbeddingsKey(false);
        setLoaded(blank);
        setValues(blank);
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

  return {
    accountId,
    canEdit,
    loading: loading || profileLoading,
    saving,
    testing,
    removing,
    configured,
    hasStoredKey,
    hasStoredEmbeddingsKey,
    values,
    set,
    changeProvider,
    members,
    numbers,
    aiReplyRoute,
    setAiReplyRoute,
    dirty,
    test,
    save,
    discard,
    remove,
  };
}

export type AiConfigForm = ReturnType<typeof useAiConfigForm>;
