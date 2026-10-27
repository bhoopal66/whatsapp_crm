-- ============================================================
-- 142 — Coordinators: a WhatsApp number per coordinator
--
-- A submission's WhatsApp group (115) is opened with the hosting
-- number, the customer and at most one coordinator phone the
-- submission app sends. The coordinators of the case's bank (133) are
-- the people who must be in that group, but the CRM knew them only as
-- logins: there was no number to add. An owner or admin now saves one
-- per coordinator in Settings -> Members (the coordinator banks
-- dialog); a later change adds every coordinator of a case's bank to
-- the group from these rows.
--
--  * coordinator_phones (account, auth user, phone): one number per
--    person per workspace, digits only in international form, the same
--    rule as submission_groups.coordinator_phone (115). Kept apart
--    from profiles on purpose: profiles is read by every member, this
--    is read by owners / admins only.
--  * Written only by set_coordinator_phone(), mirroring
--    set_coordinator_banks (133): a live owner/admin of the caller's
--    active account, under the person's profile row lock. Setting a
--    number needs a live agent / team_leader of that account; a blank
--    or NULL number clears it for anyone (a person demoted since keeps
--    the row until cleared, as with banks). Returns the stored number.
--  * No cleanup trigger, like coordinator_banks: a row whose holder is
--    no longer live agent / team_leader staff of the account is
--    ignored by its readers, which must check that, as 133's
--    predicates do.
--
--  * submission_groups.coordinator_phones (text[], default '{}'): the
--    coordinators' numbers a submission's group is opened with, at
--    most 5 (MAX_COORDINATOR_PHONES, src/lib/submission-groups/
--    api-input.ts), each 5-25 digits. Set by sg_open on INSERT only
--    (new last parameter p_coordinator_phones; an existing row is
--    returned unchanged) and part of the group's fixed identity in
--    submission_groups_guard. coordinator_phone (115) is unchanged.
--  * sg_bank_coordinators(account, bank) (service role only): the
--    bank's coordinators who are live agent / team_leader staff of the
--    account now, each with their saved number or NULL. It is the
--    staleness check above for coordinator_banks and coordinator_phones.
--
-- Like 133, apply as a superuser or a BYPASSRLS role: the tables are
-- RLS-forced and the SECURITY DEFINER functions read and write them
-- as their owner (checked first, as 141 does). Asserted by
-- supabase/ci/verify-coordinator-phones.sql.
--
-- Re-runnable: IF NOT EXISTS, guarded constraints, DROP POLICY IF
-- EXISTS, DROP FUNCTION IF EXISTS, CREATE OR REPLACE.
-- ============================================================

SET lock_timeout = '5s';

-- sg_bank_coordinators reads RLS-forced tables as its definer.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles r
     WHERE r.rolname = current_user
       AND (r.rolsuper
            OR (r.rolbypassrls
                AND pg_has_role(current_user,
                      (SELECT c.relowner FROM pg_class c WHERE c.oid = 'public.submission_groups'::regclass),
                      'MEMBER')))
  ) THEN
    RAISE EXCEPTION '142 must be applied by a superuser or a BYPASSRLS owner of public.submission_groups';
  END IF;
END $$;

-- ---------- 1. The numbers ----------

CREATE TABLE IF NOT EXISTS public.coordinator_phones (
  account_id uuid        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phone      text        NOT NULL,
  updated_by uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coordinator_phones_pkey PRIMARY KEY (account_id, user_id)
);

-- 115's submission_groups_coordinator_phone_check.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'coordinator_phones_phone_check'
       AND conrelid = 'public.coordinator_phones'::regclass
  ) THEN
    ALTER TABLE public.coordinator_phones
      ADD CONSTRAINT coordinator_phones_phone_check CHECK (phone ~ '^[0-9]{5,25}$');
  END IF;
END $$;

ALTER TABLE public.coordinator_phones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coordinator_phones FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.coordinator_phones FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.coordinator_phones TO authenticated, service_role;

