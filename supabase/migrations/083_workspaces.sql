-- 083_workspaces.sql — one person, several workspaces (SQL core)
--
-- Until now profiles.account_id was a person's only membership: one
-- profile per auth user (UNIQUE user_id, 001), so belonging to Taamul
-- Credit and TrafeeqPay at once meant two logins. This makes profiles
-- one row per (user, account) — a membership with its own role and
-- deactivation — and marks exactly one row per person `is_active`: the
-- workspace they are working in. switch_account() moves that mark.
--
-- Every existing policy keeps its meaning, "the caller's ACTIVE
-- account", because the three helpers they are built on now read the
-- active row only: is_account_member(), current_account_id() and
-- current_role_rank(). Nothing else changes for a person with one row.
--
-- `bank_guest` (082) is a membership that sees nothing: rank 0, never
-- an is_account_member(), and no current_account_id() while it is the
-- active row, so every account-scoped policy is closed to a guest.
-- my_workspaces() is SECURITY DEFINER because a guest cannot read
-- `accounts` through RLS. bank_code names the guest's bank.
--
-- Lookups of the caller's own profile by user_id alone become
-- multi-row with this change. In a policy's scalar subquery that is an
-- error ("more than one row returned"): the 080 deals policies now take
-- the caller's row in the active account. Other-user joins keyed on
-- user_id alone gain the account (team_activity_alert_sweep counted a
-- person once per membership; led_teammate_profile_ids listed every
-- membership's profile id), and the storage policies — which matched
-- the caller's profile in ANY account, a guest's included — read the
-- active, non-deactivated, non-guest row only.
--
-- switch_account() must work for a person whose active row is
-- deactivated (moving out is the point), which the 069 guard would
-- refuse; it raises the transaction-local `app.account_switch` flag for
-- its own UPDATEs (the 062 pattern). It changes no account_id, so the
-- 071 profiles_leave_account_teams trigger (UPDATE OF account_id) does
-- not fire: team memberships and number allocations survive a switch.
--
-- Not here (next migration): the member RPCs (set_member_role,
-- remove_account_member, transfer_account_ownership, redeem_invitation,
-- provision_account_member, set_member_active) still assume one row per
-- person; they behave as before for anyone who has one.

-- ---------- 1. profiles: one row per (user, account) ----------
DO $$
DECLARE v_con text;
BEGIN
  FOR v_con IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.profiles'::regclass AND contype = 'u'
       AND pg_get_constraintdef(oid) = 'UNIQUE (user_id)'
  LOOP
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', v_con);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.profiles'::regclass
                    AND conname = 'profiles_user_account_key') THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_user_account_key UNIQUE (user_id, account_id);
  END IF;
END $$;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS bank_code text;

-- Existing rows are each their person's only row, so all stay active.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_one_active_per_user
  ON public.profiles (user_id) WHERE is_active;

-- A bank_guest row names its bank; no other row carries one.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.profiles'::regclass
                    AND conname = 'profiles_bank_code_guest_only') THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_bank_code_guest_only
      CHECK ((account_role = 'bank_guest') = (bank_code IS NOT NULL)
             AND (bank_code IS NULL OR btrim(bank_code) <> ''));
  END IF;
END $$;

-- ---------- 2. accounts: a short name, and owning several ----------
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS short_name text;

-- Initials of up to four words, upper-cased ("Taamul Credit" → TC).
CREATE OR REPLACE FUNCTION public.account_initials(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT NULLIF(upper(left(string_agg(left(w, 1), '' ORDER BY i), 4)), '')
    FROM regexp_split_to_table(btrim(coalesce(p_name, '')), '[^[:alnum:]]+')
         WITH ORDINALITY AS t(w, i)
   WHERE w <> '';
$$;

CREATE OR REPLACE FUNCTION public.accounts_fill_short_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.short_name IS NULL THEN
    NEW.short_name := account_initials(NEW.name);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounts_fill_short_name ON public.accounts;
CREATE TRIGGER accounts_fill_short_name
  BEFORE INSERT ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.accounts_fill_short_name();

UPDATE public.accounts SET short_name = account_initials(name)
 WHERE short_name IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.accounts'::regclass
                    AND conname = 'accounts_short_name_check') THEN
    ALTER TABLE public.accounts ADD CONSTRAINT accounts_short_name_check
      CHECK (short_name IS NULL
             OR (char_length(short_name) BETWEEN 1 AND 4
                 AND short_name = btrim(short_name)));
  END IF;
