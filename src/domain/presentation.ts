import type { MarketPhase } from "./market";

export type SelectorMode = "edit" | "locked" | "unverified" | "submitted";

export interface PresentationInput {
  phase: MarketPhase; // from the clock: informational only
  mode: "demo" | "live";
  /** false when contract reads failed, so its state cannot be verified */
  contractReadable: boolean;
  /** an operation for this wallet + market is still unresolved */
  hasUnresolvedTx: boolean;
}

export interface Presentation {
  selector: SelectorMode;
  /** can the user press "Review prediction"? */
  canReview: boolean;
  /** true when we can only guess the contract's state */
  unverified: boolean;
  reason: string;
}

/**
 * The client clock can inform the user but never enforces a contract rule.
 * Live mode without a configured contract cannot verify anything, so it says so.
 */
export function derivePresentation(i: PresentationInput): Presentation {
  if (i.phase !== "upcoming")
    return { selector: "locked", canReview: false, unverified: i.mode === "live" && !i.contractReadable, reason: "This market has opened. Predictions are locked." };
  if (i.hasUnresolvedTx)
    return { selector: "submitted", canReview: false, unverified: false, reason: "An operation for this market is still being tracked." };
  if (i.mode === "demo")
    return { selector: "edit", canReview: true, unverified: false, reason: "Demo mode: nothing you do here is recorded anywhere." };
  if (!i.contractReadable)
    return { selector: "unverified", canReview: false, unverified: true, reason: "The contract state could not be read, so this app cannot verify whether predictions are open." };
  return { selector: "edit", canReview: true, unverified: false, reason: "Open until this market's 00:00 UTC start. You can change your call before then." };
}
