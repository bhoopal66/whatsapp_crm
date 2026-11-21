-- ============================================================
-- 223_privacy_retention.sql — PDPL retention: delete or blank old rows
-- by age, per workspace. Port of package 033j; the policy is a
-- workspace setting (owners / admins) instead of server environment,
-- and the automations cron runs the sweep daily.
--
--  * Allow-list (privacy_retention_rules(), mirrored by RETENTION_RULES
--    in src/lib/privacy/retention.ts; retention.test.ts compares them):
--      deal_room_messages       group_messages            delete | anonymise
--      whatsapp_group_messages  whatsapp_group_messages   delete | anonymise
--      hr_outbox_bodies         hr_automsg_outbox         anonymise (sent / failed / cancelled only)
--      hr_agent_drafts          hr_agent_drafts           delete (decided drafts only)
--      call_records             calls                     anonymise (no live recording)
--    Bank cases, case files, the case's WhatsApp group, consent and
--    audit tables are not on it and cannot be added by a setting.
--  * Policy {"tables": {"<key>": {"days": 30..36500, "action": …}}};
--    anything else is refused (INVALID) when it is saved.
--  * Dry run unless the workspace switched `apply` on: the sweep counts
--    and logs, changes nothing. Rows of a customer under a legal hold
--    (222) are skipped and counted as held_skipped.
--  * One privacy_requests row per sweep (system:retention, counts only).
--
-- SECURITY DEFINER, service role only; the table forces RLS with no
-- grants. Apply after 222 as a superuser or BYPASSRLS role. Re-runnable.
-- verify-privacy.sql; docs/privacy.md.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '223 must be applied by a superuser or BYPASSRLS role (the sweep writes RLS-forced tables)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.privacy_retention_settings (
  account_id uuid PRIMARY KEY REFERENCES public.accounts(id),
  policy     jsonb NOT NULL DEFAULT '{"tables": {}}'::jsonb,
  apply      boolean NOT NULL DEFAULT false,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.privacy_retention_settings IS
  'A workspace''s retention policy (allow-listed keys only) and whether the sweep applies it. Migration 223.';
ALTER TABLE public.privacy_retention_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.privacy_retention_settings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.privacy_retention_settings FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.privacy_retention_rules()
RETURNS TABLE (key text, table_name text, actions text[])
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  VALUES ('deal_room_messages', 'group_messages', ARRAY['delete', 'anonymise']),
         ('whatsapp_group_messages', 'whatsapp_group_messages', ARRAY['delete', 'anonymise']),
         ('hr_outbox_bodies', 'hr_automsg_outbox', ARRAY['anonymise']),
         ('hr_agent_drafts', 'hr_agent_drafts', ARRAY['delete']),
         ('call_records', 'calls', ARRAY['anonymise'])
$$;

