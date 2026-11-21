/**
 * The channel an HR automated message goes out on (migrations 215, 226), for
 * the client layer. Client components import this file: it imports only
 * `./types`, which imports nothing outside this folder.
 *
 * There is no cross-channel fallback: an RCS or SMS message whose
 * provider is not connected is held `channel_not_connected` and never
 * sent over another channel.
 */
import { CHANNELS, type Channel } from './types';

export const AUTOMSG_CHANNELS = CHANNELS;
export type AutomsgChannel = Channel;

/** Anything but 'rcs' or 'sms' is WhatsApp, the column default. */
export function channelOf(v: unknown): AutomsgChannel {
  return v === 'rcs' || v === 'sms' ? v : 'whatsapp';
}

/** Label keys under `Hr.automsg`, one per channel. */
export const CHANNEL_LABEL_KEYS: Readonly<Record<AutomsgChannel, string>> = {
  whatsapp: 'channel.whatsapp',
  rcs: 'channel.rcs',
  sms: 'channel.sms',
};

/** 215's check on an RCS template's provider id (`meta_template_name`). */
export const RCS_TEMPLATE_ID = /^[A-Za-z0-9_.:-]{1,512}$/;

/** 226's check on an SMS template's label (`meta_template_name`). */
export const SMS_TEMPLATE_LABEL = /^[A-Za-z0-9_.:-]{1,512}$/;
