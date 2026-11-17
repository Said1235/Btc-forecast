import type { Outcome } from "./candle";

export const OUTCOMES: readonly Outcome[] = ["UP", "DOWN", "FLAT"] as const;

export const OUTCOME_COPY: Record<Outcome, { rule: string; short: string }> = {
  UP: { rule: "Close is above the open", short: "close > open" },
  DOWN: { rule: "Close is below the open", short: "close < open" },
  FLAT: { rule: "Close equals the open exactly", short: "close = open" },
};

export function isOutcome(v: unknown): v is Outcome {
  return v === "UP" || v === "DOWN" || v === "FLAT";
}

export function validatePick(pick: unknown): { ok: true; pick: Outcome } | { ok: false; error: string } {
  if (pick === null || pick === undefined || pick === "") return { ok: false, error: "Choose UP, DOWN or FLAT first." };
  if (!isOutcome(pick)) return { ok: false, error: "That is not a valid option." };
  return { ok: true, pick };
}
