-- ============================================================
-- 207: New chat notice.
--
-- A standing instruction shown to everyone in a workspace when they
-- are about to start a new chat: "new clients you are only sending
-- details to go from the marketing number". An admin picks which
-- number is the marketing number and may reword the notice.
--
--   1. team_activity_new_chat_notice: one row per workspace. No row
--      means "on, no number, default wording". notice_text NULL means
--      the app's built-in wording.
--   2. The marketing number is a same-account composite FK (062's
--      rule), ON DELETE SET NULL (marketing_channel_id): the column
--      list keeps account_id, as in 075. A trigger refuses a personal
--      number (190) and stamps updated_at / updated_by.
--   3. RLS: members of the active account read; admins and owners of
--      the active account insert and update; nobody deletes.
--   4. team_activity_new_chat_notice(): what the composer shows, for
--      the caller's active account, in one round trip (the number's
--      label and phone included, which an agent's RLS may not show).
--
-- Deliberately NOT a column of team_activity_settings: creating that
-- row counts as "limits saved", which turns on 204's quiet hours in
-- the default UTC zone. Saving a notice must not start blocking sends.
--
-- Re-runnable. Apply after 206.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The table.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_activity_new_chat_notice (
  account_id           uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled              boolean NOT NULL DEFAULT true,
  marketing_channel_id uuid,
  notice_text          text,
  -- auth user id of the last writer (auth.uid(), NULL for the service role).
  updated_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'team_activity_new_chat_notice_text_check'
       AND conrelid = 'public.team_activity_new_chat_notice'::regclass
  ) THEN
    ALTER TABLE public.team_activity_new_chat_notice
      ADD CONSTRAINT team_activity_new_chat_notice_text_check
      CHECK (notice_text IS NULL
             OR (char_length(notice_text) BETWEEN 1 AND 300
                 AND notice_text !~ '^[[:space:]]*$'));
  END IF;
  -- The column list on SET NULL is load-bearing: a bare SET NULL
  -- would null account_id (the primary key) as well.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'team_activity_new_chat_notice_channel_fkey'
       AND conrelid = 'public.team_activity_new_chat_notice'::regclass
  ) THEN
    ALTER TABLE public.team_activity_new_chat_notice
      ADD CONSTRAINT team_activity_new_chat_notice_channel_fkey
      FOREIGN KEY (marketing_channel_id, account_id)
      REFERENCES public.whatsapp_config (id, account_id)
      ON DELETE SET NULL (marketing_channel_id);
  END IF;
END $$;

-- Deleting a number scans this.
CREATE INDEX IF NOT EXISTS idx_team_activity_new_chat_notice_channel
  ON public.team_activity_new_chat_notice (marketing_channel_id)
  WHERE marketing_channel_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2. Guard: never a personal number; stamp the writer.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_activity_new_chat_notice_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.marketing_channel_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.whatsapp_config c
                  WHERE c.id = NEW.marketing_channel_id
                    AND c.is_personal) THEN
    RAISE EXCEPTION 'A personal number cannot be the marketing number'
      USING ERRCODE = '22023', HINT = 'personal_number';
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.team_activity_new_chat_notice_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS team_activity_new_chat_notice_guard ON public.team_activity_new_chat_notice;
CREATE TRIGGER team_activity_new_chat_notice_guard
  BEFORE INSERT OR UPDATE ON public.team_activity_new_chat_notice
  FOR EACH ROW EXECUTE FUNCTION public.team_activity_new_chat_notice_guard();

-- ------------------------------------------------------------
-- 3. RLS and grants. No DELETE: switching it off is enabled = false.
-- ------------------------------------------------------------
ALTER TABLE public.team_activity_new_chat_notice ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.team_activity_new_chat_notice FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.team_activity_new_chat_notice TO authenticated;
GRANT SELECT ON public.team_activity_new_chat_notice TO service_role;

DROP POLICY IF EXISTS team_activity_new_chat_notice_read ON public.team_activity_new_chat_notice;
CREATE POLICY team_activity_new_chat_notice_read ON public.team_activity_new_chat_notice
  FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id()));

DROP POLICY IF EXISTS team_activity_new_chat_notice_insert ON public.team_activity_new_chat_notice;
CREATE POLICY team_activity_new_chat_notice_insert ON public.team_activity_new_chat_notice
  FOR INSERT TO authenticated
  WITH CHECK (account_id = (SELECT public.current_account_id())
              AND (SELECT public.current_role_rank()) >= 4);

DROP POLICY IF EXISTS team_activity_new_chat_notice_update ON public.team_activity_new_chat_notice;
CREATE POLICY team_activity_new_chat_notice_update ON public.team_activity_new_chat_notice
  FOR UPDATE TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND (SELECT public.current_role_rank()) >= 4)
  WITH CHECK (account_id = (SELECT public.current_account_id())
              AND (SELECT public.current_role_rank()) >= 4);

-- ------------------------------------------------------------
-- 4. What the composer shows.
--
-- {enabled, channel_id, channel_label, channel_phone,
--  channel_provider, text}. No row: enabled true, the rest NULL. A
-- number that was deleted (the FK nulled it) or is personal reads as
-- no number. channel_phone is waba_id, which is the display phone on
-- linked-device rows (Whapi, OpenWA) but the WABA id on Meta, so it is
-- NULL there. No active account (a bank guest): {enabled: false}.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_activity_new_chat_notice()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct uuid := public.current_account_id();
  v_row  public.team_activity_new_chat_notice%ROWTYPE;
  v_ch   public.whatsapp_config%ROWTYPE;
BEGIN
  IF v_acct IS NULL THEN
    RETURN jsonb_build_object('enabled', false);
  END IF;

  SELECT * INTO v_row
    FROM public.team_activity_new_chat_notice n
   WHERE n.account_id = v_acct;

  IF v_row.marketing_channel_id IS NOT NULL THEN
    SELECT * INTO v_ch
      FROM public.whatsapp_config c
     WHERE c.id = v_row.marketing_channel_id
       AND c.account_id = v_acct
       AND NOT c.is_personal;
  END IF;

  RETURN jsonb_build_object(
    'enabled',          coalesce(v_row.enabled, true),
    'channel_id',       v_ch.id,
    'channel_label',    v_ch.label,
    'channel_phone',    CASE WHEN v_ch.provider = 'meta' THEN NULL ELSE v_ch.waba_id END,
    'channel_provider', v_ch.provider,
    'text',             v_row.notice_text
  );
END;
$$;

REVOKE ALL ON FUNCTION public.team_activity_new_chat_notice() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.team_activity_new_chat_notice() TO authenticated;
