# Monitoring: health checks and metrics

Three endpoints for whoever runs the server: a load balancer, Docker,
Uptime Kuma, Prometheus. Port of the outside package's 033c (health) and
033f–g (metrics), fitted to this app. None needs a signed-in user.

## Health checks

| Endpoint           | Answers                                                                                               | Use it for                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/healthz` | `200 {"ok":true}` while the app process is serving. Never touches the database.                       | Liveness: restart the container only when this fails. Docker's `HEALTHCHECK` (Dockerfile and `docker-compose.yml`) calls it. |
| `GET /api/readyz`  | `200 {"ok":true}` when the database answers a one-row read within 2 seconds, else `503 {"ok":false}`. | Readiness: send traffic only when this passes. The reason for a 503 is in the server log, never in the answer.               |

Both answer `Cache-Control: no-store` and carry no data about the
workspace, so they are safe to leave open.

## Metrics

`GET /api/metrics` serves the Prometheus text format (0.0.4).

- **Off until set.** Set `METRICS_TOKEN` (at least 32 characters, e.g.
  `openssl rand -hex 32`) and restart. Unset or shorter: `501
not_configured` (a shorter one is logged once, without its value).
- **Token.** Send `Authorization: Bearer <METRICS_TOKEN>`. Missing or
  wrong: `401 unauthorized`. The comparison is timing-safe; wrong tokens
  do not count toward the sign-in lockout.
- **Per process.** Each server process answers for itself. Counters start
  at zero when the process starts; use `rate()` / `increase()`.

| Metric                                   | Type    | Meaning                                                                                       |
| ---------------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `process_uptime_seconds`                 | gauge   | seconds since this process started                                                            |
| `process_resident_memory_bytes`          | gauge   | resident memory                                                                               |
| `nodejs_heap_used_bytes`                 | gauge   | V8 heap in use                                                                                |
| `nodejs_eventloop_lag_p99_seconds`       | gauge   | p99 event loop delay since the previous scrape                                                |
| `wacrm_edge_refusals_total{kind}`        | counter | requests or events edge security turned away (below)                                          |
| `wacrm_outbox_stats_up`                  | gauge   | 1 when the HR automated-message queue could be read for this scrape, else 0                   |
| `wacrm_outbox_rows{state,channel}`       | gauge   | HR automated messages by status (`queued`, `held`, `sent`, `failed`, `cancelled`) and channel |
| `wacrm_outbox_held_rows{reason,channel}` | gauge   | held messages by reason, e.g. `channel_not_connected` on `sms`                                |
| `wacrm_outbox_oldest_queued_age_seconds` | gauge   | age of the oldest queued message (0 when none)                                                |
| `wacrm_outbox_terminal_failed`           | gauge   | messages failed for good                                                                      |
| `wacrm_inbound_queue_stats_up`           | gauge   | 1 when the inbound WhatsApp queue could be read for this scrape, else 0                       |
| `wacrm_inbound_queue_pending`            | gauge   | inbound WhatsApp events recorded and not processed yet                                        |
| `wacrm_inbound_queue_dead`               | gauge   | inbound WhatsApp events given up on after every retry (kept 14 days)                          |
| `wacrm_inbound_queue_oldest_pending_age_seconds` | gauge   | age of the oldest unprocessed inbound event (0 when none)                                     |
| `wacrm_integration_configured{name}`     | gauge   | 1 when an optional integration is configured                                                  |
| `wacrm_integration_unverified{name}`     | gauge   | 1 when a configured integration runs on an untested wire format (RCS, SMS)                    |

`wacrm_edge_refusals_total` kinds:

| kind                     | Counted when                                                         |
| ------------------------ | -------------------------------------------------------------------- |
| `signin_locked`          | a sign-in is refused because the IP or account is locked (423)       |
| `signin_rate_limited`    | a sign-in is over its IP or user limit (429)                         |
| `api_rate_limited`       | a public API key is over its budget, or its IP is locked out (429)   |
| `webhook_ip_limited`     | a webhook delivery from an IP over its limit (answered 200, dropped) |
| `webhook_sender_limited` | a message from a sender over its rate (kept, no automations)         |
| `webhook_duplicate`      | a redelivered webhook event (already processed)                      |

The queue figures come from `hr_automsg_outbox_stats()` (migration 228,
service role only): counts across every workspace, never a customer, an
id or a message text. If the database does not answer within 2 seconds,
only `wacrm_outbox_stats_up 0` is shown for the queue and the rest of the
page still answers.

The inbound queue figures come from `webhook_inbox_stats()` (migration 264)
under the same rules; `wacrm_inbound_queue_stats_up 0` also means 264 is not
applied, so inbound messages are not durable.

### Prometheus

```yaml
scrape_configs:
  - job_name: taamul-connect
    metrics_path: /api/metrics
    scheme: https
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/taamul-metrics-token
    static_configs:
      - targets: ['crm.example.com']
```

Suggested alerts (starting points; tune to your traffic):

| Alert                     | Expression                                                            |
| ------------------------- | --------------------------------------------------------------------- |
| Queue unreadable          | `wacrm_outbox_stats_up == 0` for 10m                                  |
| Messages stuck            | `wacrm_outbox_oldest_queued_age_seconds > 3600`                       |
| Failures piling up        | `increase(wacrm_outbox_terminal_failed[1h]) > 0`                      |
| Inbound not durable       | `wacrm_inbound_queue_stats_up == 0` for 10m                           |
| Inbound stuck             | `wacrm_inbound_queue_oldest_pending_age_seconds > 900`                |
| Inbound lost              | `wacrm_inbound_queue_dead > 0`                                        |
| Sign-in attack            | `increase(wacrm_edge_refusals_total{kind="signin_locked"}[15m]) > 10` |
| Untested integration live | `wacrm_integration_unverified == 1`                                   |
| Event loop stalls         | `nodejs_eventloop_lag_p99_seconds > 0.5` for 5m                       |

## Startup line

At start the server logs one line naming the optional integrations that
are switched on, and warns when any of them (RCS, SMS) runs on a wire
format nobody has tested against the real provider:

```
[posture] integrations on: typesafe, sms_sender; UNVERIFIED wire format in use: sms_sender (see docs/hr-workflows.md)
```

Unlike the package, the server does not refuse to start in that case:
each of those integrations is off until its variables are set on
purpose, and its docs say what to confirm first.

## Server log

In production every line the server writes starts with the time (UTC,
ISO 8601) and its level. Set `LOG_TIMESTAMPS=off` when the platform adds
its own (journald, Docker). A request that fails with an unhandled error
also writes one `[request-error]` line: method, path without the query
string, the route and Next's digest (the code a visitor sees on the error
page).
