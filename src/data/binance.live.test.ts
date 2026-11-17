// Real network test against the official Binance Spot API. Skipped unless LIVE_BINANCE=1.
//   LIVE_BINANCE=1 npx vitest run src/data/binance.live.test.ts
import { describe, it, expect } from "vitest";
import { fetchDailySnapshot } from "./binance";
import { DAY_MS, utcDayStart } from "../domain/market";

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
describe.runIf(env.LIVE_BINANCE === "1")("Binance Spot (real network)", () => {
  it("loads real BTCUSDT 1d candles with UTC boundaries and a sane server clock", async () => {
    const s = await fetchDailySnapshot({ limit: 30, timeoutMs: 15000 });
    expect(s.candles.length).toBeGreaterThan(20);
    for (const c of s.candles) {
      expect(c.openTime % DAY_MS).toBe(0);
      expect(c.closeTime).toBe(c.openTime + DAY_MS - 1);
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
      expect(c.open).toBeGreaterThan(1000);
    }
    const last = s.candles.at(-1)!;
    const exchangeNow = Date.now() + s.clockOffsetMs;
    expect(last.openTime).toBe(utcDayStart(exchangeNow)); // newest candle is today's UTC day
    expect(Math.abs(s.clockOffsetMs)).toBeLessThan(60_000);
    console.log("live OK:", s.candles.length, "candles, last", new Date(last.openTime).toISOString(), "close", last.close, "offset ms", s.clockOffsetMs);
  }, 30000);
});