END $$;

-- 017 held a person to owning one account; a person may now own several.
DROP INDEX IF EXISTS public.idx_accounts_one_per_owner;

-- ---------- 3. the helpers read the ACTIVE row ----------
CREATE OR REPLACE FUNCTION public.is_account_member(
  target_account_id uuid,
  min_role account_role_enum DEFAULT 'viewer'
)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND p.is_active
      AND p.deactivated_at IS NULL
      AND p.account_role <> 'bank_guest'
      AND CASE p.account_role
            WHEN 'owner'       THEN 5
            WHEN 'admin'       THEN 4
            WHEN 'team_leader' THEN 3
            WHEN 'agent'       THEN 2
            WHEN 'viewer'      THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'       THEN 5
            WHEN 'admin'       THEN 4
            WHEN 'team_leader' THEN 3
            WHEN 'agent'       THEN 2
            WHEN 'viewer'      THEN 1
          END
  );
$$;

-- NULL for a guest: every `account_id = current_account_id()` policy
-- is closed to them. At most one row matches (profiles_one_active_per_user).
CREATE OR REPLACE FUNCTION public.current_account_id()
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT account_id FROM profiles
  WHERE user_id = auth.uid()
    AND is_active
    AND deactivated_at IS NULL
    AND account_role <> 'bank_guest'
$$;

-- bank_guest falls to ELSE 0.
CREATE OR REPLACE FUNCTION public.current_role_rank()
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE((
    SELECT CASE account_role
             WHEN 'owner'       THEN 5
             WHEN 'admin'       THEN 4
             WHEN 'team_leader' THEN 3
             WHEN 'agent'       THEN 2
             WHEN 'viewer'      THEN 1
             ELSE 0
           END
    FROM profiles
    WHERE user_id = auth.uid() AND is_active AND deactivated_at IS NULL
  ), 0)
$$;

-- ---------- 4. lookups keyed on user_id alone ----------
CREATE OR REPLACE FUNCTION public.led_teammate_profile_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(array_agg(p.id), '{}')
    FROM profiles p
   WHERE p.user_id = ANY (led_teammate_user_ids())
     AND p.account_id = current_account_id();
$$;

-- 080's deals policies, the caller's own profile taken in the active
-- account (the deal's: every policy also requires account_id =
-- current_account_id()). Kept uncorrelated so it stays one initplan.
DROP POLICY IF EXISTS deals_select ON public.deals;
CREATE POLICY deals_select ON public.deals
  FOR SELECT
  USING (
    account_id = (SELECT current_account_id())
    AND (
      (SELECT current_role_rank()) >= 4
      OR (assigned_to IS NULL AND user_id = (SELECT auth.uid()))
      OR assigned_to = (SELECT p.id FROM profiles p
                         WHERE p.user_id = (SELECT auth.uid())
                           AND p.account_id = (SELECT current_account_id()))
      OR ((SELECT current_role_rank()) = 3
          AND ((assigned_to IS NULL AND user_id = ANY ((SELECT led_teammate_user_ids())::uuid[]))
               OR assigned_to = ANY ((SELECT led_teammate_profile_ids())::uuid[])))
    )
  );

DROP POLICY IF EXISTS deals_insert ON public.deals;
CREATE POLICY deals_insert ON public.deals
  FOR INSERT
  WITH CHECK (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND (
      (SELECT current_role_rank()) >= 4
      OR (assigned_to IS NULL AND user_id = (SELECT auth.uid()))
      OR assigned_to = (SELECT p.id FROM profiles p
                         WHERE p.user_id = (SELECT auth.uid())
                           AND p.account_id = (SELECT current_account_id()))
      OR ((SELECT current_role_rank()) = 3
          AND ((assigned_to IS NULL AND user_id = ANY ((SELECT led_teammate_user_ids())::uuid[]))
               OR assigned_to = ANY ((SELECT led_teammate_profile_ids())::uuid[])))
    )
  );

