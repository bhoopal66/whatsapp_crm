-- ============================================================
-- 148_campaign_reply_classes.sql — campaign reply sorting
--
-- Jev (TypeSafe's System One model, see 147) classifies the first
-- reply to a broadcast into one of a fixed set of classes, so a
-- campaign's detail page can say how many recipients were interested,
-- asked a question, said not now, and so on. The server writes the
-- result on the recipient row with the service role.
--
--  * broadcast_recipients.reply_class / reply_class_p /
--    reply_classified_at: the class, Jev's probability for it, and when
--    it was judged. NULL until a reply is classified. A partial index
--    on (broadcast_id, reply_class) serves the per-campaign counts.
--
--  * broadcast_recipients_reply_class_guard: these are trusted columns
--    (the counts and any follow-up keyed on them must not be forgeable),
--    but admins legitimately INSERT and UPDATE recipient rows from the
--    browser — the broadcast wizard inserts the frozen audience
--    (use-broadcast-sending.ts) and the detail page updates statuses
--    (broadcasts/[id]/page.tsx), under 135's broadcast_recipients_modify
--    policy. So the guard is column-scoped (BEFORE INSERT OR UPDATE OF
--    the three columns, 147's conversations_insight_guard idiom): an
--    ordinary client insert leaves them NULL and passes, an ordinary
--    client update never names them and never reaches it, and only the
--    service role (062's idiom: auth.uid() IS NULL or role
--    service_role) may set or change them.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS, constraints added inside DO
-- blocks, CREATE INDEX IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER
-- IF EXISTS before the trigger.
-- ============================================================

-- ---------- 1. Columns ----------

ALTER TABLE public.broadcast_recipients
  ADD COLUMN IF NOT EXISTS reply_class         text NULL,
  ADD COLUMN IF NOT EXISTS reply_class_p       real NULL,
  ADD COLUMN IF NOT EXISTS reply_classified_at timestamptz NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.broadcast_recipients'::regclass
      AND conname = 'broadcast_recipients_reply_class_check'
  ) THEN
    ALTER TABLE public.broadcast_recipients
      ADD CONSTRAINT broadcast_recipients_reply_class_check
      CHECK (reply_class IN ('interested', 'question', 'not_now',
                             'not_interested', 'wrong_person', 'stop', 'other'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.broadcast_recipients'::regclass
      AND conname = 'broadcast_recipients_reply_class_p_check'
  ) THEN
    ALTER TABLE public.broadcast_recipients
      ADD CONSTRAINT broadcast_recipients_reply_class_p_check
      CHECK (reply_class_p BETWEEN 0 AND 1);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS broadcast_recipients_reply_class_idx
  ON public.broadcast_recipients (broadcast_id, reply_class)
  WHERE reply_class IS NOT NULL;

COMMENT ON COLUMN public.broadcast_recipients.reply_class IS
  'Jev''s class for the recipient''s first reply to the broadcast (interested, question, not_now, not_interested, wrong_person, stop, other). NULL until classified. Service role only (broadcast_recipients_reply_class_guard).';
COMMENT ON COLUMN public.broadcast_recipients.reply_class_p IS
  'Jev''s probability (0..1) for reply_class. Service role only.';
COMMENT ON COLUMN public.broadcast_recipients.reply_classified_at IS
  'When the first reply was classified. Service role only.';

-- ---------- 2. The guard ----------

CREATE OR REPLACE FUNCTION public.broadcast_recipients_reply_class_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF tg_op = 'UPDATE' THEN
    IF  new.reply_class         IS NOT DISTINCT FROM old.reply_class
    AND new.reply_class_p       IS NOT DISTINCT FROM old.reply_class_p
    AND new.reply_classified_at IS NOT DISTINCT FROM old.reply_classified_at
    THEN
      RETURN new;
    END IF;
  ELSIF new.reply_class IS NULL
    AND new.reply_class_p IS NULL
    AND new.reply_classified_at IS NULL THEN
    RETURN new;
  END IF;

  -- The classifier runs on the service role; migrations and the SQL
  -- editor have no signed-in user (062's idiom).
  IF auth.uid() IS NULL OR COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN new;
  END IF;

  RAISE EXCEPTION 'Campaign reply classes are written by the server only'
    USING ERRCODE = '42501';
END
$$;

COMMENT ON FUNCTION public.broadcast_recipients_reply_class_guard() IS
  'Keeps broadcast_recipients.reply_class / reply_class_p / reply_classified_at service-role-only; ordinary client inserts (columns NULL) and updates (columns untouched) pass (migration 148).';

DROP TRIGGER IF EXISTS broadcast_recipients_reply_class_guard ON public.broadcast_recipients;
CREATE TRIGGER broadcast_recipients_reply_class_guard
  BEFORE INSERT OR UPDATE OF reply_class, reply_class_p, reply_classified_at
  ON public.broadcast_recipients
  FOR EACH ROW EXECUTE FUNCTION public.broadcast_recipients_reply_class_guard();

REVOKE ALL ON FUNCTION public.broadcast_recipients_reply_class_guard() FROM PUBLIC, anon, authenticated, service_role;
