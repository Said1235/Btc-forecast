import type { Outcome } from "../../domain/candle";
import type { TxProvider } from "../../tx/types";

/**
 * Frontend view of the deployed BTCForecast contract (contracts/btc_forecast.py).
 * Reads map 1:1 to its public views; writes (submit_prediction, resolve_market,
 * claim_points) go through the TxProvider so they are tracked by exact hash.
 */
export type ProviderMode = "demo" | "live";

export type Verified<T> =
  | { status: "ok"; value: T; readAt: number }
  | { status: "unavailable"; reason: string };

/** get_market_candidate: provisional observation, NOT a settlement. */
export interface Candidate {
  openPrice: string;
  closePrice: string;
  outcome: Outcome;
  observedAtMs: number;
  confirmableAtMs: number;
}

/** get_market_result: the settlement the contract accepted. */
export interface Settlement {
  openPrice: string;
  closePrice: string;
  outcome: Outcome;
  firstObservedAtMs: number;
  resolvedAtMs: number;
}

export interface ChainMarket {
  openTimeMs: number;
  candidate: Candidate | null;
  result: Settlement | null;
}

/** get_prediction */
export interface ChainPrediction {
  pick: Outcome;
  submittedAtMs: number;
  processed: boolean; // true once claim_points ran
}

export interface ContractAdapter {
  readonly mode: ProviderMode;
  readMarket(openTimeMs: number): Promise<Verified<ChainMarket>>;
  readPrediction(wallet: string, openTimeMs: number): Promise<Verified<ChainPrediction | null>>;
  readPoints(wallet: string): Promise<Verified<number>>;
  /** Write + track provider. `getWalletProvider` is only called when a write happens. */
  txProvider(getWalletProvider: () => unknown): TxProvider;
}

export const CONTRACT_METHODS = { submit: "submit_prediction", resolve: "resolve_market", claim: "claim_points" } as const;
