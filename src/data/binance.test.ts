import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchDailySnapshot, isStale, LatestOnly, MarketDataError } from "./binance";
import { DAY_MS } from "../domain/market";

const D = Date.UTC(2026, 10, 15);
const kl = (t: number, c = "105.00") => [t, "100.00", "110.00", "90.00", c, "1", t + DAY_MS - 1];
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const route = (klines: () => Response | Promise<Response>, time: () => Response | Promise<Response> = () => json({ serverTime: D + 5000 })) =>
  vi.fn(async (url: string | URL | Request) => (String(url).includes("/time") ? time() : klines())) as unknown as typeof fetch;
afterEach(() => vi.useRealTimers());

describe("Binance provider", () => {
  it("parses a valid response and measures clock offset", async () => {
    const s = await fetchDailySnapshot({ fetchImpl: route(() => json([kl(D)])), now: () => D });
    expect(s.candles).toHaveLength(1);
    expect(s.clockOffsetMs).toBe(5000);
    expect(s.source).toBe("binance-spot");
  });
  it("rejects an empty response", async () => {
    await expect(fetchDailySnapshot({ fetchImpl: route(() => json([])) })).rejects.toMatchObject({ kind: "invalid" });
  });
  it("rejects a malformed payload", async () => {
    await expect(fetchDailySnapshot({ fetchImpl: route(() => json([["x"]])) })).rejects.toMatchObject({ kind: "invalid" });
    await expect(fetchDailySnapshot({ fetchImpl: route(() => json([kl(D)]), () => json({})) })).rejects.toMatchObject({ kind: "invalid" });
  });
  it("reports rate limiting with Retry-After", async () => {
    const e = await fetchDailySnapshot({ fetchImpl: route(() => json({}, 429, { "retry-after": "30" })) }).catch((x) => x);
    expect(e).toBeInstanceOf(MarketDataError);
    expect(e.kind).toBe("rate_limited");
    expect(e.retryAfterMs).toBe(30_000);
  });
  it("reports HTTP errors as unavailable", async () => {
    await expect(fetchDailySnapshot({ fetchImpl: route(() => json({}, 503)) })).rejects.toMatchObject({ kind: "unavailable" });
  });
  it("times out", async () => {
    const hang = ((_u: string, init?: RequestInit) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("abort"))))) as unknown as typeof fetch;
    await expect(fetchDailySnapshot({ fetchImpl: hang, timeoutMs: 10 })).rejects.toMatchObject({ kind: "timeout" });
  });
  it("reports offline", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const down = (async () => { throw new TypeError("failed"); }) as unknown as typeof fetch;
    await expect(fetchDailySnapshot({ fetchImpl: down })).rejects.toMatchObject({ kind: "offline" });
    vi.restoreAllMocks();
  });
  it("marks data stale after the max age", () => {
    expect(isStale(1000, 1000 + 89_000)).toBe(false);
    expect(isStale(1000, 1000 + 91_000)).toBe(true);
  });
  it("a UTC boundary change moves to the next candle", async () => {
    const s = await fetchDailySnapshot({ fetchImpl: route(() => json([kl(D), kl(D + DAY_MS)])) });
    expect(s.candles.at(-1)!.openTime).toBe(D + DAY_MS);
  });
});

describe("out-of-order responses", () => {
  it("an older response never overwrites a newer one", async () => {
    const lo = new LatestOnly();
    let releaseSlow!: (v: string) => void;
    const slow = lo.run(() => new Promise<string>((r) => (releaseSlow = r)));
    const fast = await lo.run(async () => "new");
    releaseSlow("old");
    expect(fast).toEqual({ stale: false, value: "new" });
    expect(await slow).toEqual({ stale: true });
  });
  it("cancels the obsolete request", async () => {
    const lo = new LatestOnly();
    let first!: AbortSignal;
    void lo.run((s) => ((first = s), new Promise(() => {})));
    await lo.run(async () => 1);
    expect(first.aborted).toBe(true);
  });
});

import { mergeCandles, parseKlines } from "../domain/candle";
import { saveCache, loadCache } from "./binance";
import { MemoryStore } from "../tx/journal";

describe("incremental updates and cache", () => {
  const k = (t: number, c: string) => [t, "100.00", "200.00", "50.00", c, "1", t + DAY_MS - 1];
  it("merges the forming candle in place and appends a new UTC day", () => {
    const base = parseKlines([k(D - DAY_MS, "101.00"), k(D, "102.00")]);
    const upd = mergeCandles(base, parseKlines([k(D, "150.00"), k(D + DAY_MS, "100.00")]));
    expect(upd.map((c) => c.openTime)).toEqual([D - DAY_MS, D, D + DAY_MS]);
    expect(upd[1].close).toBe(150);
  });
  it("sends timeZone=0 and uses the documented endpoints", async () => {
    const f = route(() => json([k(D, "105.00")]));
    await fetchDailySnapshot({ fetchImpl: f, limit: 3, now: () => D });
    const urls = (f as unknown as { mock: { calls: [string][] } }).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/api/v3/klines?symbol=BTCUSDT&interval=1d&timeZone=0&limit=3"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/api/v3/time"))).toBe(true);
  });
  it("accepts Binance's real 12-field rows", async () => {
    const full = [D, "81000.10", "82000.00", "80000.00", "81500.55", "1234.5", D + DAY_MS - 1, "1.0", 100, "1.0", "1.0", "0"];
    const s = await fetchDailySnapshot({ fetchImpl: route(() => json([full])), now: () => D });
    expect(s.candles[0]).toMatchObject({ open: 81000.1, close: 81500.55, volume: 1234.5 });
  });
  it("round-trips a snapshot through the cache and marks it as cached", async () => {
    const s = await fetchDailySnapshot({ fetchImpl: route(() => json([k(D, "105.00")])), now: () => D });
    const store = new MemoryStore();
    saveCache(s, store);
    const back = loadCache(store);
    expect(back?.fromCache).toBe(true);
    expect(back?.candles[0].close).toBe(105);
  });
  it("ignores corrupt cache and never caches demo data", () => {
    const store = new MemoryStore();
    store.setItem("btc-forecast:market-cache:v1", "{bad");
    expect(loadCache(store)).toBeNull();
    saveCache({ candles: [], clockOffsetMs: 0, receivedAt: 1, source: "demo" }, store);
    expect(loadCache(new MemoryStore())).toBeNull();
  });
});