-- Owners and admins of the active account read; everyone else reads
-- nothing (a bank guest has no active account at all).
DROP POLICY IF EXISTS coordinator_phones_select ON public.coordinator_phones;
CREATE POLICY coordinator_phones_select ON public.coordinator_phones
  FOR SELECT
  USING (
    account_id = (SELECT public.current_account_id())
    AND (SELECT public.current_role_rank()) >= 4
  );

COMMENT ON TABLE public.coordinator_phones IS
  'A coordinator''s WhatsApp number (digits, international form), one per person per workspace; added to the WhatsApp groups of their banks'' submissions. Owner/admin read. Written only by set_coordinator_phone(). Migration 142.';

-- ---------- 2. The write RPC ----------

CREATE OR REPLACE FUNCTION public.set_coordinator_phone(p_user_id uuid, p_phone text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct uuid := public.current_account_id();
BEGIN
  IF auth.uid() IS NULL OR v_acct IS NULL OR public.current_role_rank() < 4 THEN
    RAISE EXCEPTION 'Only an owner or admin can set a coordinator''s number'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'A person is required' USING ERRCODE = '22023';
  END IF;

  -- One writer per person at a time (the row lock switch_account takes).
  PERFORM 1 FROM public.profiles p
    WHERE p.user_id = p_user_id AND p.account_id = v_acct
    FOR UPDATE;

  -- Blank clears, for anyone: never btrim(x) = '' (spaces only).
  IF p_phone IS NULL OR p_phone ~ '^[[:space:]]*$' THEN
    DELETE FROM public.coordinator_phones c
     WHERE c.account_id = v_acct AND c.user_id = p_user_id;
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.user_id = p_user_id
       AND p.account_id = v_acct
       AND p.deactivated_at IS NULL
       AND p.account_role::text IN ('agent', 'team_leader')
  ) THEN
    RAISE EXCEPTION 'Only a live agent or team leader can be a coordinator'
      USING ERRCODE = '22023', HINT = 'not_eligible';
  END IF;

  IF p_phone !~ '^[0-9]{5,25}$' THEN
    RAISE EXCEPTION 'A number is 5 to 25 digits' USING ERRCODE = '22023', HINT = 'invalid_phone';
  END IF;

  INSERT INTO public.coordinator_phones (account_id, user_id, phone, updated_by, updated_at)
  VALUES (v_acct, p_user_id, p_phone, auth.uid(), now())
  ON CONFLICT (account_id, user_id) DO UPDATE
    SET phone = EXCLUDED.phone, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;

  RETURN p_phone;
END;
$$;

