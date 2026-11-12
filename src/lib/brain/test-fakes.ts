/**
 * In-memory fakes of the brain ports, for tests only. Upsert is idempotent
 * per (account, kind, source, text) like the SQL; `refuse` makes it return
 * null (a forgotten chunk, a marked contact, the brain switched off).
 */
import { HashingEmbedder } from './embed';
import type {
  BrainCandidate,
  BrainItemInput,
  BrainStore,
  VectorIndex,
  VectorQuery,
} from './ports';

export class MemPorts implements BrainStore, VectorIndex {
  items: (BrainItemInput & { id: string })[] = [];
  vecs = new Map<string, readonly number[]>();
  audits: { account: string; actor: string; sha: string; n: number }[] = [];
  cands: BrainCandidate[] = [];
  lastQuery: VectorQuery | null = null;
  refuse: (i: BrainItemInput) => boolean = () => false;

  async upsert(i: BrainItemInput) {
    if (this.refuse(i)) return null;
    const hit = this.items.find(
      (x) =>
        x.accountId === i.accountId &&
        x.sourceKind === i.sourceKind &&
        x.sourceId === i.sourceId &&
        x.text === i.text
    );
    if (hit) return hit.id;
    const id = `id${this.items.length + 1}`;
    this.items.push({ ...i, id });
    return id;
  }
  async forget() {
    return 0;
  }
  async markContact() {}
  async audit(account: string, actor: string, sha: string, n: number) {
    this.audits.push({ account, actor, sha, n });
  }
  async put(
    _account: string,
    itemId: string,
    _m: string,
    v: readonly number[]
  ) {
    this.vecs.set(itemId, v);
  }
  async candidates(q: VectorQuery) {
    this.lastQuery = q;
    return this.cands;
  }
}

export const memDeps = (m: MemPorts) => ({
  store: m,
  index: m,
  embedder: new HashingEmbedder(),
});
