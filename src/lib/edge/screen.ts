/**
 * Webhook screening — the per-event rules of module 017a, run after the
 * route has verified the request's signature and normalised its events
 * (neither happens here). Order: IP sanity limit → in-request duplicate →
 * replay claim → per-sender limit.
 *
 * Crash-recovery rule: a claim is confirmed (`confirmAccepted`) only after
 * the host has persisted the event. If any event of a request is
 * claimed-but-unconfirmed elsewhere (another delivery in flight, or a host
 * that crashed before confirming), the whole request answers 503 with
 * nothing accepted, and the gateway retries later: by then the lease has
 * lapsed (→ processed) or the confirm has landed (→ duplicate). Never 429 —
 * that only makes the gateway retry sooner.
 */
import { ipKey } from './ip';
import { consoleLogger, type EdgeLogger } from './logger';
import type { RateLimiter } from './ratelimit';
import type { Claim, ReplayGuard } from './replay';

export type ScreenCtx = {
  replay: ReplayGuard;
  limiter: RateLimiter;
  logger?: EdgeLogger;
};

export type ScreenEvent = {
  /** Replay key, e.g. `msg:<id>`, or `status:<id>:<status>` per transition. */
  key: string;
  /** Per-sender limit bucket; a message without one shares the "" bucket. */
  senderKey?: string;
  /** Statuses are deduped but never sender-limited. */
  kind: 'message' | 'status';
};

export type ScreenInput = { ip: string | undefined; events: ScreenEvent[] };

export type ScreenOutcome =
  'accept' | 'duplicate' | 'rate_limited' | 'ip_limited';

/** `claimToken` is absent when the replay store failed open. */
export type ScreenDecision = {
  key: string;
  outcome: ScreenOutcome;
  claimToken?: string;
};

/**
 * 200: one decision per input event, in input order. 503: no decisions —
 * answer 503 and process nothing. `degraded`: a store failed open.
 */
export type ScreenResult = {
  status: 200 | 503;
  decisions: ScreenDecision[];
  degraded?: true;
};

export async function screenWebhook(
  ctx: ScreenCtx,
  input: ScreenInput,
  now?: number
): Promise<ScreenResult> {
  const log = ctx.logger ?? consoleLogger;
  let degraded = false;
  const done = (status: 200 | 503, decisions: ScreenDecision[]) =>
    degraded
      ? { status, decisions, degraded: true as const }
      : { status, decisions };

  const ip = ipKey(input.ip);
  const byIp = await ctx.limiter.check('webhook.ip', ip, now);
  if (byIp.degraded) degraded = true;
  if (!byIp.allowed) {
    // Sanity limit only: answer 200 (a 429 would just bring a retry), process nothing, claim nothing.
    log.warn('webhook ip rate limited; request dropped', {
      ip,
      keys: input.events.map((e) => e.key),
    });
    return done(
      200,
      input.events.map((e) => ({ key: e.key, outcome: 'ip_limited' }))
    );
  }

  const keysInRequest = new Set<string>();
  const held: { key: string; token: string }[] = [];
  const decisions: ScreenDecision[] = [];
  for (const e of input.events) {
    if (keysInRequest.has(e.key)) {
      decisions.push({ key: e.key, outcome: 'duplicate' });
      continue;
    }
    keysInRequest.add(e.key);
    let claim: Claim;
    try {
      claim = await ctx.replay.claim(e.key);
    } catch (err) {
      // A duplicate is cheaper than a lost customer message.
      log.warn('replay store failed; failing open', {
        key: e.key,
        err: String(err),
      });
      degraded = true;
      claim = { state: 'new' };
    }
    if (claim.state === 'inflight') {
      log.warn('webhook event in flight; asking the gateway to retry', {
        key: e.key,
      });
      for (const h of held) await release(ctx.replay, h.key, h.token, log);
      return done(503, []);
    }
    if (claim.state === 'done') {
      decisions.push({ key: e.key, outcome: 'duplicate' });
      continue;
    }
    if (e.kind === 'message') {
      // Only a genuinely new message spends the sender's quota; redeliveries never do.
      const bySender = await ctx.limiter.check(
        'webhook.number',
        e.senderKey ?? '',
        now
      );
      if (bySender.degraded) degraded = true;
      if (!bySender.allowed) {
        log.warn('webhook message rate limited', { key: e.key });
        if (claim.token !== undefined) {
          await release(ctx.replay, e.key, claim.token, log);
        }
        decisions.push({ key: e.key, outcome: 'rate_limited' });
        continue;
      }
    }
    if (claim.token === undefined) {
      decisions.push({ key: e.key, outcome: 'accept' });
    } else {
      held.push({ key: e.key, token: claim.token });
      decisions.push({
        key: e.key,
        outcome: 'accept',
        claimToken: claim.token,
      });
    }
  }
  return done(200, decisions);
}

/**
 * Call after persisting the accepted events, before answering 200. Returns
 * the keys whose claim could not be confirmed (lease lost or store error);
 * those may be redelivered.
 */
export async function confirmAccepted(
  ctx: Pick<ScreenCtx, 'replay' | 'logger'>,
  decisions: readonly ScreenDecision[]
): Promise<{ unconfirmed: string[] }> {
  const log = ctx.logger ?? consoleLogger;
  const unconfirmed: string[] = [];
  for (const d of decisions) {
    if (d.outcome !== 'accept' || d.claimToken === undefined) continue;
    let ok = false;
    try {
      ok = await ctx.replay.confirm(d.key, d.claimToken);
    } catch (err) {
      log.warn('replay confirm failed', { key: d.key, err: String(err) });
    }
    if (!ok) unconfirmed.push(d.key);
  }
  if (unconfirmed.length) {
    log.warn('replay claims not confirmed', { keys: unconfirmed });
  }
  return { unconfirmed };
}

/**
 * Call when persisting failed and the host answers an error: gives the
 * accepted claims back so the gateway's retry is processed at once instead
 * of answering 503 until the lease lapses. Best effort.
 */
export async function releaseAccepted(
  ctx: Pick<ScreenCtx, 'replay' | 'logger'>,
  decisions: readonly ScreenDecision[]
): Promise<void> {
  const log = ctx.logger ?? consoleLogger;
  for (const d of decisions) {
    if (d.outcome !== 'accept' || d.claimToken === undefined) continue;
    await release(ctx.replay, d.key, d.claimToken, log);
  }
}

/** Best effort: an unreleased claim just lapses with its lease. */
async function release(
  replay: ReplayGuard,
  key: string,
  token: string,
  log: EdgeLogger
): Promise<void> {
  try {
    await replay.release(key, token);
  } catch (err) {
    log.warn('replay release failed', { key, err: String(err) });
  }
}
