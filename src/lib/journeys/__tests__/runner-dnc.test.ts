import { describe, expect, it, vi } from 'vitest';
import {
  createRunner,
  type Action,
  type ConsentPort,
  type HandleResult,
  type RunnerEvent,
} from '../index';
import {
  CONSENT_PORT,
  MemorySink,
  MemoryStore,
  Sim,
  btn,
  def,
  dxb,
  inb,
} from './helpers';

/** Inbound POS lead in P_PITCH (file f1, contact c1); the runner reads consent from `consent`. */
function harness(consent: ConsentPort) {
  const file = new Sim().ev(
    inb(dxb(1, '10:14')),
    btn('POS', dxb(1, '10:15'))
  ).file;
  const store = new MemoryStore(file),
    sink = new MemorySink();
  return { sink, runner: createRunner({ def, store, sink, consent }) };
}
const tap: RunnerEvent = {
  id: 'wamid.cmb',
  fileId: 'f1',
  type: 'BUTTON',
  payload: 'CALL_ME_BACK',
  at: dxb(1, '11:00'),
};
const actionsOf = (r: HandleResult): Action[] => {
  if (r.status !== 'ok') throw new Error(`handle: ${r.status}`);
  return r.result.actions;
};
const tasks = (actions: Action[]) =>
  actions.flatMap((a) => (a.type === 'ADVISOR_TASK' ? [a.kind] : []));
const callbacks = (actions: Action[]) =>
  actions.filter((a) => a.type === 'REQUEST_CALLBACK');

describe('runner: ConsentPort.doNotContact reaches the step', () => {
  it('do-not-contact: CALL_ME_BACK raises only CALLBACK_BLOCKED_DNC, no REQUEST_CALLBACK is delivered', async () => {
    const doNotContact = vi.fn(async () => true);
    const h = harness({ ...CONSENT_PORT, doNotContact });
    const actions = actionsOf(await h.runner.handle(tap));
    expect(doNotContact).toHaveBeenCalledWith('c1');
    expect(tasks(actions)).toEqual(['CALLBACK_BLOCKED_DNC']);
    expect(callbacks(actions)).toEqual([]);
    const delivered = h.sink.delivered.map((i) => i.action);
    expect(tasks(delivered)).toEqual(['CALLBACK_BLOCKED_DNC']);
    expect(callbacks(delivered)).toEqual([]);
  });

  it('without the flag (port has no doNotContact, or it answers false): a REQUEST_CALLBACK is delivered', async () => {
    for (const consent of [
      CONSENT_PORT,
      { ...CONSENT_PORT, doNotContact: async () => false },
    ]) {
      const h = harness(consent);
      const actions = actionsOf(await h.runner.handle(tap));
      expect(tasks(actions)).toEqual(['CALLBACK']);
      expect(callbacks(h.sink.delivered.map((i) => i.action))).toEqual([
        { type: 'REQUEST_CALLBACK', contactId: 'c1', fileId: 'f1' },
      ]);
    }
  });
});
