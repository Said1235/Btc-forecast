import { parseKlines, InvalidCandleError, type Candle } from "../domain/candle";

export type MarketDataErrorKind = "offline" | "timeout" | "rate_limited" | "unavailable" | "invalid" | "aborted";

export class MarketDataError extends Error {
  kind: MarketDataErrorKind;
  retryAfterMs?: number;
  constructor(kind: MarketDataErrorKind, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "MarketDataError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface MarketSnapshot {
  candles: Candle[];
  /** serverTime - local clock, measured at response midpoint. Add to Date.now() to get exchange time. */
  clockOffsetMs: number;
  receivedAt: number; // local ms
  source: "binance-spot" | "demo";
  /** true while this data was restored from the browser cache and not yet refreshed */
  fromCache?: boolean;
}

export interface FetchOptions {
  base?: string;
  limit?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export const DEFAULT_BASE = (import.meta.env?.VITE_BINANCE_BASE as string | undefined) || "https://api.binance.com";

async function getJson(url: string, o: Required<Pick<FetchOptions, "fetchImpl" | "timeoutMs">> & { signal?: AbortSignal }): Promise<unknown> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, o.timeoutMs);
  const onAbort = () => ctrl.abort();
  o.signal?.addEventListener("abort", onAbort);
  try {
    const res = await o.fetchImpl(url, { signal: ctrl.signal });
    if (res.status === 429 || res.status === 418) {
      const ra = Number(res.headers.get("retry-after"));
      throw new MarketDataError("rate_limited", "Binance is rate limiting requests.", Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000);
    }
    if (!res.ok) throw new MarketDataError("unavailable", `Binance answered with HTTP ${res.status}.`);
    try {
      return await res.json();
    } catch {
      throw new MarketDataError("invalid", "Binance returned a response that is not valid JSON.");
    }
  } catch (e) {
    if (e instanceof MarketDataError) throw e;
    if (timedOut) throw new MarketDataError("timeout", "Binance took too long to answer.");
    if (o.signal?.aborted) throw new MarketDataError("aborted", "Request cancelled.");
    if (typeof navigator !== "undefined" && navigator.onLine === false) throw new MarketDataError("offline", "This browser is offline.");
    throw new MarketDataError("unavailable", "Binance could not be reached.");
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
  }
}

/** Binance Spot BTCUSDT 1d klines + server time. Public endpoints, no keys. */
export async function fetchDailySnapshot(opts: FetchOptions = {}): Promise<MarketSnapshot> {
  const base = (opts.base ?? DEFAULT_BASE).replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? 8000;
  const now = opts.now ?? Date.now;
  const common = { fetchImpl, timeoutMs, signal: opts.signal };
  const t0 = now();
  const [klines, time] = await Promise.all([
    getJson(`${base}/api/v3/klines?symbol=BTCUSDT&interval=1d&timeZone=0&limit=${opts.limit ?? 60}`, common),
    getJson(`${base}/api/v3/time`, common),
  ]);
  const t1 = now();
  const serverTime = (time as { serverTime?: unknown })?.serverTime;
  if (typeof serverTime !== "number") throw new MarketDataError("invalid", "Binance did not return a server time.");
  let candles: Candle[];
  try {
    candles = parseKlines(klines);
  } catch (e) {
    if (e instanceof InvalidCandleError) throw new MarketDataError("invalid", e.message);
    throw e;
  }
  return { candles, clockOffsetMs: serverTime - Math.round((t0 + t1) / 2), receivedAt: t1, source: "binance-spot" };
}

/** Data older than maxAgeMs (default 3 poll cycles) must be shown as stale. */
export function isStale(receivedAt: number, now: number, maxAgeMs = 90_000): boolean {
  return now - receivedAt > maxAgeMs;
}

/** Clock drift beyond this is shown as a warning (local clock vs exchange). */
export const CLOCK_DRIFT_WARN_MS = 5_000;

/** Guards against older responses overwriting newer ones. */
export class LatestOnly {
  private seq = 0;
  private ctrl: AbortController | null = null;
  async run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<{ stale: true } | { stale: false; value: T }> {
    const id = ++this.seq;
    this.ctrl?.abort();
    const ctrl = (this.ctrl = new AbortController());
    try {
      const value = await fn(ctrl.signal);
      return id === this.seq ? { stale: false, value } : { stale: true };
    } catch (e) {
      if (id !== this.seq) return { stale: true };
      throw e;
    }
  }
  cancel() {
    this.seq++;
    this.ctrl?.abort();
  }
}

const CACHE_KEY = "btc-forecast:market-cache:v1";
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };

/** Remember the last good Binance snapshot so a reload while offline can show it, clearly labelled as cached. */
export function saveCache(s: MarketSnapshot, store: Store | undefined) {
  if (!store || s.source !== "binance-spot") return;
  try {
    store.setItem(CACHE_KEY, JSON.stringify({ candles: s.candles, clockOffsetMs: s.clockOffsetMs, receivedAt: s.receivedAt }));
  } catch { /* storage unavailable: no cache */ }
}

export function loadCache(store: Store | undefined): MarketSnapshot | null {
  if (!store) return null;
  try {
    const raw = store.getItem(CACHE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as { candles?: Candle[]; clockOffsetMs?: number; receivedAt?: number };
    if (!Array.isArray(j.candles) || !j.candles.length || typeof j.receivedAt !== "number") return null;
    const ok = j.candles.every((c) => [c.openTime, c.open, c.high, c.low, c.close].every((n) => typeof n === "number" && Number.isFinite(n)));
    if (!ok) return null;
    return { candles: j.candles, clockOffsetMs: Number(j.clockOffsetMs) || 0, receivedAt: j.receivedAt, source: "binance-spot", fromCache: true };
  } catch {
    return null;
  }
}
