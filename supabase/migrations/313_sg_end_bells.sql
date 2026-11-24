-- 313: when a submission group ends, the bells of who loses it follow.
--
-- An agent's unread bell of before the end opened "This group does not
-- exist": only a customer's message after the end replaced it (308). The
-- end now turns it to the customer's page for who may see the customer, and
-- marks it read for who may not. Those who may read the archive keep theirs.
--
-- RESTATES sg_end (115, 173): apply in order. Needs 308. Safe to run twice.
-- supabase/ci/verify-sg-end-bells.sql asserts it.

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.sg_end(p_group uuid, p_reason text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- 313. Never in the way of the end itself.
  BEGIN
    UPDATE public.notifications n
       SET contact_id = CASE WHEN l.sees THEN l.contact_id ELSE n.contact_id END,
           meta = CASE WHEN l.sees THEN n.meta || '{"ended": true}'::jsonb ELSE n.meta END,
           read_at = CASE WHEN l.sees THEN NULL ELSE now() END
      FROM (SELECT u.user_id, g.account_id, g.contact_id,
                   public.sg_user_sees_contact(g.account_id, u.user_id, g.contact_id) AS sees
              FROM public.submission_groups g,
                   LATERAL (SELECT DISTINCT a.user_id FROM public.submission_group_access a
                             WHERE a.group_id = g.id AND a.removed_at = v_at) u
             WHERE g.id = p_group AND NOT public.sg_can_read(g.id, u.user_id)) l
     WHERE n.user_id = l.user_id
       AND n.account_id = l.account_id
       AND n.read_at IS NULL
       AND n.type = 'submission_group_message'
       AND n.meta ->> 'group_id' = p_group::text
       AND NOT n.meta ? 'ended';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'sg_end: bells of group %: % (%)', p_group, SQLERRM, SQLSTATE;
  END;
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.sg_end(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sg_end(uuid, text) TO service_role;

RESET lock_timeout;
NOTIFY pgrst, 'reload schema';
