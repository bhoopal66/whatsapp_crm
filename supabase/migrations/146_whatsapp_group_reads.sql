-- ============================================================
-- 146_whatsapp_group_reads.sql — per-person read markers for groups
--
-- 114's groups had no read state, so the sidebar could not say which
-- groups hold something new. A person now has one read marker per
-- group, and the sidebar's Groups item counts the groups with an
-- inbound message that arrived after the caller's marker.
--
--  * whatsapp_group_reads: (group_id, user_id) -> last_read_at. A row
--    is only ever moved forward (greatest of the stored and now()), so
--    two tabs racing never move a marker back. Composite FK to
--    whatsapp_groups (id, account_id) as in 114; a deleted group or
--    user takes its markers with it.
--  * Writes: whatsapp_group_mark_read(p_group) only (SECURITY DEFINER).
--    It refuses (42501) a group whatsapp_group_can_view does not show
--    the caller, so a marker never exists for a group the person
--    cannot see. Clients read their own rows and write none.
--  * The count: whatsapp_group_unread_count(), SECURITY INVOKER. Every
--    table it reads already has a policy (114's visible set for groups
--    and messages, own rows for the markers), so running as the caller
--    adds no new read path; it still names the active account and the
--    visible set itself so the plan starts from the caller's groups.
--    A group we left (our_role = 'left') never counts: nothing new can
--    arrive there and the list files it away.
--  * Arrival, not send time: whatsapp_group_messages.received_at is
--    when the row arrived here (DEFAULT now()). created_at is
--    WhatsApp's send time (the webhook sets it from the message's
--    timestamp), and last_read_at is our clock at the open, so
--    comparing those two missed a message sent before an open that
--    arrived after it (phone offline, gateway backlog), and a sender
--    clock running ahead re-lit a group just opened. Existing rows are
--    backfilled with their created_at, not the migration time, which
--    would light every group under the no-marker rule below.
--  * No marker yet: read up to 7 days ago. Without that rule every
--    group with any inbound message would light up for every person
--    the day this ships, and a marker cannot be backfilled per person
--    cheaply. Seven days keeps a group that is genuinely active this
--    week visible to someone who never opened it, and lets older
--    history stay quiet. Opening the group writes the marker.
--
-- The SECURITY DEFINER function writes an RLS-forced table, so, as in
-- 114, this must be applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: CREATE … IF NOT EXISTS, ADD COLUMN IF NOT EXISTS (the
-- backfill touches only NULLs), CREATE OR REPLACE, DROP … IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '146 must be applied by a superuser or BYPASSRLS role (whatsapp_group_mark_read writes an RLS-forced table)';
  END IF;
END $$;

-- ---------- 1. The markers ----------

CREATE TABLE IF NOT EXISTS public.whatsapp_group_reads (
  group_id     uuid NOT NULL,
  account_id   uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL,
  PRIMARY KEY (group_id, user_id),
  CONSTRAINT whatsapp_group_reads_group_fkey FOREIGN KEY (group_id, account_id)
    REFERENCES public.whatsapp_groups (id, account_id) ON DELETE CASCADE
);

-- The count reads one person's markers in one workspace.
CREATE INDEX IF NOT EXISTS whatsapp_group_reads_user_idx
  ON public.whatsapp_group_reads (user_id, account_id);

COMMENT ON TABLE public.whatsapp_group_reads IS
  'Per-person read marker of a WhatsApp group (auth.users ids). Written only by whatsapp_group_mark_read, forward-only. Migration 146; docs/whatsapp-groups.md.';
COMMENT ON COLUMN public.whatsapp_group_reads.last_read_at IS
  'When the person last opened the group (our clock). An inbound message whose received_at is later makes the group unread for them (whatsapp_group_unread_count).';

-- ---------- 1b. When a message arrived here ----------

-- Added without a default, backfilled from created_at, then defaulted:
-- adding it WITH DEFAULT now() would stamp every existing row with the
-- migration time and light every group. One block, so no insert lands
-- between the backfill and SET NOT NULL with a NULL in it. No trigger
-- on this table guards its columns (114 has only the AFTER INSERT
-- bump), and the writers name their columns, so none sends this one:
-- an insert takes the default and a redelivery (ON CONFLICT DO
-- NOTHING) keeps the first arrival.
DO $$
BEGIN
  ALTER TABLE public.whatsapp_group_messages ADD COLUMN IF NOT EXISTS received_at timestamptz;
  UPDATE public.whatsapp_group_messages SET received_at = created_at WHERE received_at IS NULL;
  ALTER TABLE public.whatsapp_group_messages ALTER COLUMN received_at SET DEFAULT now();
  ALTER TABLE public.whatsapp_group_messages ALTER COLUMN received_at SET NOT NULL;