REVOKE ALL ON FUNCTION public.set_coordinator_phone(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_coordinator_phone(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.set_coordinator_phone(uuid, text) IS
  'Set or clear a person''s coordinator WhatsApp number in the caller''s active account (owner/admin only). Setting needs a live agent / team_leader and 5-25 digits; blank or NULL clears. Returns the stored number or NULL. Migration 142.';

-- ---------- 3. A submission group's coordinator numbers ----------

ALTER TABLE public.submission_groups
  ADD COLUMN IF NOT EXISTS coordinator_phones text[] NOT NULL DEFAULT '{}';

-- At most MAX_COORDINATOR_PHONES (src/lib/submission-groups/api-input.ts)
-- numbers, each 5-25 digits as coordinator_phone (115). No subquery is
-- allowed in a CHECK, so the elements are joined: a NULL element becomes
-- 'x' and fails the pattern, and counting the separators refuses an
-- element that itself holds a comma.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'submission_groups_coordinator_phones_check'
       AND conrelid = 'public.submission_groups'::regclass
  ) THEN
    ALTER TABLE public.submission_groups
      ADD CONSTRAINT submission_groups_coordinator_phones_check CHECK (
        cardinality(coordinator_phones) <= 5
        AND (cardinality(coordinator_phones) = 0
             OR (array_to_string(coordinator_phones, ',', 'x') ~ '^[0-9]{5,25}(,[0-9]{5,25})*$'
                 AND length(array_to_string(coordinator_phones, ',', 'x'))
                     - length(replace(array_to_string(coordinator_phones, ',', 'x'), ',', ''))
                     = cardinality(coordinator_phones) - 1))
      );
  END IF;
END $$;

COMMENT ON COLUMN public.submission_groups.coordinator_phones IS
  'The coordinators'' WhatsApp numbers the group is opened with (at most 5, each 5-25 digits). Set by sg_open on INSERT only; fixed after. Migration 142.';

-- 136's submission_groups_guard; the one change is coordinator_phones
-- joining the fixed identity.
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
       OR NEW.wa_mode IS DISTINCT FROM OLD.wa_mode  -- 136
       OR NEW.coordinator_phones IS DISTINCT FROM OLD.coordinator_phones THEN  -- 142
      RAISE EXCEPTION 'public.submission_groups: the group identity is fixed (id, account_id, submission_ref, contact_id, channel_id, wa_mode, coordinator_phones; UPDATE refused)'
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

-- ---------- 4. sg_open ----------

-- 141's sg_open plus p_coordinator_phones. Dropped first so the
-- 10-argument signature does not survive as an overload.
DROP FUNCTION IF EXISTS public.sg_open(uuid, text, uuid, uuid, text, text, jsonb, uuid, text, text);

CREATE OR REPLACE FUNCTION public.sg_open(p_account uuid, p_submission_ref text, p_contact uuid,
  p_channel uuid, p_subject text, p_coordinator_phone text, p_access jsonb, p_key uuid,
  p_wa_mode text DEFAULT 'group', p_customer_name text DEFAULT NULL,
  p_coordinator_phones text[] DEFAULT '{}')
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
    (account_id, submission_ref, contact_id, channel_id, subject, coordinator_phone, created_by_key, wa_mode,
     customer_name, coordinator_phones)
  VALUES (p_account, p_submission_ref, p_contact, p_channel, p_subject, p_coordinator_phone, p_key,
          coalesce(p_wa_mode, 'group'), p_customer_name, coalesce(p_coordinator_phones, '{}'))
  ON CONFLICT ON CONSTRAINT submission_groups_one_per_submission DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    INSERT INTO public.submission_group_access (group_id, account_id, user_id, label)
    SELECT v_id, p_account, x.user_id, x.label
      FROM jsonb_to_recordset(coalesce(p_access, '[]'::jsonb)) AS x(user_id uuid, label text);
    RETURN QUERY SELECT v_id, true;
    RETURN;
  END IF;
  -- An existing row is returned as it stands; its mode, customer name and
  -- coordinator numbers are not changed.
  RETURN QUERY SELECT g.id, false FROM public.submission_groups g
   WHERE g.account_id = p_account AND g.submission_ref = p_submission_ref;
END;
$$;

-- sg_open as 141 grants it (re-created above with a new signature).
REVOKE ALL ON FUNCTION
  public.sg_open(uuid, text, uuid, uuid, text, text, jsonb, uuid, text, text, text[])
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.sg_open(uuid, text, uuid, uuid, text, text, jsonb, uuid, text, text, text[])
  TO service_role;

-- ---------- 5. A bank's coordinators ----------

-- coordinator_banks (133) and coordinator_phones keep rows for a person
-- deactivated or demoted since, so the staff filter here is the check.
CREATE OR REPLACE FUNCTION public.sg_bank_coordinators(p_account uuid, p_bank text)
RETURNS TABLE (user_id uuid, phone text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT b.user_id, cp.phone
    FROM public.coordinator_banks b
    LEFT JOIN public.coordinator_phones cp
      ON cp.account_id = b.account_id AND cp.user_id = b.user_id
   WHERE b.account_id = p_account
     AND b.bank_code = p_bank
     AND EXISTS (
       SELECT 1 FROM public.profiles p
        WHERE p.user_id = b.user_id
          AND p.account_id = b.account_id
          AND p.deactivated_at IS NULL
          AND p.account_role::text IN ('agent', 'team_leader'))
   ORDER BY b.user_id;
$$;

REVOKE ALL ON FUNCTION public.sg_bank_coordinators(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sg_bank_coordinators(uuid, text) TO service_role;

COMMENT ON FUNCTION public.sg_bank_coordinators(uuid, text) IS
  'The coordinators of a bank in an account who are live agent / team_leader staff there now, each with their saved WhatsApp number or NULL, ordered by user id. Service role only. Migration 142.';
