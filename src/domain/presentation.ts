import type { MarketPhase } from "./market";

export type SelectorMode = "edit" | "locked" | "unverified" | "submitted";

export interface PresentationInput {
  phase: MarketPhase; // from the clock: informational only
  mode: "demo" | "live";
  contractConfigured: boolean;
  /** an unresolved or finalized-ok operation exists for this wallet + market */
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
    return { selector: "locked", canReview: false, unverified: i.mode === "live" && !i.contractConfigured, reason: "This market has opened. By the product rules, predictions are locked." };
  if (i.hasUnresolvedTx)
    return { selector: "submitted", canReview: false, unverified: false, reason: "An operation for this market is still being tracked." };
  if (i.mode === "demo")
    return { selector: "edit", canReview: true, unverified: false, reason: "Demo mode: nothing you do here is recorded anywhere." };
  if (!i.contractConfigured)
    return { selector: "unverified", canReview: false, unverified: true, reason: "The contract is not connected yet, so this app cannot verify or record predictions." };
  return { selector: "unverified", canReview: false, unverified: true, reason: "The contract state could not be verified." };
}
