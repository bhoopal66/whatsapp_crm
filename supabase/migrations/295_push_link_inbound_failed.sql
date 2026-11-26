-- ============================================================
-- 295_push_link_inbound_failed.sql — pushes that opened the bell list
-- (or the wrong screen) instead of the screen the bell itself opens
--
-- push_bell_url had no branch for these (lib/notifications/target.ts has):
--  * inbound_message_failed (264): Settings -> WhatsApp, for those who can
--    edit settings.
--  * channel_disconnected / channel_reconnected of a personal number
--    (meta.personal): its holder's profile tab, where the QR is, any role.
--    An admin's opened the company numbers, anyone else's the bell list.
--  * work_handed_over (266): the inbox.
--  * meeting_reminder: the meeting, so "starts now" is one tap from joining.
--  * calendar_invite / _update / _cancelled / _response, event_reminder:
--    the event in the calendar.
--  * group_join_request (114): the group's requests tab.
-- And two it had differently: task_due without a customer (the calendar,
-- not a chat or the calls list) and team_activity_unlock_request for
-- somebody who no longer leads a team (the bell list).
--
-- The function is changed by a line, not restated (as 282, 293): apply
-- after 293. Re-running 253 puts the old body back: re-run 282, 293, 295.
-- Additive for the previous build. Re-runnable.
-- verify-push-link-inbound.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$
DECLARE
  v_fn text := pg_get_functiondef('public.push_bell_url(public.notifications)'::regprocedure);
  r    record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    (1, 'inbound_message_failed', 'WHEN n.type = ''retention_failed'' THEN',
     'WHEN n.type = ''inbound_message_failed'' THEN
      RETURN CASE WHEN v_role IN (''owner'', ''admin'') THEN ''/settings?tab=whatsapp'' ELSE ''/notifications'' END;
    WHEN n.type = ANY (ARRAY[''channel_disconnected'', ''channel_reconnected''])
         AND n.meta -> ''personal'' = ''true''::jsonb THEN
      RETURN ''/settings?tab=profile'';
    WHEN n.type = ''work_handed_over'' THEN
      RETURN ''/inbox'';
    WHEN n.type = ''retention_failed'' THEN'),
    -- A branch of its own: 278 looks for the list as it wrote it.
    (2, '''meeting_reminder''', 'WHEN n.type = ''submission_group_message'' THEN',
     'WHEN n.type = ''meeting_reminder'' THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> ''meeting_id'')
                  THEN ''/meetings/'' || (n.meta ->> ''meeting_id'') ELSE ''/notifications'' END;
    WHEN n.type = ''submission_group_message'' THEN'),
    (3, '/calendar?event=', 'WHEN n.type = ''submission_group_message'' THEN',
     'WHEN n.type IN (''calendar_invite'', ''calendar_update'', ''calendar_cancelled'', ''calendar_response'', ''event_reminder'') THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> ''event_id'')
                  THEN ''/calendar?event='' || (n.meta ->> ''event_id'') ELSE ''/notifications'' END;
    WHEN n.type = ''group_join_request'' THEN
      RETURN CASE WHEN public.push_is_uuid(n.meta ->> ''group_id'')
                  THEN ''/groups/'' || (n.meta ->> ''group_id'') || ''?tab=requests'' ELSE ''/notifications'' END;
    WHEN n.type = ''submission_group_message'' THEN'),
    (4, 'WHEN n.type = ''task_due'' THEN', 'WHEN n.type IN (''task_assigned'', ''task_due'') THEN',
     'WHEN n.type = ''task_due'' THEN
      RETURN coalesce(''/contacts/'' || n.contact_id, ''/calendar'');
    WHEN n.type = ''task_assigned'' THEN'),
    (5, 'THEN ''/team-activity?tab=unlocks'' ELSE', 'RETURN ''/team-activity?tab=unlocks'';',
     'RETURN CASE WHEN v_role IN (''owner'', ''admin'', ''team_leader'') THEN ''/team-activity?tab=unlocks'' ELSE ''/notifications'' END;')
  ) v(step, mark, old_text, new_text) ORDER BY step
  LOOP
    -- `mark` is what the changed body carries: this step is already in.
    CONTINUE WHEN position(r.mark IN v_fn) > 0;
    IF position(r.old_text IN v_fn) = 0 THEN
      RAISE EXCEPTION '295: push_bell_url is not as 278, 282 and 293 left it (step %)', r.step;
    END IF;
    v_fn := replace(v_fn, r.old_text, r.new_text);
  END LOOP;
  EXECUTE v_fn;
END $$;

RESET lock_timeout;
