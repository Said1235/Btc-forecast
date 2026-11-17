import { DAY_MS } from "./market";

/** Policy constants copied from contracts/btc_forecast.py (the contract stays the authority). */
export const RESOLUTION_GRACE_MS = 300_000;
export const CONFIRMATION_INTERVAL_MS = 300_000;
export const HORIZON_MS = 7 * DAY_MS;

export type ResolveAction =
  | { kind: "wait"; until: number } // resolution window not open yet
  | { kind: "start" } // no candidate: anyone can record the first observation
  | { kind: "wait-confirm"; until: number } // candidate recorded, interval not elapsed
  | { kind: "confirm" }; // interval elapsed: next resolve_market can settle

/** What a resolve_market call would do for an unresolved, closed market. Informational. */
export function resolveAction(openTimeMs: number, now: number, candidate: { confirmableAtMs: number } | null): ResolveAction {
  const opens = openTimeMs + DAY_MS + RESOLUTION_GRACE_MS;
  if (now < opens) return { kind: "wait", until: opens };
  if (!candidate) return { kind: "start" };
  if (now < candidate.confirmableAtMs) return { kind: "wait-confirm", until: candidate.confirmableAtMs };
  return { kind: "confirm" };
}
