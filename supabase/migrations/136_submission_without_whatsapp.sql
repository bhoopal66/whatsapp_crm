-- ============================================================
-- 136_submission_without_whatsapp.sql — submissions without a
-- WhatsApp group (the submission app of 115 / 134).
--
-- Compass calls POST /api/v1/submission-groups when an agent submits a
-- case. Until now that always opened a Whapi WhatsApp group, and with
-- no Whapi number connected it refused the submission, so the case
-- never reached the CRM. The business wants the cases in the CRM now
-- and the groups later, so the submission_groups row becomes the CRM's
-- record of the submission, with or without a group:
--
--  * submission_groups.wa_mode: 'group' (115's behaviour, every
--    existing row) or 'none' (no WhatsApp group, ever). Fixed at
--    creation: part of the frozen identity. A 'none' row is inserted
--    with no hosting number (channel_id NULL) but still with its
--    customer contact, ACTIVE, unclaimed and without wa_group_id; it
--    can never get a create claim or a wa_group_id.
--    cases.group_id stays the "submitted" marker throughout 122–134:
--    a 'none' row is still a submission.
--  * sg_open gains p_wa_mode (DEFAULT 'group'; the old signature is
--    dropped so there is no overload). sg_claim_create and
--    sg_send_begin return NULL for a 'none' row (send_begin writes
--    nothing). sg_end works on either mode.
--  * case_account_settings.submission_whatsapp_groups (default false:
--    the groups are off until someone turns them on; the feature was
--    never live). Read by case_submission_whatsapp_groups, written only
--    by case_settings_set_whatsapp_groups (owner/admin), beside 134's
--    managed_externally pair, which is unchanged.
--
-- 125–135 read wa_group_id only in 134's webhook trigger
-- (submission_group.ready / .failed), which a 'none' row never fires:
-- it never gets a wa_group_id or a create error. No case or bank
-- dashboard function treats a missing wa_group_id as pending.
--
-- The SECURITY DEFINER functions read RLS-forced tables, so, as 115
-- and 134, this must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS, a guarded constraint,
-- CREATE OR REPLACE, DROP … IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '136 must be applied by a superuser or BYPASSRLS role (the sg_* functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. submission_groups.wa_mode ----------

ALTER TABLE public.submission_groups
  ADD COLUMN IF NOT EXISTS wa_mode text NOT NULL DEFAULT 'group';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'submission_groups_wa_mode_check'
       AND conrelid = 'public.submission_groups'::regclass
  ) THEN
    ALTER TABLE public.submission_groups
      ADD CONSTRAINT submission_groups_wa_mode_check CHECK (wa_mode IN ('group', 'none'));
  END IF;
END $$;

COMMENT ON COLUMN public.submission_groups.wa_mode IS
  'group: a WhatsApp group on a Whapi number (115); none: the CRM record of the submission only, no number and never a WhatsApp group. Fixed at creation. Migration 136.';

-- ---------- 2. The guard: 115's, with wa_mode (marked "136") ----------

