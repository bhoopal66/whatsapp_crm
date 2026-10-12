/** Mermaid state diagram generated from the workflow JSON. */
import { PREV, type TransitionDef, type WorkflowDef } from './schema';

export function toMermaid(def: WorkflowDef): string {
  const L = [
    'stateDiagram-v2',
    `  %% generated from workflows/${def.id}.v${def.version}.json by npm run diagram`,
    `  state "prevOpenState" as PREV_OPEN`,
    `  state "any non-terminal state" as ANY`,
  ];
  const node = (s: string) => (s === PREV ? 'PREV_OPEN' : s);
  const edge = (from: string, t: TransitionDef, label: string) => {
    if (t.to) L.push(`  ${from} --> ${node(t.to)} : ${label}`);
    if (t.onGuardFail && !['reject', 'warn'].includes(t.onGuardFail))
      L.push(`  ${from} --> ${t.onGuardFail} : ${label} guard fail`);
  };
  for (const [k, e] of Object.entries(def.entries))
    edge('[*]', e, `${k} entry`);
  for (const [s, sd] of Object.entries(def.states)) {
    for (const [h, when] of [
      [sd, ''],
      ...Object.entries(sd.byReason ?? {}).map(
        ([r, rh]) => [rh, ` (${r})`] as const
      ),
    ] as const) {
      for (const [b, t] of Object.entries(h.buttons ?? {}))
        edge(s, t, `${b}${when}`);
      for (const [d, t] of Object.entries(h.advisor ?? {}))
        edge(s, t, `ADVISOR ${d}${when}`);
      if (h.onMedia) edge(s, h.onMedia, `media${when}`);
      if (h.onInbound) edge(s, h.onInbound, `any inbound${when}`);
    }
    for (const tm of sd.timers ?? [])
      edge(s, tm.then, `${tm.kind} ${tm.after}`);
    if (sd.onGuardFail)
      L.push(`  ${s} --> ${sd.onGuardFail} : entry guard fail`);
    if (sd.terminal) L.push(`  ${s} --> [*]`);
  }
  L.push(`  ANY --> ${def.optOut.to} : opt-out keyword`);
  for (const [d, t] of Object.entries(def.globalAdvisor))
    edge('ANY', t, `ADVISOR ${d}`);
  if (def.callback)
    L.push(
      `  ANY --> ANY : ${def.callback.payload} (task + REQUEST_CALLBACK, no state change)`
    );
  return L.join('\n') + '\n';
}
