import type { JournalEntry, TxState } from "./types";
import { UNRESOLVED } from "./types";

export interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export class MemoryStore implements KeyValueStore {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

/** Journal of operations. Entries are found by opId, or by exact txHash once one exists. */
export class TxJournal {
  private entries: JournalEntry[] = [];
  private listeners = new Set<() => void>();
  private snap: JournalEntry[] | null = null;
  constructor(private store: KeyValueStore, private storageKey = "btc-forecast:tx-journal:v1") {
    try {
      const raw = store.getItem(storageKey);
      if (raw) this.entries = JSON.parse(raw) as JournalEntry[];
    } catch {
      this.entries = [];
    }
  }
  /** Referentially stable between changes (for useSyncExternalStore). */
  snapshot = (): JournalEntry[] => (this.snap ??= this.all());
  private persist() {
    this.snap = null;
    try {
      this.store.setItem(this.storageKey, JSON.stringify(this.entries));
    } catch {
      /* storage may be unavailable; the in-memory journal still works */
    }
    this.listeners.forEach((l) => l());
  }
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  all(): JournalEntry[] {
    return this.entries.map((e) => ({ ...e, args: { ...e.args } }));
  }
  getByOp(opId: string) {
    return this.entries.find((e) => e.opId === opId);
  }
  getByHash(hash: string) {
    return this.entries.find((e) => e.txHash === hash);
  }
  add(e: JournalEntry) {
    this.entries.push(e);
    this.persist();
  }
  /** Bind the exact hash returned by the submission to its operation. */
  bindHash(opId: string, txHash: string) {
    if (this.getByHash(txHash)) throw new Error("This hash is already bound to another operation.");
    this.patchByOp(opId, { txHash });
  }
  patchByOp(opId: string, patch: Partial<JournalEntry>) {
    const e = this.getByOp(opId);
    if (!e) throw new Error(`Unknown operation ${opId}`);
    Object.assign(e, patch, { updatedAt: Date.now() });
    this.persist();
  }
  setState(opId: string, state: TxState, extra: Partial<JournalEntry> = {}) {
    this.patchByOp(opId, { state, ...extra });
  }
  /** Is there an unresolved operation for this exact wallet + market + method? */
  findUnresolved(wallet: string, marketId: string, method: string) {
    return this.entries.find((e) => e.wallet === wallet && e.args.marketId === marketId && e.method === method && UNRESOLVED.has(e.state));
  }
  forWallet(wallet: string | null): JournalEntry[] {
    if (!wallet) return [];
    return this.all().filter((e) => e.wallet === wallet);
  }
}