CREATE OR REPLACE FUNCTION public.submission_groups_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_account  uuid;
  v_provider text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- 136: a 'none' row has no hosting number at all.
    IF NEW.wa_mode = 'none' THEN
      IF NEW.channel_id IS NOT NULL THEN
        RAISE EXCEPTION 'public.submission_groups: a submission without a WhatsApp group has no hosting number'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      SELECT w.account_id, w.provider INTO v_account, v_provider
        FROM public.whatsapp_config w WHERE w.id = NEW.channel_id;
      IF v_account IS DISTINCT FROM NEW.account_id OR v_provider IS DISTINCT FROM 'whapi' THEN
        RAISE EXCEPTION 'public.submission_groups: the hosting number must be a Whapi number of the group''s workspace'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW.contact_id IS NULL THEN
      RAISE EXCEPTION 'public.submission_groups: a group is inserted with its customer contact'
        USING ERRCODE = 'not_null_violation';
    END IF;
    IF NEW.status <> 'ACTIVE' OR NEW.wa_group_id IS NOT NULL OR NEW.wa_create_claim IS NOT NULL THEN
      RAISE EXCEPTION 'public.submission_groups: a group is inserted ACTIVE, unclaimed and without a WhatsApp group'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- The FKs' ON DELETE SET NULL: the number or the contact went away.
    -- Allowed in every status, only for a reference whose row is gone,
    -- and only when nothing else in the row changes.
    IF (NEW.channel_id IS DISTINCT FROM OLD.channel_id OR NEW.contact_id IS DISTINCT FROM OLD.contact_id)
       AND (NEW.channel_id IS NOT DISTINCT FROM OLD.channel_id
            OR (NEW.channel_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM public.whatsapp_config w WHERE w.id = OLD.channel_id)))
       AND (NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id
            OR (NEW.contact_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = OLD.contact_id)))
       AND (to_jsonb(NEW) - 'channel_id' - 'contact_id') = (to_jsonb(OLD) - 'channel_id' - 'contact_id') THEN
      RETURN NEW;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.submission_ref IS DISTINCT FROM OLD.submission_ref
       OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
       OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
       OR NEW.wa_mode IS DISTINCT FROM OLD.wa_mode THEN  -- 136
      RAISE EXCEPTION 'public.submission_groups: the group identity is fixed (id, account_id, submission_ref, contact_id, channel_id, wa_mode; UPDATE refused)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- 136: a 'none' row never gets a WhatsApp group or a create claim.
    IF OLD.wa_mode = 'none' AND (NEW.wa_group_id IS NOT NULL OR NEW.wa_create_claim IS NOT NULL) THEN
      RAISE EXCEPTION 'public.submission_groups: a submission without a WhatsApp group never gets one (UPDATE refused)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.wa_group_id IS NOT NULL AND NEW.wa_group_id IS DISTINCT FROM OLD.wa_group_id THEN
      RAISE EXCEPTION 'public.submission_groups: the WhatsApp group id is fixed once set (UPDATE refused)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- sg_attach_wa_group clears the claim in the same UPDATE; OLD still holds it.
    IF OLD.wa_group_id IS NULL AND NEW.wa_group_id IS NOT NULL
       AND (OLD.status <> 'ACTIVE' OR OLD.wa_create_claim IS NULL) THEN
      RAISE EXCEPTION 'public.submission_groups: attaching a WhatsApp group requires a create claim (UPDATE refused)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.status = 'ACTIVE' THEN
      RETURN NEW;
    END IF;
    -- ENDED: only the close bookkeeping, and only until the close is recorded.
    IF OLD.wa_closed_at IS NULL
       AND (to_jsonb(NEW) - 'wa_closed_at' - 'wa_close_error') = (to_jsonb(OLD) - 'wa_closed_at' - 'wa_close_error') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'public.submission_groups: % refused (groups are archived, never changed after ENDED or deleted)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- ---------- 3. The store contract ----------

-- 115's sg_open plus p_wa_mode. Dropped first so the 8-argument
-- signature does not survive as an overload.
DROP FUNCTION IF EXISTS public.sg_open(uuid, text, uuid, uuid, text, text, jsonb, uuid);

CREATE OR REPLACE FUNCTION public.sg_open(p_account uuid, p_submission_ref text, p_contact uuid,
  p_channel uuid, p_subject text, p_coordinator_phone text, p_access jsonb, p_key uuid,
  p_wa_mode text DEFAULT 'group')