DROP POLICY IF EXISTS deals_update ON public.deals;
CREATE POLICY deals_update ON public.deals
  FOR UPDATE
  USING (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND (
      (SELECT current_role_rank()) >= 4
      OR (assigned_to IS NULL AND user_id = (SELECT auth.uid()))
      OR assigned_to = (SELECT p.id FROM profiles p
                         WHERE p.user_id = (SELECT auth.uid())
                           AND p.account_id = (SELECT current_account_id()))
      OR ((SELECT current_role_rank()) = 3
          AND ((assigned_to IS NULL AND user_id = ANY ((SELECT led_teammate_user_ids())::uuid[]))
               OR assigned_to = ANY ((SELECT led_teammate_profile_ids())::uuid[])))
    )
  )
  WITH CHECK (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND (
      (SELECT current_role_rank()) >= 4
      OR (assigned_to IS NULL AND user_id = (SELECT auth.uid()))
      OR assigned_to = (SELECT p.id FROM profiles p
                         WHERE p.user_id = (SELECT auth.uid())
                           AND p.account_id = (SELECT current_account_id()))
      OR ((SELECT current_role_rank()) = 3
          AND ((assigned_to IS NULL AND user_id = ANY ((SELECT led_teammate_user_ids())::uuid[]))
               OR assigned_to = ANY ((SELECT led_teammate_profile_ids())::uuid[])))
    )
  );

DROP POLICY IF EXISTS deals_delete ON public.deals;
CREATE POLICY deals_delete ON public.deals
  FOR DELETE
  USING (
    account_id = (SELECT current_account_id())
    AND (SELECT current_role_rank()) >= 2
    AND (
      (SELECT current_role_rank()) >= 4
      OR (assigned_to IS NULL AND user_id = (SELECT auth.uid()))
      OR assigned_to = (SELECT p.id FROM profiles p
                         WHERE p.user_id = (SELECT auth.uid())
                           AND p.account_id = (SELECT current_account_id()))
      OR ((SELECT current_role_rank()) = 3
          AND ((assigned_to IS NULL AND user_id = ANY ((SELECT led_teammate_user_ids())::uuid[]))
               OR assigned_to = ANY ((SELECT led_teammate_profile_ids())::uuid[])))
    )
  );


