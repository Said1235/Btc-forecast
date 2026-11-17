import type { Outcome } from "../domain/candle";

export type TxState =
  | "awaiting-approval"
  | "submitting"
  | "submitted"
  | "processing"
  | "decision"
  | "finalizing"
  | "finalized-ok"
  | "finalized-error"
  | "undetermined"
  | "rejected"
  | "tracking-unavailable"
  | "unknown-reconcile"
  | "readback-mismatch";

/** States that still need attention: a second submission for the same key is blocked. */
export const UNRESOLVED: ReadonlySet<TxState> = new Set<TxState>([
  "awaiting-approval", "submitting", "submitted", "processing", "decision", "finalizing",
  "tracking-unavailable", "unknown-reconcile", "readback-mismatch",
]);

export const TERMINAL: ReadonlySet<TxState> = new Set<TxState>(["finalized-ok", "finalized-error", "undetermined", "rejected"]);

export interface JournalArgs {
  marketId: string; // UTC date, YYYY-MM-DD
  pick?: Outcome; // only for submit_prediction
}

export interface JournalEntry {
  opId: string; // local identity, exists before any hash
  txHash: string | null; // exact hash; the only key used to track
  networkId: string;
  chainId: number;
  contractAddress: string;
  wallet: string; // original wallet; never replaced after an account change
  method: string;
  args: JournalArgs;
  marketOpenTime: number;
  submittedAt: number;
  updatedAt: number;
  state: TxState;
  executionResult: string | null;
  lastError: string | null;
}

export interface SubmitContext {
  networkId: string;
  chainId: number;
  contractAddress: string;
  wallet: string;
  method: string;
  args: JournalArgs;
  marketOpenTime: number;
}

export type ReceiptView =
  | { phase: "processing" | "decision" | "finalizing" }
  | { phase: "finalized"; executionOk: boolean; executionResult: string; detail?: string }
  | { phase: "undetermined"; detail: string };

/** What the tracker needs from a network. A deterministic mock implements it in tests. */
export interface TxProvider {
  submit(ctx: SubmitContext): Promise<{ kind: "hash"; txHash: string } | { kind: "rejected" }>;
  getReceipt(txHash: string): Promise<ReceiptView>;
  /** authoritative read-back using the entry's ORIGINAL wallet, method and exact market */
  readBack(entry: JournalEntry): Promise<{ ok: boolean; observed: string }>;
}