RETURNS TABLE (group_id uuid, created boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.submission_groups
    (account_id, submission_ref, contact_id, channel_id, subject, coordinator_phone, created_by_key, wa_mode)
  VALUES (p_account, p_submission_ref, p_contact, p_channel, p_subject, p_coordinator_phone, p_key,
          coalesce(p_wa_mode, 'group'))
  ON CONFLICT ON CONSTRAINT submission_groups_one_per_submission DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    INSERT INTO public.submission_group_access (group_id, account_id, user_id, label)
    SELECT v_id, p_account, x.user_id, x.label
      FROM jsonb_to_recordset(coalesce(p_access, '[]'::jsonb)) AS x(user_id uuid, label text);
    RETURN QUERY SELECT v_id, true;
    RETURN;
  END IF;
  -- An existing row is returned as it stands; its mode is not changed.
  RETURN QUERY SELECT g.id, false FROM public.submission_groups g
   WHERE g.account_id = p_account AND g.submission_ref = p_submission_ref;
END;
$$;

-- 115's sg_claim_create; a 'none' row is never claimed (136).
CREATE OR REPLACE FUNCTION public.sg_claim_create(p_group uuid, p_lease_ms int, p_now timestamptz DEFAULT NULL)
RETURNS uuid
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.submission_groups
     SET wa_create_claim = gen_random_uuid(),
         wa_create_claimed_until = coalesce(p_now, now()) + make_interval(secs => p_lease_ms::double precision / 1000)
   WHERE id = p_group AND status = 'ACTIVE' AND wa_group_id IS NULL AND wa_mode = 'group'
     AND (wa_create_claimed_until IS NULL OR wa_create_claimed_until <= coalesce(p_now, now()))
  RETURNING wa_create_claim
$$;

-- 115's sg_send_begin; NULL (nothing written) for a 'none' row (136).
CREATE OR REPLACE FUNCTION public.sg_send_begin(p_group uuid, p_user uuid, p_body text, p_prefixed text)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
  v_mode    text;
  v_id      bigint;
BEGIN
  SELECT g.account_id, g.wa_mode INTO v_account, v_mode
    FROM public.submission_groups g WHERE g.id = p_group FOR SHARE;
  IF v_account IS NULL OR v_mode IS DISTINCT FROM 'group' OR NOT public.sg_can_send(p_group, p_user) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.submission_group_messages
    (group_id, account_id, direction, sender_user_id, body, prefixed_body, send_status)
  VALUES (p_group, v_account, 'out', p_user, p_body, p_prefixed, 'pending')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ---------- 4. Per-account switch: WhatsApp groups for submissions ----------

ALTER TABLE public.case_account_settings
  ADD COLUMN IF NOT EXISTS submission_whatsapp_groups boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.case_account_settings.submission_whatsapp_groups IS
  'A new submission from the submission app opens a WhatsApp group (true) or only the CRM record (false, the default). Written only through case_settings_set_whatsapp_groups. Migration 136.';

-- True when a new submission of the account opens a WhatsApp group.
CREATE OR REPLACE FUNCTION public.case_submission_whatsapp_groups(p_account uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce((SELECT s.submission_whatsapp_groups FROM public.case_account_settings s
                    WHERE s.account_id = p_account), false)
$$;

-- Sets submission_whatsapp_groups for an owner/admin of the account
-- (NOT_ALLOWED otherwise). Returns the stored value. 134's
-- case_settings_set, for this column.
CREATE OR REPLACE FUNCTION public.case_settings_set_whatsapp_groups(p_actor uuid, p_account uuid, p_on boolean)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  v_role := public.case_account_role(p_account, p_actor);
  IF v_role IS NULL OR v_role NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'NOT_ALLOWED: % may not change the case settings of %', p_actor, p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_on IS NULL THEN
    RAISE EXCEPTION 'SETTING_INVALID: submission_whatsapp_groups must be true or false'
      USING ERRCODE = 'check_violation', HINT = 'SETTING_INVALID';
  END IF;
  INSERT INTO public.case_account_settings AS s (account_id, submission_whatsapp_groups, updated_at, updated_by)
  VALUES (p_account, p_on, now(), p_actor)
  ON CONFLICT (account_id) DO UPDATE
    SET submission_whatsapp_groups = EXCLUDED.submission_whatsapp_groups, updated_at = EXCLUDED.updated_at,
        updated_by = EXCLUDED.updated_by;
  RETURN p_on;
END;
$$;

-- ---------- 5. Privileges ----------

-- sg_open as 115 grants it (re-created above with a new signature).
REVOKE ALL ON FUNCTION
  public.sg_open(uuid, text, uuid, uuid, text, text, jsonb, uuid, text),
  public.sg_claim_create(uuid, int, timestamptz),
  public.sg_send_begin(uuid, uuid, text, text),
  public.submission_groups_guard(),
  public.case_submission_whatsapp_groups(uuid),
  public.case_settings_set_whatsapp_groups(uuid, uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.sg_open(uuid, text, uuid, uuid, text, text, jsonb, uuid, text),
  public.sg_claim_create(uuid, int, timestamptz),
  public.sg_send_begin(uuid, uuid, text, text),
  public.case_submission_whatsapp_groups(uuid),
  public.case_settings_set_whatsapp_groups(uuid, uuid, boolean)
  TO service_role;

RESET lock_timeout;
