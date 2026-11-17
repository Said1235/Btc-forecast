import type { Outcome } from "../../domain/candle";

/**
 * Frontend-side interface for the contract-backed features. These are UI concepts,
 * NOT contract method names. The real mapping is decided after the deployed
 * contract's source and schema are inspected.
 */
export type ProviderMode = "demo" | "live";

export type Verified<T> =
  | { status: "ok"; value: T; readAt: number }
  | { status: "not-configured" }
  | { status: "unavailable"; reason: string };

export interface MarketContractState {
  marketId: string; // UTC date
  /** Whether the contract accepts predictions for this market. Contract is authoritative. */
  predictionsOpen: boolean;
  resolved: boolean;
  result: Outcome | null;
  /** distinguishes provisional from final, only if the contract exposes it */
  final: boolean;
}

export interface UserPrediction {
  marketId: string;
  wallet: string;
  pick: Outcome;
  correct: boolean | null;
}

export interface SubmitRequest {
  wallet: string;
  marketId: string;
  marketOpenTime: number;
  pick: Outcome;
}

export type SubmitOutcome =
  | { kind: "hash"; txHash: string } // real network hash (live) or a clearly demo id
  | { kind: "rejected" } // user rejected before submission
  | { kind: "uncertain"; detail: string }; // approved, but no hash returned

export interface ContractAdapter {
  readonly mode: ProviderMode;
  readonly configured: boolean;
  readMarket(marketId: string): Promise<Verified<MarketContractState>>;
  readUserPrediction(wallet: string, marketId: string): Promise<Verified<UserPrediction | null>>;
  readUserPoints(wallet: string): Promise<Verified<number>>;
  readHistory(wallet: string): Promise<Verified<UserPrediction[]>>;
  submitPrediction(req: SubmitRequest): Promise<SubmitOutcome>;
}

export class NotConfiguredError extends Error {
  constructor() {
    super("Contract integration is not configured.");
    this.name = "NotConfiguredError";
  }
}