-- 027 (latest body): the actor's name from their row in this account.
CREATE OR REPLACE FUNCTION public.notify_conversation_assigned()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contact_name TEXT;
  v_actor_name TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.assigned_agent_id IS NULL
       OR NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
      RETURN NEW;
    END IF;
  END IF;
  -- Skip self-assignment — nothing to notify the agent about.
  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.assigned_agent_id THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
  FROM contacts WHERE id = NEW.contact_id;
  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name
    FROM profiles WHERE user_id = auth.uid() AND account_id = NEW.account_id;
  END IF;
  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id,
    actor_user_id, title, body
  ) VALUES (
    NEW.account_id,
    NEW.assigned_agent_id,
    'conversation_assigned',
    NEW.id,
    NEW.contact_id,
    auth.uid(),
    'New conversation assigned',
    COALESCE(v_actor_name, 'Someone') || ' assigned you a conversation with '
      || COALESCE(v_contact_name, 'a contact')
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a notification failure block the assignment itself.
  RAISE WARNING 'Failed to create assignment notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$
;

-- 074 (latest body): the per-person count joined every membership of
-- the sender; now only their row in the account being swept.
CREATE OR REPLACE FUNCTION public.team_activity_alert_sweep()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account uuid;
  v_cfg     record;
  v_tz      text;
  v_today   timestamptz;
  v_day     date;
  r         record;
  v_alerts  integer := 0;
  v_notes   integer := 0;
  v_n       integer;
  v_nil     constant uuid := '00000000-0000-0000-0000-000000000000';
  l         record;
BEGIN
  FOR v_account IN
    SELECT DISTINCT c.account_id
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.created_at > now() - interval '25 hours'
      AND m.sender_type <> 'customer'
  LOOP
    SELECT * INTO v_cfg FROM team_activity_limits(v_account);
    -- Only once an admin has saved the limits: until then nobody has
    -- chosen them, and "today" would be the UTC day.
    CONTINUE WHEN NOT coalesce(v_cfg.saved, false) OR NOT coalesce(v_cfg.notify, true);
    v_tz := coalesce(v_cfg.timezone, 'UTC');
    v_today := date_trunc('day', now() AT TIME ZONE v_tz) AT TIME ZONE v_tz;
    v_day := (now() AT TIME ZONE v_tz)::date;
    FOR r IN
      WITH s AS (
        SELECT * FROM team_activity_starts(v_account, v_today, 'infinity')
      )
      SELECT
        'user_daily_limit'::text AS kind,
        s.sender_id AS subject_id,
        count(*)::integer AS n,
        v_cfg.daily_new_chats_per_user AS lim,
        coalesce(max(nullif(btrim(p.full_name), '')), max(p.email), 'A team member') AS who
      FROM s
      LEFT JOIN profiles p ON p.user_id = s.sender_id AND p.account_id = v_account
      WHERE s.sender_type = 'agent' AND s.sender_id IS NOT NULL AND s.provider = 'whapi'
      GROUP BY s.sender_id
      HAVING count(*) >= v_cfg.daily_new_chats_per_user
      UNION ALL
      SELECT
        'number_daily_limit',
        w.id,
        count(*)::integer,
        team_activity_number_limit(max(w.created_at), v_cfg.daily_new_chats_per_number),
        coalesce(max(nullif(btrim(w.label), '')), max(w.waba_id), 'A WhatsApp number')
      FROM s
      JOIN whatsapp_config w
        ON w.id = s.channel_id AND w.account_id = v_account AND w.provider = 'whapi'
      GROUP BY w.id
      HAVING count(*) >= team_activity_number_limit(max(w.created_at), v_cfg.daily_new_chats_per_number)
    LOOP
      -- The leaders' copies first: they do not depend on whether the
      -- account-level alert went out on an earlier sweep.
      FOR l IN
        SELECT DISTINCT t.leader_user_id AS uid
        FROM teams t
        JOIN profiles p ON p.user_id = t.leader_user_id AND p.account_id = v_account
        WHERE t.account_id = v_account
          AND t.leader_user_id IS NOT NULL
          AND p.account_role = 'team_leader'
          AND t.leader_user_id IS DISTINCT FROM CASE WHEN r.kind = 'user_daily_limit' THEN r.subject_id END
          AND CASE WHEN r.kind = 'user_daily_limit'
                   THEN EXISTS (SELECT 1 FROM team_members tm
                                WHERE tm.team_id = t.id AND tm.user_id = r.subject_id)
                   ELSE EXISTS (SELECT 1 FROM whatsapp_channel_teams ct
                                WHERE ct.team_id = t.id AND ct.config_id = r.subject_id)
              END
      LOOP
        INSERT INTO team_activity_alerts (account_id, kind, subject_id, day, value, threshold, recipient_id)
        VALUES (v_account, r.kind, r.subject_id, v_day, r.n, r.lim, l.uid)
        ON CONFLICT DO NOTHING;
        CONTINUE WHEN NOT FOUND;
        INSERT INTO notifications (account_id, user_id, type, title, body)
        VALUES (
          v_account, l.uid, 'team_activity_alert',
          CASE WHEN r.kind = 'user_daily_limit'
               THEN 'Daily new-chat limit reached'
               ELSE 'A WhatsApp number reached its daily new-chat limit' END,
          CASE WHEN r.kind = 'user_daily_limit'
               THEN format('%s has started %s new chats today; the limit is %s. Unanswered first messages are the main reason WhatsApp restricts a number.', r.who, r.n, r.lim)
               ELSE format('%s has started %s new chats today; the limit is %s. Starting more today raises the risk of WhatsApp restricting this number.', r.who, r.n, r.lim) END);
        v_notes := v_notes + 1;
      END LOOP;
      INSERT INTO team_activity_alerts (account_id, kind, subject_id, day, value, threshold, recipient_id)
      VALUES (v_account, r.kind, r.subject_id, v_day, r.n, r.lim, v_nil)
      ON CONFLICT DO NOTHING;
      CONTINUE WHEN NOT FOUND;
      v_alerts := v_alerts + 1;
      IF r.kind = 'user_daily_limit' THEN
        INSERT INTO notifications (account_id, user_id, type, title, body)
        SELECT
          v_account, p.user_id, 'team_activity_alert',
          CASE WHEN p.user_id = r.subject_id
               THEN 'You have reached today''s new-chat limit'
               ELSE 'Daily new-chat limit reached' END,
          CASE WHEN p.user_id = r.subject_id
               THEN format('You have started %s new chats today; the limit is %s. Answer the chats you already have and start new ones tomorrow: unanswered first messages are the main reason WhatsApp restricts a number.', r.n, r.lim)
               ELSE format('%s has started %s new chats today; the limit is %s. Unanswered first messages are the main reason WhatsApp restricts a number.', r.who, r.n, r.lim) END
        FROM profiles p
        WHERE p.account_id = v_account
          AND (p.account_role IN ('owner', 'admin') OR p.user_id = r.subject_id);
      ELSE
        INSERT INTO notifications (account_id, user_id, type, title, body)
        SELECT
          v_account, p.user_id, 'team_activity_alert',
          'A WhatsApp number reached its daily new-chat limit',
          format('%s has started %s new chats today; the limit is %s. Starting more today raises the risk of WhatsApp restricting this number.', r.who, r.n, r.lim)
        FROM profiles p
        WHERE p.account_id = v_account
          AND p.account_role IN ('owner', 'admin');
      END IF;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_notes := v_notes + v_n;
    END LOOP;
  END LOOP;
  DELETE FROM team_activity_alerts WHERE created_at < now() - interval '90 days';
  RETURN jsonb_build_object('alerts', v_alerts, 'notifications', v_notes);
END
$function$
;

-- ---------- 5. the profile guard ----------
-- is_active and bank_code join the columns only a sanctioned writer may
-- change. The deactivated-caller check reads the caller's ACTIVE row: a
-- person deactivated in one workspace still works in another.
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user = 'authenticated' AND (
       TG_OP = 'INSERT'
       OR NEW.account_role IS DISTINCT FROM OLD.account_role
       OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.deactivated_at IS DISTINCT FROM OLD.deactivated_at
       OR NEW.deactivated_by IS DISTINCT FROM OLD.deactivated_by
       OR NEW.is_active IS DISTINCT FROM OLD.is_active
       OR NEW.bank_code IS DISTINCT FROM OLD.bank_code
     )
  THEN
    RAISE EXCEPTION
      'account_role, account_id and deactivation cannot be changed directly; use the account member/invitation RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- switch_account() checked the caller itself, and moving out of a
  -- workspace where they were deactivated is what it is for. It is the
  -- only place this flag is raised; clients cannot set it.
  IF COALESCE(current_setting('app.account_switch', TRUE), '') = 'on' THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NOT NULL AND EXISTS (
       SELECT 1 FROM profiles
       WHERE user_id = auth.uid() AND is_active AND deactivated_at IS NOT NULL
     )
  THEN
    RAISE EXCEPTION 'Your access to this account has been deactivated'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

-- ---------- 6. switching ----------
CREATE OR REPLACE FUNCTION public.switch_account(p_account_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- One switch at a time per person.
  PERFORM 1 FROM profiles WHERE user_id = v_uid ORDER BY id FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM profiles
     WHERE user_id = v_uid
       AND account_id = p_account_id
       AND deactivated_at IS NULL
  ) THEN
    RAISE EXCEPTION 'You are not an active member of that workspace'
      USING ERRCODE = '42501';
  END IF;

  -- Demote, then promote: profiles_one_active_per_user is not deferrable.
  PERFORM set_config('app.account_switch', 'on', TRUE);
  UPDATE profiles SET is_active = false
   WHERE user_id = v_uid AND is_active AND account_id <> p_account_id;
  UPDATE profiles SET is_active = true
   WHERE user_id = v_uid AND account_id = p_account_id AND NOT is_active;
  PERFORM set_config('app.account_switch', '', TRUE);

  RETURN p_account_id;
END;
$$;

-- The switcher's list. A guest cannot read `accounts` through RLS.
CREATE OR REPLACE FUNCTION public.my_workspaces()
RETURNS TABLE (
  account_id  uuid,
  name        text,
  short_name  text,
  role        account_role_enum,
  is_active   boolean,
  deactivated boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT a.id, a.name, a.short_name, p.account_role, p.is_active,
         p.deactivated_at IS NOT NULL
    FROM profiles p
    JOIN accounts a ON a.id = p.account_id
   WHERE p.user_id = auth.uid()
   ORDER BY p.is_active DESC, a.name, a.id;
$$;

-- ---------- 7. one name across a person's rows ----------
-- Recursion ends by itself: the copies already hold the values, so the
-- nested trigger's UPDATE matches no row.
CREATE OR REPLACE FUNCTION public.profiles_propagate_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE profiles
     SET full_name = NEW.full_name,
         avatar_url = NEW.avatar_url,
         email = NEW.email
   WHERE user_id = NEW.user_id
     AND id <> NEW.id
     AND (full_name, avatar_url, email)
         IS DISTINCT FROM (NEW.full_name, NEW.avatar_url, NEW.email);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS profiles_propagate_identity ON public.profiles;
CREATE TRIGGER profiles_propagate_identity
  AFTER UPDATE OF full_name, avatar_url, email ON public.profiles
  FOR EACH ROW
  WHEN (OLD.full_name IS DISTINCT FROM NEW.full_name
        OR OLD.avatar_url IS DISTINCT FROM NEW.avatar_url
        OR OLD.email IS DISTINCT FROM NEW.email)
  EXECUTE FUNCTION public.profiles_propagate_identity();

-- ---------- 8. presence per workspace ----------
-- 024 keyed presence on user_id alone; a person is now online in every
-- workspace they may work in.
DO $$
BEGIN
  IF (SELECT array_agg(a.attname::text ORDER BY a.attname)
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.conrelid = 'public.member_presence'::regclass AND c.contype = 'p')
     IS DISTINCT FROM ARRAY['account_id', 'user_id'] THEN
    ALTER TABLE public.member_presence DROP CONSTRAINT IF EXISTS member_presence_pkey;
    ALTER TABLE public.member_presence
      ADD CONSTRAINT member_presence_pkey PRIMARY KEY (user_id, account_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.touch_presence(p_status text DEFAULT 'online')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('online', 'away') THEN
    RAISE EXCEPTION 'Invalid presence status: %', p_status
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'No account for caller' USING ERRCODE = '22023';
  END IF;

  INSERT INTO member_presence (user_id, account_id, status, last_seen_at)
  SELECT auth.uid(), p.account_id, p_status, now()
    FROM profiles p
   WHERE p.user_id = auth.uid() AND p.deactivated_at IS NULL
  ON CONFLICT (user_id, account_id) DO UPDATE
    SET status       = excluded.status,
        last_seen_at = now();
END;
$$;

-- ---------- 9. storage: the active workspace's folder only ----------
-- 020/023/057 matched the caller's profile in any account; the same
-- policies now take the active, non-deactivated, non-guest row.
DO $$
DECLARE
  r      record;
  v_pred text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('Members can read chat media',   'SELECT', 'chat-media', 'authenticated', false),
      ('Members can upload chat media', 'INSERT', 'chat-media', 'public',        false),
      ('Members can update chat media', 'UPDATE', 'chat-media', 'public',        false),
      ('Members can delete chat media', 'DELETE', 'chat-media', 'public',        false),
      ('Members can read flow media',   'SELECT', 'flow-media', 'authenticated', true),
      ('Members can upload flow media', 'INSERT', 'flow-media', 'public',        false),
      ('Members can update flow media', 'UPDATE', 'flow-media', 'public',        true),
      ('Members can delete flow media', 'DELETE', 'flow-media', 'public',        true)
    ) AS v(pol, cmd, bucket, rol, own_folder)
  LOOP
    v_pred := format(
      'bucket_id = %L AND (EXISTS (SELECT 1 FROM public.profiles p'
      ' WHERE p.user_id = auth.uid() AND p.is_active AND p.deactivated_at IS NULL'
      ' AND p.account_role <> ''bank_guest'''
      ' AND ''account-'' || p.account_id::text = (storage.foldername(objects.name))[1])%s)',
      r.bucket,
      CASE WHEN r.own_folder
           THEN ' OR auth.uid()::text = (storage.foldername(objects.name))[1]'
           ELSE '' END);
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', r.pol);
    EXECUTE format('CREATE POLICY %I ON storage.objects FOR %s TO %s %s (%s)',
      r.pol, r.cmd, r.rol,
      CASE WHEN r.cmd = 'INSERT' THEN 'WITH CHECK' ELSE 'USING' END, v_pred);
  END LOOP;
END $$;

-- ---------- 10. grants (057 style) ----------
REVOKE ALL ON FUNCTION public.switch_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.switch_account(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.my_workspaces() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_workspaces() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.account_initials(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_initials(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.profiles_propagate_identity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.accounts_fill_short_name() FROM PUBLIC, anon, authenticated;
