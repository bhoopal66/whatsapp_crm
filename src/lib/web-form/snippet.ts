/**
 * The links and the embeddable snippet Settings → Web form hands out
 * (migration 249). Pure, so the exact markup is tested.
 *
 * Two ways to embed: plain HTML that posts to the public endpoint (the
 * visitor lands on the hosted thank-you page), or an <iframe> of the
 * hosted page. The frame only loads on a site in the form's allowed
 * origins: /f/<token> answers `frame-ancestors <those origins>` and
 * `'none'` while the list is empty (frame-headers.ts).
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

/**
 * An <iframe> of the hosted form. Framing works only on a site listed
 * in Allowed websites; elsewhere the browser shows an empty frame.
 */
export function iframeSnippet(siteUrl: string, token: string): string {
  const src = attr(hostedFormUrl(siteUrl, token));
  return (
    `<iframe src="${src}" title="Contact form" width="100%" height="640"` +
    ` style="border:0;max-width:480px" loading="lazy"></iframe>`
  );
}
