-- ============================================================
-- 115_submission_groups.sql — one WhatsApp group per submission
--
-- The external submission application calls the public API when an
-- agent submits a case; we open one WhatsApp group for that case on a
-- Whapi number (the hosting number + the customer, optionally the
-- coordinator's own phone) and staff work it from the CRM. Every staff
-- message goes out from the hosting number as "Name (Label): text".
-- Port of module 018a/018b; docs: the submission-groups design.
--
--  * Four tables, separate from 114's whatsapp_groups and from
--    conversations/messages: submission_groups, submission_group_access
--    (the CRM access list, a per-group label agent / coordinator /
--    team_lead — not the account role), submission_group_messages and
--    submission_group_audit (every archive view).
--  * A group is ACTIVE or ENDED. Its identity (id, account_id,
--    submission_ref, contact_id, channel_id) never changes; wa_group_id
--    is set once and only by the holder of a create claim; an ENDED
--    group is frozen except its WhatsApp close bookkeeping
--    (wa_closed_at / wa_close_error) until the close is recorded. No
--    row of any of the four tables is ever deleted: removal from the
--    list sets removed_at once, a message is settled once, the audit
--    is append-only.
--  * Who reads (sg_rule_can_read; TS mirror
--    src/lib/submission-groups/rules.ts — change one, change both):
--      ACTIVE: on the open access list (any label), or an owner/admin
--              of the account (a live, non-guest profile there).
--      ENDED:  owner/admin, or a coordinator / team_lead on the list at
--              the end with that label, while now < ended_at + window
--              (default 60 days). Agents never. Only through the
--              audited sg_read_archive.
--    Who sends (sg_can_send): ACTIVE and on the open list — admins
--    too only if they are on it. Nobody sends into an ENDED group.
--    No caller supplies a role: it is derived from the user id.
--  * Sending writes the 'out' row BEFORE the gateway call
--    (sg_send_begin: pending, under a share lock on the group, which
--    sg_end's FOR UPDATE waits for), then settles it once: sent (with
--    wa_message_id) | blocked (opt-out / do-not-contact) | failed.
--  * Inbound is always stored, idempotent on (group_id, wa_message_id);
--    one arriving after the end is flagged post_end by the trigger
--    (never by the caller) and is hidden from every live read.
--  * Writes: no client writes any table, and the service role neither:
--    it reads the tables and writes only through the sg_* functions
--    (SECURITY DEFINER, search_path ''). authenticated reads ACTIVE
--    groups it may see in its active workspace, never post_end
--    messages, never an ENDED group directly.
--  * Hosting number: a Whapi whatsapp_config row of the group's own
--    account (submission_groups_guard; the composite FK alone would
--    take a Meta row), ON DELETE RESTRICT: a number with groups on it
--    cannot be removed, so an archive always names its number.
--
-- The SECURITY DEFINER functions read RLS-forced tables, so, as 114,
-- this must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE … IF NOT EXISTS, CREATE OR REPLACE,
-- DROP … IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '115 must be applied by a superuser or BYPASSRLS role (the sg_* functions read RLS-forced tables)';
  END IF;
END $$;

-- ---------- 1. Tables ----------

CREATE TABLE IF NOT EXISTS public.submission_groups (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              uuid NOT NULL REFERENCES public.accounts(id),
  submission_ref          text NOT NULL,
  contact_id              uuid NOT NULL,
  channel_id              uuid NOT NULL,
  subject                 text NULL,
  coordinator_phone       text NULL,
  status                  text NOT NULL DEFAULT 'ACTIVE',
  wa_group_id             text NULL,
  invite_link             text NULL,
  submission_status       text NULL,
  created_by_key          uuid NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  last_activity_at        timestamptz NOT NULL DEFAULT now(),
  ended_at                timestamptz NULL,
  end_reason              text NULL,
  wa_create_claim         uuid NULL,
  wa_create_claimed_until timestamptz NULL,
  wa_create_error         text NULL,
  wa_closed_at            timestamptz NULL,
  wa_close_error          text NULL,
  CONSTRAINT submission_groups_ref_check CHECK (
    char_length(submission_ref) BETWEEN 1 AND 128 AND btrim(submission_ref) <> ''),
  CONSTRAINT submission_groups_subject_check CHECK (subject IS NULL OR char_length(subject) <= 100),
  CONSTRAINT submission_groups_coordinator_phone_check CHECK (
    coordinator_phone IS NULL OR coordinator_phone ~ '^[0-9]{5,25}$'),
  CONSTRAINT submission_groups_status_check CHECK (status IN ('ACTIVE', 'ENDED')),
  CONSTRAINT submission_groups_wa_group_id_check CHECK (
    wa_group_id IS NULL OR wa_group_id ~ '^[0-9-]{10,31}@g\.us$'),
  CONSTRAINT submission_groups_submission_status_check CHECK (
    submission_status IS NULL OR char_length(submission_status) BETWEEN 1 AND 64),
  CONSTRAINT submission_groups_create_claim_pair CHECK (
    (wa_create_claim IS NULL) = (wa_create_claimed_until IS NULL)),
  CONSTRAINT submission_groups_ended_consistent CHECK (
    (status = 'ACTIVE' AND ended_at IS NULL) OR (status = 'ENDED' AND ended_at IS NOT NULL)),
  CONSTRAINT submission_groups_wa_closed_when_ended CHECK (wa_closed_at IS NULL OR status = 'ENDED'),
  CONSTRAINT submission_groups_one_per_submission UNIQUE (account_id, submission_ref),
  -- The target of the composite FKs below.
  CONSTRAINT submission_groups_id_account_key UNIQUE (id, account_id),
  CONSTRAINT submission_groups_contact_fkey FOREIGN KEY (contact_id, account_id)
    REFERENCES public.contacts (id, account_id),
  CONSTRAINT submission_groups_channel_fkey FOREIGN KEY (channel_id, account_id)
    REFERENCES public.whatsapp_config (id, account_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS submission_groups_account_activity_idx
  ON public.submission_groups (account_id, status, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS submission_groups_channel_group_idx
  ON public.submission_groups (channel_id, wa_group_id) WHERE wa_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS submission_groups_contact_idx
  ON public.submission_groups (contact_id);

COMMENT ON TABLE public.submission_groups IS
  'One WhatsApp group per external submission, on a Whapi number. Identity frozen, ENDED frozen, never deleted; written only through the sg_* functions. Migration 115.';
COMMENT ON COLUMN public.submission_groups.submission_ref IS
  'The submission application''s case id; unique per account.';
COMMENT ON COLUMN public.submission_groups.coordinator_phone IS
  'Digits of the coordinator''s own WhatsApp phone, the optional third participant.';
COMMENT ON COLUMN public.submission_groups.created_by_key IS
  'api_keys id of the key that opened the group (a record, not a foreign key: the archive outlives a revoked key).';
COMMENT ON COLUMN public.submission_groups.wa_create_claim IS
  'Lease on creating the WhatsApp group of a pending group (sg_claim_create); only its holder may attach wa_group_id.';

CREATE TABLE IF NOT EXISTS public.submission_group_access (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   uuid NOT NULL,
  account_id uuid NOT NULL,
  user_id    uuid NOT NULL,
  label      text NOT NULL,
  added_by   uuid NULL,
  added_at   timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz NULL,
  CONSTRAINT submission_group_access_label_check CHECK (label IN ('agent', 'coordinator', 'team_lead')),
  CONSTRAINT submission_group_access_removed_check CHECK (removed_at IS NULL OR removed_at >= added_at),
  CONSTRAINT submission_group_access_group_fkey FOREIGN KEY (group_id, account_id)
    REFERENCES public.submission_groups (id, account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS submission_group_access_open_uidx
  ON public.submission_group_access (group_id, user_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS submission_group_access_user_idx
  ON public.submission_group_access (user_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS submission_group_access_group_idx
  ON public.submission_group_access (group_id, user_id);

COMMENT ON TABLE public.submission_group_access IS
  'The CRM access list of a submission group (auth.users ids, a per-group label). A removal sets removed_at once; rows are never deleted. Migration 115.';

CREATE TABLE IF NOT EXISTS public.submission_group_messages (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id       uuid NOT NULL,
  account_id     uuid NOT NULL,
  direction      text NOT NULL,
  sender_user_id uuid NULL,
  sender_wa_id   text NULL,
  sender_kind    text NULL,
  type           text NOT NULL DEFAULT 'text',
  body           text NULL,
  prefixed_body  text NULL,
  media          jsonb NULL,
  wa_message_id  text NULL,
  wa_timestamp   timestamptz NULL,
  -- 'out' only: pending (written before the send) -> sent | blocked | failed.
  send_status    text NULL,
  -- 'in' only: arrived after the group left ACTIVE (set by the trigger).
  post_end       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT submission_group_messages_direction_check CHECK (direction IN ('in', 'out')),
  CONSTRAINT submission_group_messages_type_check CHECK (char_length(type) BETWEEN 1 AND 32),
  CONSTRAINT submission_group_messages_media_check CHECK (media IS NULL OR jsonb_typeof(media) = 'object'),
  CONSTRAINT submission_group_messages_sender_wa_id_check CHECK (
    sender_wa_id IS NULL OR sender_wa_id ~ '^[0-9]{5,25}(@lid)?$'),
  CONSTRAINT submission_group_messages_sender_kind_check CHECK (
    sender_kind IS NULL OR sender_kind IN ('customer', 'coordinator', 'other')),
  CONSTRAINT submission_group_messages_out_attributed CHECK (
    direction = 'in'
    OR (sender_user_id IS NOT NULL AND body IS NOT NULL AND prefixed_body IS NOT NULL
        AND sender_wa_id IS NULL AND sender_kind IS NULL)),
  CONSTRAINT submission_group_messages_in_shape CHECK (
    direction = 'out'
    OR (wa_message_id IS NOT NULL AND sender_kind IS NOT NULL
        AND sender_user_id IS NULL AND prefixed_body IS NULL)),
  CONSTRAINT submission_group_messages_send_status CHECK (
    (direction = 'in' AND send_status IS NULL)
    OR (direction = 'out' AND send_status IN ('pending', 'sent', 'blocked', 'failed')
        AND (send_status = 'sent') = (wa_message_id IS NOT NULL))),
  CONSTRAINT submission_group_messages_group_message_key UNIQUE (group_id, wa_message_id),
  CONSTRAINT submission_group_messages_group_fkey FOREIGN KEY (group_id, account_id)
    REFERENCES public.submission_groups (id, account_id)
);

CREATE INDEX IF NOT EXISTS submission_group_messages_group_created_idx
  ON public.submission_group_messages (group_id, created_at, id);
CREATE INDEX IF NOT EXISTS submission_group_messages_pending_idx
  ON public.submission_group_messages (created_at) WHERE send_status = 'pending';

COMMENT ON TABLE public.submission_group_messages IS
  'A submission group''s messages. out: born pending, settled once. in: idempotent on (group_id, wa_message_id), post_end set by the trigger. Never edited or deleted. Migration 115.';

CREATE TABLE IF NOT EXISTS public.submission_group_audit (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id    uuid NOT NULL,
  account_id  uuid NOT NULL,
  user_id     uuid NOT NULL,
  role        text NOT NULL,
  viewed_at   timestamptz NOT NULL DEFAULT now(),
  window_days integer NOT NULL DEFAULT 60,
  CONSTRAINT submission_group_audit_role_check CHECK (role IN ('owner', 'admin', 'coordinator', 'team_lead')),
  CONSTRAINT submission_group_audit_window_check CHECK (window_days >= 0),
  CONSTRAINT submission_group_audit_group_fkey FOREIGN KEY (group_id, account_id)
    REFERENCES public.submission_groups (id, account_id)
);

CREATE INDEX IF NOT EXISTS submission_group_audit_group_idx
  ON public.submission_group_audit (group_id, viewed_at);

COMMENT ON TABLE public.submission_group_audit IS
  'Append-only log of archive views (sg_read_archive). An insert is re-decided by its trigger with viewed_at and window_days. Migration 115.';

-- ---------- 2. Rules and predicates ----------

-- The pure rule. p_role: owner/admin (archive reader) or the access
-- label agent/coordinator/team_lead, or NULL. The ENDED supervisor
-- window: a NULL clock, end or window, or a negative window, closes it.
-- TS mirror: canRead in src/lib/submission-groups/rules.ts.
CREATE OR REPLACE FUNCTION public.sg_rule_can_read(
  p_status text, p_role text, p_on_list boolean, p_on_list_at_end boolean,
  p_ended_at timestamptz, p_now timestamptz, p_window_days int)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT coalesce(CASE p_status
    WHEN 'ACTIVE' THEN p_role IN ('owner', 'admin')
                    OR (coalesce(p_on_list, false) AND p_role IN ('agent', 'coordinator', 'team_lead'))
    WHEN 'ENDED'  THEN p_role IN ('owner', 'admin')
                    OR (p_role IN ('coordinator', 'team_lead') AND coalesce(p_on_list_at_end, false)
                        AND coalesce(p_window_days >= 0
                                     AND p_now < p_ended_at + make_interval(hours => 24 * p_window_days), false))
  END, false)
$$;

-- 'owner' / 'admin' for a live, non-guest owner/admin profile in the
-- account (not necessarily the active one), else NULL.
CREATE OR REPLACE FUNCTION public.sg_archive_role(p_account uuid, p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.account_role::text FROM public.profiles p
   WHERE p.user_id = p_user AND p.account_id = p_account
     AND p.deactivated_at IS NULL
     AND p.account_role IN ('owner', 'admin')
   LIMIT 1
$$;

-- A live staff member of the account, agent and up (never a viewer or a
-- bank guest): who may be on an access list, and send.
CREATE OR REPLACE FUNCTION public.sg_is_staff(p_account uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.user_id = p_user AND p.account_id = p_account
                    AND p.deactivated_at IS NULL
                    AND p.account_role IN ('agent', 'team_leader', 'admin', 'owner'))
$$;

-- 'owner'/'admin' if an archive reader, else the open access label, else NULL.
CREATE OR REPLACE FUNCTION public.sg_resolve_role(p_group uuid, p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(public.sg_archive_role(g.account_id, p_user),
                  (SELECT a.label FROM public.submission_group_access a
                    WHERE a.group_id = g.id AND a.user_id = p_user AND a.removed_at IS NULL))
    FROM public.submission_groups g WHERE g.id = p_group
$$;

-- The role that lets p_user read the group at p_now, or NULL. On an
-- ENDED group a non-admin's role is the label of their row on the list
-- at the end: added by ended_at and not removed before it (sg_end
-- closes the open rows with removed_at = ended_at).
CREATE OR REPLACE FUNCTION public.sg_read_role(p_group uuid, p_user uuid, p_now timestamptz, p_window_days int)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  g      public.submission_groups%ROWTYPE;
  v_role text;
  v_open boolean := false;
BEGIN
  SELECT * INTO g FROM public.submission_groups WHERE id = p_group;
  IF NOT FOUND OR p_user IS NULL THEN
    RETURN NULL;
  END IF;
  v_role := public.sg_archive_role(g.account_id, p_user);
  IF v_role IS NULL AND public.sg_is_staff(g.account_id, p_user) THEN
    IF g.status = 'ACTIVE' THEN
      SELECT a.label INTO v_role FROM public.submission_group_access a
       WHERE a.group_id = g.id AND a.user_id = p_user AND a.removed_at IS NULL;
      v_open := v_role IS NOT NULL;
    ELSE
      SELECT a.label INTO v_role FROM public.submission_group_access a
       WHERE a.group_id = g.id AND a.user_id = p_user
         AND a.added_at <= g.ended_at AND (a.removed_at IS NULL OR a.removed_at >= g.ended_at)
       ORDER BY a.added_at DESC LIMIT 1;
    END IF;
  END IF;
  IF public.sg_rule_can_read(g.status, v_role, v_open, v_role IS NOT NULL, g.ended_at,
                             coalesce(p_now, now()), p_window_days) THEN
    RETURN v_role;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.sg_can_read(p_group uuid, p_user uuid,
  p_now timestamptz DEFAULT NULL, p_window_days int DEFAULT 60)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.sg_read_role(p_group, p_user, p_now, p_window_days) IS NOT NULL
$$;

-- ACTIVE, on the open list, and still a live staff member of the
-- account. Opt-out / do-not-contact is not checked here: a refused send
-- is settled 'blocked'.
CREATE OR REPLACE FUNCTION public.sg_can_send(p_group uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce((
    SELECT g.status = 'ACTIVE'
       AND public.sg_is_staff(g.account_id, p_user)
       AND EXISTS (SELECT 1 FROM public.submission_group_access a
                    WHERE a.group_id = g.id AND a.user_id = p_user AND a.removed_at IS NULL)
      FROM public.submission_groups g WHERE g.id = p_group), false)
$$;

-- The groups the caller may see live: ACTIVE groups of the active
-- workspace that they are on the open list of, or all of them for an
-- owner/admin. Empty for a guest or deactivated row. Read once per
-- query by the policies.
CREATE OR REPLACE FUNCTION public.sg_visible_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT g.id FROM public.submission_groups g
   WHERE g.account_id = public.current_account_id()
     AND g.status = 'ACTIVE'
     AND (public.is_account_member(g.account_id, 'admin')
          OR EXISTS (SELECT 1 FROM public.submission_group_access a
                      WHERE a.group_id = g.id AND a.user_id = auth.uid() AND a.removed_at IS NULL))
$$;

-- ---------- 3. Integrity (every writer) ----------

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
    SELECT w.account_id, w.provider INTO v_account, v_provider
      FROM public.whatsapp_config w WHERE w.id = NEW.channel_id;
    IF v_account IS DISTINCT FROM NEW.account_id OR v_provider IS DISTINCT FROM 'whapi' THEN
      RAISE EXCEPTION 'public.submission_groups: the hosting number must be a Whapi number of the group''s workspace'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> 'ACTIVE' OR NEW.wa_group_id IS NOT NULL OR NEW.wa_create_claim IS NOT NULL THEN
      RAISE EXCEPTION 'public.submission_groups: a group is inserted ACTIVE, unclaimed and without a WhatsApp group'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.submission_ref IS DISTINCT FROM OLD.submission_ref
       OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
       OR NEW.channel_id IS DISTINCT FROM OLD.channel_id THEN
      RAISE EXCEPTION 'public.submission_groups: the group identity is fixed (id, account_id, submission_ref, contact_id, channel_id; UPDATE refused)'
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

DROP TRIGGER IF EXISTS submission_groups_guard ON public.submission_groups;
CREATE TRIGGER submission_groups_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.submission_groups
  FOR EACH ROW EXECUTE FUNCTION public.submission_groups_guard();

-- Nothing new in an archived workspace (105).
DROP TRIGGER IF EXISTS submission_groups_archived_guard ON public.submission_groups;
CREATE TRIGGER submission_groups_archived_guard
  BEFORE INSERT OR UPDATE OF account_id ON public.submission_groups
  FOR EACH ROW EXECUTE FUNCTION public.archived_workspace_connect_guard();

-- Rows of these tables are never removed, so TRUNCATE (which skips row
-- triggers) is refused too, the table owner included.
CREATE OR REPLACE FUNCTION public.submission_group_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'public.%: TRUNCATE refused (rows are never removed)', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS submission_groups_no_truncate ON public.submission_groups;
CREATE TRIGGER submission_groups_no_truncate
  BEFORE TRUNCATE ON public.submission_groups
  FOR EACH STATEMENT EXECUTE FUNCTION public.submission_group_no_truncate();

-- The access list: a new row only on an ACTIVE group, for a live staff
-- member (agent and up) of the group's account. The one change is
-- closing an open row once (removed_at); on an ENDED group only sg_end's
-- close at ended_at. Never deleted.
CREATE OR REPLACE FUNCTION public.submission_group_access_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  g public.submission_groups%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'public.submission_group_access: DELETE refused (a removal sets removed_at)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO g FROM public.submission_groups WHERE id = NEW.group_id FOR SHARE;
  IF TG_OP = 'INSERT' THEN
    IF g.status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'public.submission_group_access: the group is not ACTIVE (INSERT refused)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'public.submission_group_access: a row is inserted open'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT public.sg_is_staff(NEW.account_id, NEW.user_id) THEN
      RAISE EXCEPTION 'public.submission_group_access: only a live agent, team leader, admin or owner of the group''s workspace can be on the list'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL
     AND (to_jsonb(NEW) - 'removed_at') = (to_jsonb(OLD) - 'removed_at')
     AND (g.status = 'ACTIVE' OR NEW.removed_at = g.ended_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'public.submission_group_access: UPDATE refused (only closing an open row once)'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS submission_group_access_guard ON public.submission_group_access;
CREATE TRIGGER submission_group_access_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.submission_group_access
  FOR EACH ROW EXECUTE FUNCTION public.submission_group_access_guard();
DROP TRIGGER IF EXISTS submission_group_access_no_truncate ON public.submission_group_access;
CREATE TRIGGER submission_group_access_no_truncate
  BEFORE TRUNCATE ON public.submission_group_access
  FOR EACH STATEMENT EXECUTE FUNCTION public.submission_group_no_truncate();

-- An 'out' row is born pending without wa_message_id, only into an
-- ACTIVE group, under a share lock (sg_end's FOR UPDATE waits). An 'in'
-- row is always kept; post_end records, under the lock, whether the
-- group had already left ACTIVE — decided here only (the caller's value
-- is overwritten) and never changed. 'in' takes the row lock up front
-- because the bump below updates the group: a share lock upgraded by
-- two concurrent inbounds would deadlock.
CREATE OR REPLACE FUNCTION public.submission_group_messages_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_status text;
BEGIN
  IF NEW.direction = 'out' THEN
    IF NEW.send_status IS DISTINCT FROM 'pending' OR NEW.wa_message_id IS NOT NULL THEN
      RAISE EXCEPTION 'submission group message: an out row is inserted pending, without wa_message_id'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT g.status INTO v_status FROM public.submission_groups g WHERE g.id = NEW.group_id FOR SHARE;
    IF v_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'submission group % is %: sending refused', NEW.group_id, coalesce(v_status, 'missing')
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.post_end := false;
  ELSE
    SELECT g.status INTO v_status FROM public.submission_groups g WHERE g.id = NEW.group_id FOR NO KEY UPDATE;
    NEW.post_end := v_status IS DISTINCT FROM 'ACTIVE';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS submission_group_messages_guard ON public.submission_group_messages;
CREATE TRIGGER submission_group_messages_guard
  BEFORE INSERT ON public.submission_group_messages
  FOR EACH ROW EXECUTE FUNCTION public.submission_group_messages_guard();

-- The one change: a pending 'out' row settled once, pending -> sent
-- (with wa_message_id) | blocked | failed (without); nothing else.
CREATE OR REPLACE FUNCTION public.submission_group_messages_settle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.send_status = 'pending'
     AND NEW.send_status IN ('sent', 'blocked', 'failed')
     AND (NEW.send_status = 'sent') = (NEW.wa_message_id IS NOT NULL)
     AND (to_jsonb(NEW) - 'send_status' - 'wa_message_id') = (to_jsonb(OLD) - 'send_status' - 'wa_message_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'public.submission_group_messages: % refused (only pending -> sent | blocked | failed, once)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS submission_group_messages_settle ON public.submission_group_messages;
CREATE TRIGGER submission_group_messages_settle
  BEFORE UPDATE OR DELETE ON public.submission_group_messages
  FOR EACH ROW EXECUTE FUNCTION public.submission_group_messages_settle();
DROP TRIGGER IF EXISTS submission_group_messages_no_truncate ON public.submission_group_messages;
CREATE TRIGGER submission_group_messages_no_truncate
  BEFORE TRUNCATE ON public.submission_group_messages
  FOR EACH STATEMENT EXECUTE FUNCTION public.submission_group_no_truncate();

-- An inbound row and a 'sent' settle move last_activity_at forward, on
-- an ACTIVE group only (an ENDED group is frozen). A replayed inbound
-- (ON CONFLICT DO NOTHING) inserts nothing and bumps nothing.
CREATE OR REPLACE FUNCTION public.submission_group_messages_bump()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.direction = 'in')
     OR (TG_OP = 'UPDATE' AND NEW.send_status = 'sent') THEN
    UPDATE public.submission_groups
       SET last_activity_at = clock_timestamp()
     WHERE id = NEW.group_id AND status = 'ACTIVE' AND last_activity_at < clock_timestamp();
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS submission_group_messages_bump ON public.submission_group_messages;
CREATE TRIGGER submission_group_messages_bump
  AFTER INSERT OR UPDATE ON public.submission_group_messages
  FOR EACH ROW EXECUTE FUNCTION public.submission_group_messages_bump();

-- An audit row only for an allowed archive view of an ENDED group,
-- re-decided at viewed_at under window_days, with the role that view
-- was allowed by. Never changed.
CREATE OR REPLACE FUNCTION public.submission_group_audit_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.submission_groups g WHERE g.id = NEW.group_id AND g.status = 'ENDED')
     OR public.sg_read_role(NEW.group_id, NEW.user_id, NEW.viewed_at, NEW.window_days) IS DISTINCT FROM NEW.role THEN
    RAISE EXCEPTION 'archive view of % by % (%) not allowed', NEW.group_id, NEW.user_id, NEW.role
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.submission_group_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'public.% is append-only (% refused)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS submission_group_audit_check ON public.submission_group_audit;
CREATE TRIGGER submission_group_audit_check
  BEFORE INSERT ON public.submission_group_audit
  FOR EACH ROW EXECUTE FUNCTION public.submission_group_audit_check();
DROP TRIGGER IF EXISTS submission_group_audit_append_only ON public.submission_group_audit;
CREATE TRIGGER submission_group_audit_append_only
  BEFORE UPDATE OR DELETE ON public.submission_group_audit
  FOR EACH ROW EXECUTE FUNCTION public.submission_group_append_only();
DROP TRIGGER IF EXISTS submission_group_audit_no_truncate ON public.submission_group_audit;
CREATE TRIGGER submission_group_audit_no_truncate
  BEFORE TRUNCATE ON public.submission_group_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.submission_group_append_only();

-- ---------- 4. The store contract (service role) ----------

-- Idempotent per (account, ref): an existing group is returned
-- unchanged (its access list is not rewritten). p_access:
-- [{user_id, label}]. Consent (opt-out / do-not-contact) is the
-- caller's check before it calls this.
CREATE OR REPLACE FUNCTION public.sg_open(p_account uuid, p_submission_ref text, p_contact uuid,
  p_channel uuid, p_subject text, p_coordinator_phone text, p_access jsonb, p_key uuid)
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
    (account_id, submission_ref, contact_id, channel_id, subject, coordinator_phone, created_by_key)
  VALUES (p_account, p_submission_ref, p_contact, p_channel, p_subject, p_coordinator_phone, p_key)
  ON CONFLICT ON CONSTRAINT submission_groups_one_per_submission DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    INSERT INTO public.submission_group_access (group_id, account_id, user_id, label)
    SELECT v_id, p_account, x.user_id, x.label
      FROM jsonb_to_recordset(coalesce(p_access, '[]'::jsonb)) AS x(user_id uuid, label text);
    RETURN QUERY SELECT v_id, true;
    RETURN;
  END IF;
  RETURN QUERY SELECT g.id, false FROM public.submission_groups g
   WHERE g.account_id = p_account AND g.submission_ref = p_submission_ref;
END;
$$;

-- A lease on creating a pending group's WhatsApp group (ACTIVE, no
-- wa_group_id). Succeeds only with no unexpired claim; expiry by p_now
-- else the DB clock. Returns the token, or NULL.
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
   WHERE id = p_group AND status = 'ACTIVE' AND wa_group_id IS NULL
     AND (wa_create_claimed_until IS NULL OR wa_create_claimed_until <= coalesce(p_now, now()))
  RETURNING wa_create_claim
$$;

-- Gives up a claim (only the holder's token); p_error, when given, is
-- recorded as the last create failure.
CREATE OR REPLACE FUNCTION public.sg_release_create_claim(p_group uuid, p_token uuid, p_error text DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH u AS (
    UPDATE public.submission_groups
       SET wa_create_claim = NULL, wa_create_claimed_until = NULL,
           wa_create_error = coalesce(p_error, wa_create_error)
     WHERE id = p_group AND wa_create_claim = p_token AND status = 'ACTIVE'
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

-- Saves the WhatsApp group id once, for the holder of the claim, and
-- clears the claim and the last create error.
CREATE OR REPLACE FUNCTION public.sg_attach_wa_group(p_group uuid, p_wa_group_id text, p_invite_link text, p_token uuid)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH u AS (
    UPDATE public.submission_groups
       SET wa_group_id = p_wa_group_id, invite_link = p_invite_link,
           wa_create_claim = NULL, wa_create_claimed_until = NULL, wa_create_error = NULL
     WHERE id = p_group AND wa_group_id IS NULL AND status = 'ACTIVE' AND wa_create_claim = p_token
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

-- BEFORE the gateway call: under a share lock on the group, re-checks
-- sg_can_send and writes the 'out' row pending. NULL = refused, nothing
-- may be sent.
CREATE OR REPLACE FUNCTION public.sg_send_begin(p_group uuid, p_user uuid, p_body text, p_prefixed text)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
  v_id      bigint;
BEGIN
  SELECT g.account_id INTO v_account FROM public.submission_groups g WHERE g.id = p_group FOR SHARE;
  IF v_account IS NULL OR NOT public.sg_can_send(p_group, p_user) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.submission_group_messages
    (group_id, account_id, direction, sender_user_id, body, prefixed_body, send_status)
  VALUES (p_group, v_account, 'out', p_user, p_body, p_prefixed, 'pending')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- AFTER the send attempt: pending -> sent | blocked | failed, once.
-- False if the row is not a pending 'out' row.
CREATE OR REPLACE FUNCTION public.sg_settle_send(p_message bigint, p_status text, p_wa_message_id text)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH u AS (
    UPDATE public.submission_group_messages
       SET send_status = p_status,
           wa_message_id = CASE WHEN p_status = 'sent' THEN p_wa_message_id END
     WHERE id = p_message AND direction = 'out' AND send_status = 'pending'
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

-- Stores an inbound message (post_end decided by the trigger). False =
-- a duplicate of (group, wa_message_id).
CREATE OR REPLACE FUNCTION public.sg_record_inbound(p_group uuid, p_wa_message_id text, p_sender_wa_id text,
  p_sender_kind text, p_type text, p_body text, p_media jsonb, p_wa_timestamp timestamptz)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
  v_id      bigint;
BEGIN
  SELECT g.account_id INTO v_account FROM public.submission_groups g WHERE g.id = p_group;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'submission group % not found', p_group USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO public.submission_group_messages
    (group_id, account_id, direction, sender_wa_id, sender_kind, type, body, media, wa_message_id, wa_timestamp)
  VALUES (p_group, v_account, 'in', p_sender_wa_id, p_sender_kind, coalesce(p_type, 'text'), p_body, p_media,
          p_wa_message_id, p_wa_timestamp)
  ON CONFLICT ON CONSTRAINT submission_group_messages_group_message_key DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

-- ACTIVE -> ENDED and closes every open access row at ended_at. True if
-- this call ended it. FOR UPDATE waits for a send_begin in flight.
-- clock_timestamp(), not now(): a removal earlier in the same
-- transaction must fall before the end.
CREATE OR REPLACE FUNCTION public.sg_end(p_group uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_at timestamptz;
BEGIN
  PERFORM 1 FROM public.submission_groups WHERE id = p_group AND status = 'ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  v_at := clock_timestamp();
  UPDATE public.submission_groups
     SET status = 'ENDED', ended_at = v_at, end_reason = p_reason
   WHERE id = p_group;
  UPDATE public.submission_group_access
     SET removed_at = v_at
   WHERE group_id = p_group AND removed_at IS NULL;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.sg_mark_wa_closed(p_group uuid)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH u AS (
    UPDATE public.submission_groups SET wa_closed_at = now(), wa_close_error = NULL
     WHERE id = p_group AND status = 'ENDED' AND wa_closed_at IS NULL
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

CREATE OR REPLACE FUNCTION public.sg_record_wa_close_error(p_group uuid, p_error text)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH u AS (
    UPDATE public.submission_groups SET wa_close_error = p_error
     WHERE id = p_group AND status = 'ENDED' AND wa_closed_at IS NULL
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

CREATE OR REPLACE FUNCTION public.sg_count_pending_out(p_group uuid)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT count(*)::int FROM public.submission_group_messages
   WHERE group_id = p_group AND direction = 'out' AND send_status = 'pending'
$$;

-- Every 'out' row (any group) pending since before p_now - p_older_than_ms
-- -> failed, so a crashed sender cannot hold a close. Returns the ids.
CREATE OR REPLACE FUNCTION public.sg_fail_stale_pending(p_older_than_ms int, p_now timestamptz DEFAULT NULL)
RETURNS SETOF bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.submission_group_messages SET send_status = 'failed'
   WHERE direction = 'out' AND send_status = 'pending'
     AND created_at < coalesce(p_now, now()) - make_interval(secs => p_older_than_ms::double precision / 1000)
  RETURNING id
$$;

-- The only archive read. For an ENDED group p_user may read (sg_read_role
-- at p_now under p_window_days) it writes the audit row and returns
-- {allowed: true, role, messages: [...]}, post_end rows included and
-- flagged; otherwise {allowed: false, messages: []} and no audit row.
CREATE OR REPLACE FUNCTION public.sg_read_archive(p_group uuid, p_user uuid,
  p_now timestamptz DEFAULT NULL, p_window_days int DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
  v_role    text;
  v_now     timestamptz := coalesce(p_now, now());
BEGIN
  SELECT g.account_id INTO v_account FROM public.submission_groups g
   WHERE g.id = p_group AND g.status = 'ENDED';
  IF v_account IS NOT NULL THEN
    v_role := public.sg_read_role(p_group, p_user, v_now, p_window_days);
  END IF;
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'messages', '[]'::jsonb);
  END IF;
  INSERT INTO public.submission_group_audit (group_id, account_id, user_id, role, viewed_at, window_days)
  VALUES (p_group, v_account, p_user, v_role, v_now, p_window_days);
  RETURN jsonb_build_object(
    'allowed', true,
    'role', v_role,
    'messages', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', m.id, 'direction', m.direction, 'sender_user_id', m.sender_user_id,
               'sender_wa_id', m.sender_wa_id, 'sender_kind', m.sender_kind, 'type', m.type,
               'body', m.body, 'prefixed_body', m.prefixed_body, 'media', m.media,
               'wa_message_id', m.wa_message_id, 'wa_timestamp', m.wa_timestamp,
               'send_status', m.send_status, 'post_end', m.post_end, 'created_at', m.created_at)
             ORDER BY m.created_at, m.id)
        FROM public.submission_group_messages m WHERE m.group_id = p_group), '[]'::jsonb));
END;
$$;

-- Adds p_user with p_label, or relabels (closes the open row, opens a
-- new one at the same instant). ACTIVE only. Same label: no change.
CREATE OR REPLACE FUNCTION public.sg_access_set(p_group uuid, p_user uuid, p_label text, p_by uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
  v_label   text;
  v_at      timestamptz := clock_timestamp();
BEGIN
  SELECT g.account_id INTO v_account FROM public.submission_groups g
   WHERE g.id = p_group AND g.status = 'ACTIVE' FOR UPDATE;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'submission group % is not ACTIVE', p_group USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT a.label INTO v_label FROM public.submission_group_access a
   WHERE a.group_id = p_group AND a.user_id = p_user AND a.removed_at IS NULL;
  IF v_label IS NOT DISTINCT FROM p_label THEN
    RETURN;
  END IF;
  IF v_label IS NOT NULL THEN
    UPDATE public.submission_group_access SET removed_at = v_at
     WHERE group_id = p_group AND user_id = p_user AND removed_at IS NULL;
  END IF;
  INSERT INTO public.submission_group_access (group_id, account_id, user_id, label, added_by, added_at)
  VALUES (p_group, v_account, p_user, p_label, p_by, v_at);
END;
$$;

-- Closes p_user's open row. ACTIVE only. False if there was none.
CREATE OR REPLACE FUNCTION public.sg_access_remove(p_group uuid, p_user uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public.submission_groups g WHERE g.id = p_group AND g.status = 'ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission group % is not ACTIVE', p_group USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE public.submission_group_access SET removed_at = clock_timestamp()
   WHERE group_id = p_group AND user_id = p_user AND removed_at IS NULL;
  RETURN FOUND;
END;
$$;

-- ---------- 5. Row-level security ----------

ALTER TABLE public.submission_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submission_groups FORCE ROW LEVEL SECURITY;
ALTER TABLE public.submission_group_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submission_group_access FORCE ROW LEVEL SECURITY;
ALTER TABLE public.submission_group_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submission_group_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE public.submission_group_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submission_group_audit FORCE ROW LEVEL SECURITY;

-- SELECT only. sg_visible_ids is ACTIVE-only: nobody, the supervisor
-- window and admins included, reads an ENDED group directly.
DROP POLICY IF EXISTS submission_groups_select ON public.submission_groups;
CREATE POLICY submission_groups_select ON public.submission_groups FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND id IN (SELECT public.sg_visible_ids()));

DROP POLICY IF EXISTS submission_group_access_select ON public.submission_group_access;
CREATE POLICY submission_group_access_select ON public.submission_group_access FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND group_id IN (SELECT public.sg_visible_ids()));

DROP POLICY IF EXISTS submission_group_messages_select ON public.submission_group_messages;
CREATE POLICY submission_group_messages_select ON public.submission_group_messages FOR SELECT TO authenticated
  USING (NOT post_end
         AND account_id = (SELECT public.current_account_id())
         AND group_id IN (SELECT public.sg_visible_ids()));

DROP POLICY IF EXISTS submission_group_audit_select ON public.submission_group_audit;
CREATE POLICY submission_group_audit_select ON public.submission_group_audit FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.is_account_member(account_id, 'admin'));

-- ---------- 6. Privileges ----------

-- Start from nothing (a new table and function grant anon,
-- authenticated and service_role everything by default), then grant the
-- minimum: reads to authenticated and service_role, writes to nobody —
-- the service role writes through the sg_* functions.
REVOKE ALL ON public.submission_groups, public.submission_group_access,
  public.submission_group_messages, public.submission_group_audit
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.submission_group_messages_id_seq, public.submission_group_audit_id_seq
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.submission_groups, public.submission_group_access,
  public.submission_group_messages, public.submission_group_audit
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.sg_rule_can_read(text, text, boolean, boolean, timestamptz, timestamptz, int),
  public.sg_archive_role(uuid, uuid),
  public.sg_is_staff(uuid, uuid),
  public.sg_resolve_role(uuid, uuid),
  public.sg_read_role(uuid, uuid, timestamptz, int),
  public.sg_can_read(uuid, uuid, timestamptz, int),
  public.sg_can_send(uuid, uuid),
  public.sg_visible_ids(),
  public.sg_open(uuid, text, uuid, uuid, text, text, jsonb, uuid),
  public.sg_claim_create(uuid, int, timestamptz),
  public.sg_release_create_claim(uuid, uuid, text),
  public.sg_attach_wa_group(uuid, text, text, uuid),
  public.sg_send_begin(uuid, uuid, text, text),
  public.sg_settle_send(bigint, text, text),
  public.sg_record_inbound(uuid, text, text, text, text, text, jsonb, timestamptz),
  public.sg_end(uuid, text),
  public.sg_mark_wa_closed(uuid),
  public.sg_record_wa_close_error(uuid, text),
  public.sg_count_pending_out(uuid),
  public.sg_fail_stale_pending(int, timestamptz),
  public.sg_read_archive(uuid, uuid, timestamptz, int),
  public.sg_access_set(uuid, uuid, text, uuid),
  public.sg_access_remove(uuid, uuid),
  public.submission_groups_guard(),
  public.submission_group_no_truncate(),
  public.submission_group_access_guard(),
  public.submission_group_messages_guard(),
  public.submission_group_messages_settle(),
  public.submission_group_messages_bump(),
  public.submission_group_audit_check(),
  public.submission_group_append_only()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.sg_rule_can_read(text, text, boolean, boolean, timestamptz, timestamptz, int),
  public.sg_resolve_role(uuid, uuid),
  public.sg_can_read(uuid, uuid, timestamptz, int),
  public.sg_can_send(uuid, uuid),
  public.sg_open(uuid, text, uuid, uuid, text, text, jsonb, uuid),
  public.sg_claim_create(uuid, int, timestamptz),
  public.sg_release_create_claim(uuid, uuid, text),
  public.sg_attach_wa_group(uuid, text, text, uuid),
  public.sg_send_begin(uuid, uuid, text, text),
  public.sg_settle_send(bigint, text, text),
  public.sg_record_inbound(uuid, text, text, text, text, text, jsonb, timestamptz),
  public.sg_end(uuid, text),
  public.sg_mark_wa_closed(uuid),
  public.sg_record_wa_close_error(uuid, text),
  public.sg_count_pending_out(uuid),
  public.sg_fail_stale_pending(int, timestamptz),
  public.sg_read_archive(uuid, uuid, timestamptz, int),
  public.sg_access_set(uuid, uuid, text, uuid),
  public.sg_access_remove(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.sg_rule_can_read(text, text, boolean, boolean, timestamptz, timestamptz, int),
  public.sg_visible_ids()
  TO authenticated;

RESET lock_timeout;
