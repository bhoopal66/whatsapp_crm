-- ============================================================
-- 323: the in-chat AI assistant (inbox side panel)
--
-- The first caller of 019a's assistant safety layer (migration 120):
-- an Assistant panel on an open chat summarises it, drafts a reply into
-- the composer, answers a question about it, and proposes actions (a
-- chat tag, a follow-up task, an assignment, an internal note) that a
-- person confirms one by one through assist_pending_* before anything
-- changes. The assistant never sends to a customer.
--
--   1. inbox_assistant_settings: the per-workspace switch, OFF by default
--      (no row = off). Members of the workspace read it (the panel
--      shows only while it is on); only inbox_assistant_set_enabled()
--      writes it, as an admin+ of the caller's ACTIVE account.
--   2. ai_usage_log_mode_check gains 'chat_assist'. The whole list is
--      restated: 290's list (auto_reply, draft, translate, hr_agent,
--      kb_learn) plus 'chat_assist'. LogAiUsageArgs.mode and the usage
--      route's byMode change with it.
--
-- No RLS-forced table is touched: the pending actions and the audit
-- stay 120's, reached by the app on the service role. The writes the
-- assistant proposes run on the CALLER's client under the existing
-- policies (conversations, tasks, conversation_notes), so the panel
-- never widens what a person may do.
--
-- Re-runnable: IF NOT EXISTS, CREATE OR REPLACE, DROP POLICY IF EXISTS,
-- and the CHECK is rebuilt from a fixed list. Apply after 290; a
-- re-run of 154, 202 or 290 afterwards drops 'chat_assist' again, so
-- apply in order, once (re-running 323 itself is safe). The refusal
-- comes before the first DDL and turns the session read-only.
-- Asserted by supabase/ci/verify-chat-assist.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$
DECLARE
  v_refusal text := '';
BEGIN
  IF to_regprocedure('public.is_account_member(uuid, account_role_enum)') IS NULL THEN
    v_refusal := '323: is_account_member() is missing; apply the earlier migrations first';
  ELSIF (SELECT count(*) FROM pg_constraint
          WHERE conrelid = 'public.ai_usage_log'::regclass
            AND conname = 'ai_usage_log_mode_check' AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%kb_learn%') <> 1 THEN
    v_refusal := '323: ai_usage_log_mode_check is not the list 290 leaves; apply 290_kb_learn.sql first';
  ELSIF EXISTS (SELECT 1 FROM public.ai_usage_log
                 WHERE mode NOT IN ('auto_reply', 'draft', 'translate', 'hr_agent', 'kb_learn', 'chat_assist')) THEN
    v_refusal := '323: ai_usage_log holds a mode this list does not name; look at it first';
  END IF;
  PERFORM set_config('ca323.refusal', v_refusal, false);
  IF v_refusal <> '' THEN
    PERFORM set_config('default_transaction_read_only', 'on', false);
  END IF;
END $$;

DO $$ BEGIN
  IF coalesce(current_setting('ca323.refusal', true), '') <> '' THEN
    RAISE EXCEPTION '%', current_setting('ca323.refusal');
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Usage log mode: the whole list, restated
-- ------------------------------------------------------------
-- One statement, so the table is never without the CHECK. NOT VALID,
-- then VALIDATE (no long lock).
ALTER TABLE public.ai_usage_log
  DROP CONSTRAINT ai_usage_log_mode_check,
  ADD CONSTRAINT ai_usage_log_mode_check
    CHECK (mode IN ('auto_reply', 'draft', 'translate', 'hr_agent', 'kb_learn', 'chat_assist')) NOT VALID;
ALTER TABLE public.ai_usage_log VALIDATE CONSTRAINT ai_usage_log_mode_check;

-- ------------------------------------------------------------
-- 2. The switch
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inbox_assistant_settings (
  account_id uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled    boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.inbox_assistant_settings IS
  'In-chat AI assistant (323): off by default, no row = off. Written only by inbox_assistant_set_enabled() (admin+ of the active account). Mirrored by CHAT_ASSIST_DEFAULT_ENABLED in src/lib/chat-assist/gate.ts.';

ALTER TABLE public.inbox_assistant_settings ENABLE ROW LEVEL SECURITY;

-- Any member reads it (the panel's button shows only while it is on);
-- a bank guest is no member of an account (current_account_id() is
-- NULL for them) and reads nothing.
DROP POLICY IF EXISTS inbox_assistant_settings_select ON public.inbox_assistant_settings;
CREATE POLICY inbox_assistant_settings_select ON public.inbox_assistant_settings FOR SELECT
  USING (is_account_member(account_id, 'viewer'));

REVOKE ALL ON public.inbox_assistant_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.inbox_assistant_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbox_assistant_settings TO service_role;

-- The one writer: an admin+ of the caller's ACTIVE account.
CREATE OR REPLACE FUNCTION public.inbox_assistant_set_enabled(p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid := current_account_id();
  v_row     public.inbox_assistant_settings;
BEGIN
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'enabled must be true or false' USING ERRCODE = '22023';
  END IF;
  IF v_account IS NULL OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.inbox_assistant_settings AS s (account_id, enabled, updated_at, updated_by)
  VALUES (v_account, p_enabled, now(), auth.uid())
  ON CONFLICT (account_id) DO UPDATE
    SET enabled = EXCLUDED.enabled, updated_at = now(), updated_by = EXCLUDED.updated_by
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('enabled', v_row.enabled, 'updated_at', v_row.updated_at);
END $$;

REVOKE ALL ON FUNCTION public.inbox_assistant_set_enabled(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_assistant_set_enabled(boolean) TO authenticated, service_role;
