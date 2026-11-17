import { DAY_MS, utcDayStart } from "../domain/market";
import type { Candle, Outcome } from "../domain/candle";
import { directionOf } from "../domain/candle";
import type { ContractAdapter, MarketContractState, SubmitOutcome, UserPrediction, Verified } from "./contract/adapter";

/** Deterministic PRNG (mulberry32) so the demo fixtures never change between runs. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** DEMO candles. Anchored to the UTC day of `now`, shapes fixed by seed. Never live data. */
export function demoCandles(now: number, count = 60): Candle[] {
  const r = rng(20261116);
  const today = utcDayStart(now);
  let price = 78_000;
  const out: Candle[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const openTime = today - i * DAY_MS;
    const open = Math.round(price * 100) / 100;
    const drift = (r() - 0.48) * 0.035;
    const close = i === 0 ? open + (r() - 0.45) * 900 : open * (1 + drift);
    const hi = Math.max(open, close) * (1 + r() * 0.012);
    const lo = Math.min(open, close) * (1 - r() * 0.012);
    const c = Math.round(close * 100) / 100;
    out.push({
      openTime, closeTime: openTime + DAY_MS - 1, open, high: Math.round(hi * 100) / 100, low: Math.round(lo * 100) / 100, close: c,
      volume: Math.round(9000 + r() * 6000), openRaw: open.toFixed(2), closeRaw: c.toFixed(2),
    });
    price = c;
  }
  return out;
}

export const DEMO_WALLET = "0xDEMO000000000000000000000000000000000000";

/** In-memory demo adapter. Nothing here is read from or written to a contract. */
export function createDemoAdapter(candles: Candle[]): ContractAdapter {
  const picks = new Map<string, Outcome>();
  const key = (w: string, m: string) => `${w}|${m}`;
  const ok = <T,>(value: T): Verified<T> => ({ status: "ok", value, readAt: Date.now() });
  const history = (): UserPrediction[] => {
    const done = candles.slice(-8, -1).reverse();
    const mine: Outcome[] = ["UP", "UP", "DOWN", "FLAT", "DOWN", "UP", "UP"];
    return done.map((c, i) => {
      const date = new Date(c.openTime).toISOString().slice(0, 10);
      return { marketId: date, wallet: DEMO_WALLET, pick: mine[i], correct: mine[i] === directionOf(c.open, c.close) };
    });
  };
  let n = 0;
  return {
    mode: "demo",
    configured: true,
    async readMarket(marketId): Promise<Verified<MarketContractState>> {
      return ok({ marketId, predictionsOpen: true, resolved: false, result: null, final: false });
    },
    async readUserPrediction(wallet, marketId) {
      const pick = picks.get(key(wallet, marketId));
      return ok(pick ? { marketId, wallet, pick, correct: null } : null);
    },
    async readUserPoints() {
      return ok(history().filter((h) => h.correct).length);
    },
    async readHistory() {
      return ok(history());
    },
    async submitPrediction(req): Promise<SubmitOutcome> {
      picks.set(key(req.wallet, req.marketId), req.pick);
      n += 1;
      return { kind: "hash", txHash: `demo-${String(n).padStart(4, "0")}` };
    },
  };
}
