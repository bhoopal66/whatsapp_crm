import { vi } from 'vitest';
import { createYeastarApi } from '../api';
import { createYeastarClient } from '../client';
import type { TokenProvider } from '../token';

// Examples from the Yeastar Cloud Edition developer guide. Two defects in
// the published text are repaired here: the extension-list example carries
// "//" comments, and the CDR example has a full-width comma (U+FF0C) after
// "reason". Neither is valid JSON, so neither could be parsed as shipped.

export const BASE = 'https://pbx.example.yeastarcloud.com';

export const DIAL_OK = {
  errcode: 0,
  errmsg: 'SUCCESS',
  call_id: '1650095575.872',
};

export const CALL_QUERY_OK = {
  errcode: 0,
  errmsg: 'SUCCESS',
  data: [
    {
      call_id: '1650012665.266',
      members: [
        {
          extension: {
            number: '2000',
            channel_id: 'PJSIP/2000-0000008a',
            member_status: 'ANSWERED',
            call_path: '',
          },
        },
        {
          outbound: {
            from: '2000',
            to: '1003',
            trunk_name: 'test-peer-trunking',
            channel_id: 'PJSIP/trunk-test-peer-trunking-endpoint-0000008b',
            member_status: 'ANSWER',
            call_path: '',
          },
        },
      ],
    },
  ],
};

const offline = { status: 0 };

export const EXTENSION_LIST_OK = {
  errcode: 0,
  errmsg: 'SUCCESS',
  total_number: 12,
  data: [
    {
      id: 238,
      online_status: {
        // The phone is registered, yet the top-level status stays 0.
        sip_phone: {
          status: 0,
          ext_dev_type: 'sip',
          status_list: [{ status: 1, ip: '192.168.28.190:5060' }],
        },
        linkus_desktop: offline,
        linkus_mobile: offline,
        linkus_web: offline,
      },
      presence_status: 'available',
      number: '2000',
      caller_id_name: 'Leo Ball',
      role_name: 'Administrator',
      email_addr: 'leo@sample.com',
      custom_presence_status: 'lunch',
    },
    {
      id: 223,
      online_status: {
        sip_phone: offline,
        linkus_desktop: { status: 1, ext_dev_type: 'linkusdesktop' },
        linkus_mobile: offline,
        linkus_web: offline,
      },
      presence_status: 'away',
      number: '2001',
      caller_id_name: 'Phillip Huff',
      role_name: 'Administrator',
      email_addr: 'philip@sample.com',
      custom_presence_status: 'Available (Work)',
    },
    {
      id: 227,
      online_status: {
        sip_phone: { status: 0, ext_dev_type: 'sip' },
        linkus_desktop: offline,
        linkus_mobile: {
          status: 1,
          ext_dev_type: 'linkusmobile',
          status_list: [
            { status: 1, ip: '112.48.22.71', linkus_dev_type: 'android' },
          ],
        },
        linkus_web: { status: 0, ext_dev_type: 'linkusweb' },
      },
      presence_status: 'business_trip',
      number: '2002',
      caller_id_name: 'Terrell Smith',
      role_name: 'Administrator',
      email_addr: 'terrell@sample.com',
      mobile_number: '15880123456',
      custom_presence_status: 'Business Trip',
    },
    {
      id: 229,
      online_status: {
        sip_phone: { status: 0, ext_dev_type: 'sip' },
        linkus_desktop: offline,
        linkus_mobile: offline,
        linkus_web: { status: 1, ext_dev_type: 'linkusweb' },
      },
      presence_status: 'do_not_disturb',
      number: '2003',
      caller_id_name: 'Dave Haris',
      email_addr: 'dave@sample.com',
      mobile_number: '13600930000',
      custom_presence_status: 'Do Not Disturb',
    },
  ],
};

const cdrCommon = {
  src_addr: '192.168.28.44:5062',
  disposition: 'ANSWERED',
  call_note: null,
  call_note_id: '',
  enb_call_note: 0,
  did: '',
  did_name: '',
  pin_code: '',
};

export const CDR_SEARCH_OK = {
  errcode: 0,
  errmsg: 'SUCCESS',
  total_number: 3,
  data: [
    {
      ...cdrCommon,
      time: '2025/12/19 10:40:07',
      call_from: 'Phillip Huff<1001>',
      call_to: 'Call Flow aaa<6901>',
      timestamp: 1766112007,
      uid: '2025121910400711733',
      duration: 10,
      shaken_attestation: 'A',
      talk_duration: 10,
      call_type: 'Internal',
      call_from_number: '1001',
      call_from_name: 'Phillip Huff',
      call_to_number: '6901',
      call_to_name: 'aaa',
      call_id: '1766112007.0',
      new_id: '66CD1EAE-AF80033C',
    },
    {
      ...cdrCommon,
      time: '2025/12/19 10:40:26',
      call_from: 'Phillip Huff<1001>',
      call_to: 'Call Flow aaa<6901>',
      timestamp: 1766112026,
      uid: '2025121910402635715',
      duration: 11,
      shaken_attestation: 'B',
      talk_duration: 11,
      call_type: 'Internal',
      call_from_number: '1001',
      call_from_name: 'Phillip Huff',
      call_to_number: '6901',
      call_to_name: 'aaa',
      call_id: '1766112026.2',
      new_id: '66CD1EC2-2E0000E6',
    },
    {
      id: 2710,
      time: '05/30/2022 14:53:41',
      call_from: 'Kristin Hale<2005>',
      call_to: '1000',
      pin_code: '1111',
      timestamp: 1653893621,
      uid: '202205301453416CEAB',
      src_addr: '192.168.28.25',
      dst_trunk: 'peer-to-34',
      duration: 7,
      shaken_attestation: 'A',
      talk_duration: 7,
      disposition: 'ANSWERED',
      call_type: 'Outbound',
      dod_number: '2005',
      reason: 'src hangup    ',
      call_from_number: '2005',
      call_from_name: 'Kristin Hale',
      call_to_number: '1000',
      call_to_name: ' ',
      call_id: '1718690912.7',
      call_note: {
        id: '20220530160214-24CE3',
        group_id: '1745395229.3',
        disposition_code_list: [
          {
            id: 21,
            name: 'Transferred to Another Department',
            description:
              'The call was transferred to the appropriate team or department.',
          },
        ],
        remark: 'User encountered xx issue, needs resolution',
        agent_name: 'Madison Cooper',
        registration_time: 1741226653,
        update_entry: '',
      },
      call_note_id: '20220530160214-24CE3',
      enb_call_note: 8,
      did: '123456',
      did_name: '',
    },
  ],
};

export const DOWNLOAD_OK = {
  errcode: 0,
  errmsg: 'SUCCESS',
  file: '20220412173331-1649756009.12-2002-2005-Internal.wav',
  download_resource_url:
    '/api/download/Recording-X.7.0.6-1-download-20220412175901-M8zB66xYUNTNMr2D.wav',
};

export interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export function fakeFetch(reply: (call: Call) => object) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return new Response(JSON.stringify(reply(call)));
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

export function stubTokens(token: string): TokenProvider {
  return {
    getAccessToken: vi.fn(async () => token),
    invalidate: vi.fn(async () => undefined),
  };
}

export const endpointOf = (c: Call) =>
  c.url.pathname.replace('/openapi/v1.0/', '');

export function setup(reply: (call: Call) => object, baseUrl = BASE) {
  const f = fakeFetch(reply);
  const client = createYeastarClient({
    connection: { baseUrl },
    tokens: stubTokens('main-token'),
    fetch: f.fetch,
  });
  return { ...f, client, api: createYeastarApi(client) };
}
