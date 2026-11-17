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
  | "readback-mismatch"
  | "rate-limited" // the RPC limited us BEFORE anything was sent: provably nothing exists
  | "send-rate-limited"; // the RPC limited the send itself: acceptance is not proven

/** States that still need attention: a second submission for the same key is blocked. */
export const UNRESOLVED: ReadonlySet<TxState> = new Set<TxState>([
  "awaiting-approval", "submitting", "submitted", "processing", "decision", "finalizing",
  "tracking-unavailable", "unknown-reconcile", "readback-mismatch", "send-rate-limited",
]);

export const TERMINAL: ReadonlySet<TxState> = new Set<TxState>(["finalized-ok", "finalized-error", "undetermined", "rejected", "rate-limited"]);

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
  /** epoch ms before which no new signature request / reconcile is made (rate-limit cool-down) */
  retryAt?: number | null;
  /** account nonce (pending) read right before signing; evidence for reconcile */
  nonceAtSend?: number | null;
}

export interface SubmitContext {
  networkId: string;
  chainId: number;
  contractAddress: string;
  wallet: string;
  method: string;
  args: JournalArgs;
  marketOpenTime: number;
  /** called once the network was verified and the pre-send nonce read, before the wallet is asked to sign */
  onPrepared?: (info: { nonce: number | null }) => void;
}

export type Verdict = "applied" | "pending" | "not-found" | "unknown";

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
  /** evidence about an operation that never returned a hash. Never sends anything. */
  reconcile(entry: JournalEntry): Promise<{ verdict: Verdict; detail: string }>;
}