END
$$;

COMMENT ON COLUMN public.whatsapp_group_messages.received_at IS
  'When the row arrived here; the read markers compare against it, not WhatsApp''s send time (created_at). Existing rows were backfilled with created_at. Migration 146.';

-- "Has an inbound message arrived after T in this group?" without
-- walking past our own sends. Plain CREATE INDEX: the table is small
-- at ship time.
DROP INDEX IF EXISTS public.whatsapp_group_messages_group_in_created_idx;
CREATE INDEX IF NOT EXISTS whatsapp_group_messages_group_in_received_idx
  ON public.whatsapp_group_messages (group_id, received_at DESC)
  WHERE direction = 'in';

-- ---------- 2. Row-level security and privileges ----------

ALTER TABLE public.whatsapp_group_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_group_reads FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_group_reads_select ON public.whatsapp_group_reads;
CREATE POLICY whatsapp_group_reads_select ON public.whatsapp_group_reads FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- A new public table starts with every privilege for anon and
-- authenticated (TRUNCATE skips RLS): start from nothing.
REVOKE ALL ON public.whatsapp_group_reads FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.whatsapp_group_reads TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_group_reads TO service_role;

-- ---------- 3. Mark a group read ----------

CREATE OR REPLACE FUNCTION public.whatsapp_group_mark_read(p_group uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_acct uuid;
BEGIN
  -- A refusal, not a silent no-op: a caller that cannot see the group
  -- has a bug (or a stale tab after a workspace switch) worth seeing.
  IF v_uid IS NULL OR p_group IS NULL OR NOT whatsapp_group_can_view(p_group) THEN
    RAISE EXCEPTION 'not_visible: this group is not visible to you'
      USING ERRCODE = '42501';
  END IF;
  SELECT g.account_id INTO v_acct FROM whatsapp_groups g WHERE g.id = p_group;

  INSERT INTO whatsapp_group_reads AS r (group_id, account_id, user_id, last_read_at)
  VALUES (p_group, v_acct, v_uid, now())
  ON CONFLICT (group_id, user_id) DO UPDATE
    SET last_read_at = greatest(r.last_read_at, EXCLUDED.last_read_at);
END
$$;
COMMENT ON FUNCTION public.whatsapp_group_mark_read(uuid) IS
  'Moves the caller''s read marker of a group to now (never back). Refuses 42501 unless whatsapp_group_can_view. Called by the groups chat when a group is opened and when an inbound message arrives while it is open. Migration 146.';

-- ---------- 4. The sidebar count ----------

CREATE OR REPLACE FUNCTION public.whatsapp_group_unread_count()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::integer
    FROM whatsapp_groups g
    LEFT JOIN whatsapp_group_reads r
      ON r.group_id = g.id AND r.user_id = auth.uid()
   WHERE g.account_id = (SELECT current_account_id())
     AND g.id IN (SELECT whatsapp_group_visible_ids())
     AND g.our_role <> 'left'
     AND EXISTS (
       SELECT 1 FROM whatsapp_group_messages m
        WHERE m.group_id = g.id
          AND m.direction = 'in'
          -- Arrival time, not WhatsApp's send time; no marker: read
          -- up to 7 days ago (see the header).
          AND m.received_at > coalesce(r.last_read_at, now() - interval '7 days'))
$$;
COMMENT ON FUNCTION public.whatsapp_group_unread_count() IS
  'Groups of the active workspace the caller sees (whatsapp_group_visible_ids), not left, with an inbound message that arrived (received_at, not WhatsApp''s created_at) after the caller''s marker; no marker reads as 7 days ago. SECURITY INVOKER: the policies already scope every table. The sidebar''s Groups count. Migration 146.';

REVOKE ALL ON FUNCTION public.whatsapp_group_mark_read(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.whatsapp_group_unread_count() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.whatsapp_group_mark_read(uuid),
  public.whatsapp_group_unread_count()
  TO authenticated;