-- NULL when the policy is valid, else what is wrong.
CREATE OR REPLACE FUNCTION public.privacy_retention_problem(p_policy jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  r     record;
  v_act text[];
BEGIN
  IF p_policy IS NULL OR jsonb_typeof(p_policy) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_policy) k WHERE k <> 'tables') > 0
     OR jsonb_typeof(p_policy -> 'tables') IS DISTINCT FROM 'object' THEN
    RETURN 'the policy must be {"tables": {…}}';
  END IF;
  FOR r IN SELECT k, v FROM jsonb_each(p_policy -> 'tables') AS e(k, v) LOOP
    SELECT x.actions INTO v_act FROM public.privacy_retention_rules() x WHERE x.key = r.k;
    IF v_act IS NULL THEN
      RETURN format('%s is not a retention key', r.k);
    END IF;
    IF jsonb_typeof(r.v) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(r.v) k WHERE k NOT IN ('days', 'action')) > 0 THEN
      RETURN format('%s: only days and action', r.k);
    END IF;
    IF jsonb_typeof(r.v -> 'days') <> 'number' OR (r.v ->> 'days') !~ '^[0-9]+$'
       OR (r.v ->> 'days')::numeric NOT BETWEEN 30 AND 36500 THEN
      RETURN format('%s: days must be a whole number from 30 to 36500', r.k);
    END IF;
    IF NOT (r.v ->> 'action') = ANY (v_act) THEN
      RETURN format('%s: action must be one of %s', r.k, array_to_string(v_act, ', '));
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.privacy_retention_get(p_actor uuid, p_account uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.privacy_require_admin('privacy_retention_get', p_actor, p_account);
  RETURN coalesce((SELECT jsonb_build_object('policy', s.policy, 'apply', s.apply, 'updated_at', s.updated_at)
                     FROM public.privacy_retention_settings s WHERE s.account_id = p_account),
                  jsonb_build_object('policy', '{"tables": {}}'::jsonb, 'apply', false, 'updated_at', NULL));
END;
$$;

CREATE OR REPLACE FUNCTION public.privacy_retention_set(p_actor uuid, p_account uuid, p_policy jsonb, p_apply boolean)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_problem text := public.privacy_retention_problem(p_policy);
BEGIN
  PERFORM public.privacy_require_admin('privacy_retention_set', p_actor, p_account);
  IF v_problem IS NOT NULL OR p_apply IS NULL THEN
    RAISE EXCEPTION 'privacy_retention_set: %', coalesce(v_problem, 'apply must be true or false')
      USING ERRCODE = 'check_violation', HINT = 'INVALID';
  END IF;
  INSERT INTO public.privacy_retention_settings (account_id, policy, apply, updated_by, updated_at)
  VALUES (p_account, p_policy, p_apply, p_actor, now())
  ON CONFLICT (account_id) DO UPDATE
    SET policy = excluded.policy, apply = excluded.apply, updated_by = excluded.updated_by, updated_at = now();
  RETURN public.privacy_retention_get(p_actor, p_account);
END;
$$;

-- Accounts with something to sweep (the cron's list).
CREATE OR REPLACE FUNCTION public.privacy_retention_accounts()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT s.account_id FROM public.privacy_retention_settings s
    JOIN public.accounts a ON a.id = s.account_id
   WHERE s.policy -> 'tables' <> '{}'::jsonb AND a.archived_at IS NULL
$$;

-- One sweep of one workspace. p_dry_run NULL = the workspace's setting.
CREATE OR REPLACE FUNCTION public.privacy_retention_sweep(p_account uuid, p_dry_run boolean DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  s       public.privacy_retention_settings%ROWTYPE;
  v_dry   boolean;
  r       record;
  v_cut   timestamptz;
  v_n     integer;
  v_held  integer;
  v_out   jsonb := '{}'::jsonb;
  v_id    bigint;
BEGIN
  SELECT * INTO s FROM public.privacy_retention_settings x WHERE x.account_id = p_account;
  IF NOT FOUND OR s.policy -> 'tables' = '{}'::jsonb THEN
    RETURN NULL;
  END IF;
  IF public.privacy_retention_problem(s.policy) IS NOT NULL THEN
    RAISE EXCEPTION 'privacy_retention_sweep: the stored policy is invalid' USING ERRCODE = 'check_violation', HINT = 'INVALID';
  END IF;
  v_dry := coalesce(p_dry_run, NOT s.apply);

  -- Contacts under a legal hold, and their phone digits.
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.privacy_held (contact_id uuid, digits text) ON COMMIT DROP;
  TRUNCATE pg_temp.privacy_held;
  INSERT INTO pg_temp.privacy_held
  SELECT c.id, public.privacy_digits(coalesce(c.phone_normalized, c.phone))
    FROM public.privacy_legal_holds h JOIN public.contacts c ON c.id = h.contact_id
   WHERE h.account_id = p_account AND h.released_at IS NULL;

  BEGIN
    FOR r IN SELECT k, (v ->> 'days')::integer AS days, v ->> 'action' AS action
               FROM jsonb_each(s.policy -> 'tables') AS e(k, v) ORDER BY k LOOP
      v_cut := now() - make_interval(days => r.days);
      IF r.k = 'deal_room_messages' THEN
        SELECT count(*) INTO v_held FROM public.group_messages m
          JOIN public.deal_room_participants p ON p.id = m.sender_participant_id
         WHERE m.account_id = p_account AND m.created_at < v_cut AND p.contact_id IN (SELECT contact_id FROM pg_temp.privacy_held);
        IF r.action = 'delete' THEN
          DELETE FROM public.group_messages m WHERE m.account_id = p_account AND m.created_at < v_cut
             AND NOT EXISTS (SELECT 1 FROM public.deal_room_participants p WHERE p.id = m.sender_participant_id
                              AND p.contact_id IN (SELECT contact_id FROM pg_temp.privacy_held));
        ELSE
          UPDATE public.group_messages m SET body = NULL, media = NULL, sender_wa_id = NULL
           WHERE m.account_id = p_account AND m.created_at < v_cut AND (m.body IS NOT NULL OR m.media IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM public.deal_room_participants p WHERE p.id = m.sender_participant_id
                              AND p.contact_id IN (SELECT contact_id FROM pg_temp.privacy_held));
        END IF;
      ELSIF r.k = 'whatsapp_group_messages' THEN
        SELECT count(*) INTO v_held FROM public.whatsapp_group_messages m
         WHERE m.account_id = p_account AND m.created_at < v_cut
           AND public.privacy_digits(m.sender_wa_id) IN (SELECT digits FROM pg_temp.privacy_held WHERE digits IS NOT NULL);
        IF r.action = 'delete' THEN
          DELETE FROM public.whatsapp_group_messages m WHERE m.account_id = p_account AND m.created_at < v_cut
             AND coalesce(public.privacy_digits(m.sender_wa_id), '') NOT IN (SELECT digits FROM pg_temp.privacy_held WHERE digits IS NOT NULL);
        ELSE
          UPDATE public.whatsapp_group_messages m SET body = NULL, media = NULL, sender_name = NULL
           WHERE m.account_id = p_account AND m.created_at < v_cut
             AND (m.body IS NOT NULL OR m.media IS NOT NULL OR m.sender_name IS NOT NULL)
             AND coalesce(public.privacy_digits(m.sender_wa_id), '') NOT IN (SELECT digits FROM pg_temp.privacy_held WHERE digits IS NOT NULL);
        END IF;
      ELSIF r.k = 'hr_outbox_bodies' THEN
        SELECT count(*) INTO v_held FROM public.hr_automsg_outbox o
         WHERE o.account_id = p_account AND o.created_at < v_cut AND o.status IN ('sent', 'failed', 'cancelled')
           AND o.contact_id IN (SELECT contact_id FROM pg_temp.privacy_held);
        UPDATE public.hr_automsg_outbox o SET body_rendered = '', params = '[]'::jsonb
         WHERE o.account_id = p_account AND o.created_at < v_cut AND o.status IN ('sent', 'failed', 'cancelled')
           AND o.body_rendered <> '' AND o.contact_id NOT IN (SELECT contact_id FROM pg_temp.privacy_held);
      ELSIF r.k = 'hr_agent_drafts' THEN
        SELECT count(*) INTO v_held FROM public.hr_agent_drafts d JOIN public.conversations v ON v.id = d.conversation_id
         WHERE d.account_id = p_account AND d.created_at < v_cut AND d.status <> 'pending'
           AND v.contact_id IN (SELECT contact_id FROM pg_temp.privacy_held);
        DELETE FROM public.hr_agent_drafts d USING public.conversations v
         WHERE v.id = d.conversation_id AND d.account_id = p_account AND d.created_at < v_cut AND d.status <> 'pending'
           AND v.contact_id NOT IN (SELECT contact_id FROM pg_temp.privacy_held);
      ELSIF r.k = 'call_records' THEN
        SELECT count(*) INTO v_held FROM public.calls c
         WHERE c.account_id = p_account AND c.started_at < v_cut AND c.erased_at IS NULL
           AND c.contact_id IN (SELECT contact_id FROM pg_temp.privacy_held);
        UPDATE public.calls c SET notes = NULL, disposition = NULL, notes_updated_by = NULL, notes_updated_at = NULL,
               erased_at = now()
         WHERE c.account_id = p_account AND c.started_at < v_cut AND c.erased_at IS NULL
           AND (c.contact_id IS NULL OR c.contact_id NOT IN (SELECT contact_id FROM pg_temp.privacy_held))
           AND NOT EXISTS (SELECT 1 FROM public.call_recordings rr WHERE rr.call_id = c.id AND rr.erased_at IS NULL);
      END IF;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_out := v_out || jsonb_build_object(r.k, jsonb_build_object('action', r.action, 'days', r.days,
                                                                   'rows', v_n, 'held_skipped', v_held));
    END LOOP;
    IF v_dry THEN
      RAISE EXCEPTION USING ERRCODE = 'ZP223', MESSAGE = 'privacy_retention_sweep dry run';
    END IF;
  EXCEPTION WHEN SQLSTATE 'ZP223' THEN
    NULL;
  END;

  INSERT INTO public.privacy_requests (account_id, kind, actor_label, detail)
  VALUES (p_account, CASE WHEN v_dry THEN 'retention_dry_run' ELSE 'retention' END, 'system:retention',
          jsonb_build_object('tables', v_out))
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('mode', CASE WHEN v_dry THEN 'dry_run' ELSE 'apply' END, 'request_id', v_id, 'tables', v_out);
END;
$$;

REVOKE ALL ON FUNCTION public.privacy_retention_rules(), public.privacy_retention_problem(jsonb),
  public.privacy_retention_get(uuid, uuid), public.privacy_retention_set(uuid, uuid, jsonb, boolean),
  public.privacy_retention_accounts(), public.privacy_retention_sweep(uuid, boolean)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.privacy_retention_rules(), public.privacy_retention_get(uuid, uuid),
  public.privacy_retention_set(uuid, uuid, jsonb, boolean), public.privacy_retention_accounts(),
  public.privacy_retention_sweep(uuid, boolean)
TO service_role;
