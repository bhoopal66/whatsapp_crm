-- ============================================================
-- 211: staff add another phone number to a submission group
-- ============================================================
--
-- A submission group (115) is a per-case customer WhatsApp group on a
-- Whapi number. Staff who can open a group may now add one more phone
-- number to the WhatsApp group (a relative, a second phone of the
-- customer). The app calls the gateway; SQL keeps the decision, a log
-- of every add (who, which number, outcome) and the rate limit.
--
-- This migration:
--   * adds submission_group_added_numbers, one row per attempt: born
--     'pending' by sg_add_number_begin, settled once by
--     sg_add_number_settle to added | invited | refused | failed;
--   * adds sg_add_number_begin(group, user, phone) -> jsonb, which
--     locks the group row and answers {"ok": false, "code": ...} with,
--     in this order: not_found, not_active, not_allowed (sg_can_read),
--     no_whatsapp (wa_mode 'none', 136), no_group_yet (no wa_group_id),
--     detached (channel removed), bad_phone (6-15 digits, country code,
--     no '+'), own_number (the hosting number), opted_out /
--     do_not_contact (a contact of the account with that
--     phone_normalized, 022), in_progress (a pending add of the same
--     number under 2 minutes old), too_many (10 attempts per group per
--     24 hours, any outcome); else a pending row and
--     {"ok": true, "id", "account_id", "channel_id", "wa_group_id",
--     "invite_link"};
--   * adds sg_add_number_settle(id, status, error) -> boolean: pending
--     -> a final status, once; error clipped to 500 characters.
--
-- Like 115, the table is RLS-forced with no policy and nobody writes it
-- directly, the service role included: it reads it, and writes through
-- the two functions, which are granted to the service role only.
--
-- Like 115 and 136, this must be applied by a superuser or BYPASSRLS
-- role (the sg_* functions read RLS-forced tables).
--
-- Re-runnable: IF NOT EXISTS, CREATE OR REPLACE, REVOKE / GRANT.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '211 must be applied by a superuser or BYPASSRLS role (the sg_* functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. The log ----------

CREATE TABLE IF NOT EXISTS public.submission_group_added_numbers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid NOT NULL,
  account_id  uuid NOT NULL,
  phone       text NOT NULL,
  added_by    uuid NOT NULL,  -- auth user id
  status      text NOT NULL DEFAULT 'pending',
  error       text NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  settled_at  timestamptz NULL,
  CONSTRAINT submission_group_added_numbers_phone_check CHECK (phone ~ '^[0-9]{6,15}$'),
  CONSTRAINT submission_group_added_numbers_status_check
    CHECK (status IN ('pending', 'added', 'invited', 'refused', 'failed')),
  CONSTRAINT submission_group_added_numbers_error_check CHECK (char_length(error) <= 500),
  CONSTRAINT submission_group_added_numbers_settled_check CHECK ((status = 'pending') = (settled_at IS NULL)),
  CONSTRAINT submission_group_added_numbers_group_fkey FOREIGN KEY (group_id, account_id)
    REFERENCES public.submission_groups (id, account_id)
);

CREATE INDEX IF NOT EXISTS submission_group_added_numbers_group_idx
  ON public.submission_group_added_numbers (group_id, created_at);

COMMENT ON TABLE public.submission_group_added_numbers IS
  'Every attempt to add a phone number to a submission group''s WhatsApp group: born pending (sg_add_number_begin), settled once (sg_add_number_settle). Migration 211.';

ALTER TABLE public.submission_group_added_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submission_group_added_numbers FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.submission_group_added_numbers FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.submission_group_added_numbers TO service_role;

-- ---------- 2. Begin: decide, then log a pending attempt ----------

CREATE OR REPLACE FUNCTION public.sg_add_number_begin(p_group uuid, p_user uuid, p_phone text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  g    record;
  v_id uuid;
BEGIN
  -- The row lock serialises concurrent adds to one group, so the
  -- in_progress and too_many counts below cannot race.
  SELECT sg.id, sg.account_id, sg.status, sg.wa_mode, sg.wa_group_id, sg.channel_id, sg.invite_link
    INTO g
    FROM public.submission_groups sg
   WHERE sg.id = p_group
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF g.status <> 'ACTIVE' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_active');
  END IF;
  IF p_user IS NULL OR NOT coalesce(public.sg_can_read(p_group, p_user), false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_allowed');
  END IF;
  IF g.wa_mode = 'none' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'no_whatsapp');
  END IF;
  IF g.wa_group_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'no_group_yet');
  END IF;
  IF g.channel_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'detached');
  END IF;
  IF p_phone IS NULL OR p_phone !~ '^[0-9]{6,15}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_phone');
  END IF;
  -- For a Whapi row waba_id holds the connected phone number (display).
  IF EXISTS (SELECT 1 FROM public.whatsapp_config w
              WHERE w.id = g.channel_id
                AND regexp_replace(coalesce(w.waba_id, ''), '\D', '', 'g') = p_phone) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'own_number');
  END IF;
  -- phone_normalized (022) is the phone with every non-digit stripped.
  IF EXISTS (SELECT 1 FROM public.contacts c
              WHERE c.account_id = g.account_id AND c.phone_normalized = p_phone
                AND c.opted_out_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'opted_out');
  END IF;
  IF EXISTS (SELECT 1 FROM public.contacts c
              WHERE c.account_id = g.account_id AND c.phone_normalized = p_phone
                AND c.do_not_contact_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'do_not_contact');
  END IF;
  IF EXISTS (SELECT 1 FROM public.submission_group_added_numbers a
              WHERE a.group_id = p_group AND a.phone = p_phone AND a.status = 'pending'
                AND a.created_at > now() - interval '2 minutes') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'in_progress');
  END IF;
  IF (SELECT count(*) FROM public.submission_group_added_numbers a
       WHERE a.group_id = p_group AND a.created_at > now() - interval '24 hours') >= 10 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'too_many');
  END IF;

  INSERT INTO public.submission_group_added_numbers (group_id, account_id, phone, added_by)
  VALUES (p_group, g.account_id, p_phone, p_user)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'account_id', g.account_id,
    'channel_id', g.channel_id, 'wa_group_id', g.wa_group_id, 'invite_link', g.invite_link);
END;
$$;

-- ---------- 3. Settle: pending -> a final status, once ----------

CREATE OR REPLACE FUNCTION public.sg_add_number_settle(p_id uuid, p_status text, p_error text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('added', 'invited', 'refused', 'failed') THEN
    RAISE EXCEPTION 'sg_add_number_settle: status must be added, invited, refused or failed (got %)', p_status
      USING ERRCODE = '22023';
  END IF;
  UPDATE public.submission_group_added_numbers
     SET status = p_status,
         settled_at = now(),
         error = CASE WHEN p_error IS NULL OR p_error ~ '^[[:space:]]*$' THEN NULL
                      ELSE left(p_error, 500) END
   WHERE id = p_id AND status = 'pending';
  RETURN FOUND;
END;
$$;

-- ---------- 4. Privileges ----------

REVOKE ALL ON FUNCTION
  public.sg_add_number_begin(uuid, uuid, text),
  public.sg_add_number_settle(uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.sg_add_number_begin(uuid, uuid, text),
  public.sg_add_number_settle(uuid, text, text)
  TO service_role;
