import { DAY_MS, utcDayStart } from "../domain/market";
import { directionOf, type Candle, type Outcome } from "../domain/candle";
import type { ChainMarket, ChainPrediction, ContractAdapter, Verified } from "./contract/adapter";
import { CONTRACT_METHODS } from "./contract/adapter";
import type { ReceiptView, SubmitContext, TxProvider } from "../tx/types";

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
    out.push({ openTime, closeTime: openTime + DAY_MS - 1, open, high: Math.round(hi * 100) / 100, low: Math.round(lo * 100) / 100, close: c, volume: Math.round(9000 + r() * 6000), openRaw: open.toFixed(2), closeRaw: c.toFixed(2) });
    price = c;
  }
  return out;
}

export const DEMO_WALLET = "0xDEMO000000000000000000000000000000000000";
const CONFIRM_MS = 6000; // demo shortens the 5 minute confirmation interval

/** In-memory demo of the whole lifecycle. Nothing here is read from or written to a contract. */
export function createDemoAdapter(candles: Candle[], now0: number): ContractAdapter {
  const byTime = new Map(candles.map((c) => [c.openTime, c]));
  const preds = new Map<number, { pick: Outcome; at: number; processed: boolean }>();
  const results = new Map<number, ChainMarket["result"]>();
  const cands = new Map<number, ChainMarket["candidate"]>();
  const today = utcDayStart(now0);
  const seed: Outcome[] = ["UP", "UP", "DOWN", "FLAT", "DOWN"];
  // days -6..-2 are settled and claimed; day -1 is waiting for resolution (so every action can be tried)
  for (let i = 2; i <= 6; i++) {
    const t = today - i * DAY_MS, c = byTime.get(t);
    if (!c) continue;
    preds.set(t, { pick: seed[i - 2], at: t - 3600_000, processed: true });
    results.set(t, { openPrice: c.openRaw, closePrice: c.closeRaw, outcome: directionOf(c.open, c.close), firstObservedAtMs: t + DAY_MS + 300_000, resolvedAtMs: t + DAY_MS + 700_000 });
  }
  preds.set(today - DAY_MS, { pick: "UP", at: today - DAY_MS - 3600_000, processed: false });
  const ok = <T,>(value: T): Verified<T> => ({ status: "ok", value, readAt: Date.now() });
  const pointsOf = () => [...preds].filter(([t, p]) => p.processed && results.get(t)?.outcome === p.pick).length;

  const provider: TxProvider = {
    async submit(ctx: SubmitContext) {
      await new Promise((r) => setTimeout(r, 500));
      const t = ctx.marketOpenTime;
      if (ctx.method === CONTRACT_METHODS.submit && ctx.args.pick) preds.set(t, { pick: ctx.args.pick, at: Date.now(), processed: false });
      if (ctx.method === CONTRACT_METHODS.resolve) {
        const c = byTime.get(t);
        if (c && !results.get(t)) {
          const ev = { openPrice: c.openRaw, closePrice: c.closeRaw, outcome: directionOf(c.open, c.close) };
          const prev = cands.get(t);
          if (prev && Date.now() >= prev.confirmableAtMs) results.set(t, { ...ev, firstObservedAtMs: prev.observedAtMs, resolvedAtMs: Date.now() });
          else cands.set(t, { ...ev, observedAtMs: Date.now(), confirmableAtMs: Date.now() + CONFIRM_MS });
        }
      }
      if (ctx.method === CONTRACT_METHODS.claim) {
        const p = preds.get(t);
        if (p) p.processed = true;
      }
      return { kind: "hash" as const, txHash: `demo-${ctx.method.slice(0, 3)}-${String(++n).padStart(4, "0")}` };
    },
    async getReceipt(hash): Promise<ReceiptView> {
      const k = (polls.get(hash) ?? 0) + 1;
      polls.set(hash, k);
      const phases: ReceiptView[] = [{ phase: "processing" }, { phase: "decision" }, { phase: "finalizing" }];
      return phases[k - 1] ?? { phase: "finalized", executionOk: true, executionResult: "DEMO_OK" };
    },
    async readBack(e) {
      const t = e.marketOpenTime;
      if (e.method === CONTRACT_METHODS.resolve) return { ok: !!(results.get(t) || cands.get(t)), observed: results.get(t) ? "resolved" : cands.get(t) ? "candidate" : "none" };
      const p = preds.get(t);
      if (e.method === CONTRACT_METHODS.claim) return { ok: !!p?.processed, observed: p?.processed ? "claimed" : "not claimed" };
      return { ok: p?.pick === e.args.pick, observed: p?.pick ?? "no prediction" };
    },
  };
  let n = 0;
  const polls = new Map<string, number>();
  return {
    mode: "demo",
    async readMarket(t) { return ok<ChainMarket>({ openTimeMs: t, candidate: cands.get(t) ?? null, result: results.get(t) ?? null }); },
    async readPrediction(_w, t) {
      const p = preds.get(t);
      return ok<ChainPrediction | null>(p ? { pick: p.pick, submittedAtMs: p.at, processed: p.processed } : null);
    },
    async readPoints() { return ok(pointsOf()); },
    txProvider: () => provider,
  };
}
