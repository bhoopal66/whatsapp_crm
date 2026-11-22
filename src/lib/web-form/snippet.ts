/**
 * The links and the embeddable snippet Settings → Web form hands out
 * (migration 249). Pure, so the exact markup is tested.
 *
 * No iframe snippet: every page keeps `X-Frame-Options: DENY` and
 * `frame-ancestors 'none'` (next.config.ts, src/lib/csp.ts). A site
 * embeds the form as plain HTML that posts to the public endpoint; the
 * visitor lands on the hosted thank-you page.
 */

import { HONEYPOT_FIELD } from './submission';

function base(siteUrl: string): string {
  return siteUrl.replace(/\/+$/, '');
}

export function hostedFormUrl(siteUrl: string, token: string): string {
  return `${base(siteUrl)}/f/${token}`;
}

export function submitEndpoint(siteUrl: string, token: string): string {
  return `${base(siteUrl)}/api/public/web-form/${token}`;
}

function attr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * A script-free HTML form for any website. Its site must be listed in
 * Allowed websites, or the endpoint refuses the post (403).
 */
export function htmlFormSnippet(siteUrl: string, token: string): string {
  const action = attr(submitEndpoint(siteUrl, token));
  return [
    `<form method="post" action="${action}">`,
    `  <input name="name" placeholder="Name" maxlength="120">`,
    `  <input name="phone" type="tel" placeholder="+971 50 123 4567" required maxlength="64">`,
    `  <input name="email" type="email" placeholder="Email" maxlength="254">`,
    `  <textarea name="message" placeholder="Message" maxlength="2000"></textarea>`,
    `  <input name="${HONEYPOT_FIELD}" tabindex="-1" autocomplete="off" style="position:absolute;left:-10000px" aria-hidden="true">`,
    `  <button type="submit">Send</button>`,
    `</form>`,
  ].join('\n');
}
