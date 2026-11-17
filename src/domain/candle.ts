export type Outcome = "UP" | "DOWN" | "FLAT";

export interface Candle {
  openTime: number; // ms epoch, UTC
  closeTime: number; // ms epoch, inclusive end as reported by Binance
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** raw decimal strings, kept so equality is decided on exchange values, not rounded display */
  openRaw: string;
  closeRaw: string;
}

export class InvalidCandleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCandleError";
  }
}

const DAY = 86_400_000;

/** Binance kline row: [openTime, open, high, low, close, volume, closeTime, ...] */
export function parseKline(row: unknown): Candle {
  if (!Array.isArray(row) || row.length < 7) throw new InvalidCandleError("Kline row is incomplete");
  const [openTime, open, high, low, close, volume, closeTime] = row as unknown[];
  if (typeof openTime !== "number" || typeof closeTime !== "number") throw new InvalidCandleError("Kline times are not numbers");
  const nums = [open, high, low, close, volume].map((v) => (typeof v === "string" ? Number(v) : NaN));
  if (nums.some((n) => !Number.isFinite(n))) throw new InvalidCandleError("Kline prices are not numeric");
  const [o, h, l, c, v] = nums;
  if (h < l || h < Math.max(o, c) || l > Math.min(o, c)) throw new InvalidCandleError("Kline high/low are inconsistent");
  if (openTime % DAY !== 0) throw new InvalidCandleError("Daily candle does not start at 00:00 UTC");
  if (closeTime < openTime || closeTime >= openTime + DAY) throw new InvalidCandleError("Kline close time is outside its day");
  return { openTime, closeTime, open: o, high: h, low: l, close: c, volume: v, openRaw: open as string, closeRaw: close as string };
}

/** Parse a full payload: sorts, drops duplicates (last wins), rejects empty. */
export function parseKlines(payload: unknown): Candle[] {
  if (!Array.isArray(payload)) throw new InvalidCandleError("Klines payload is not a list");
  if (payload.length === 0) throw new InvalidCandleError("No candles returned");
  const byTime = new Map<number, Candle>();
  for (const row of payload) {
    const c = parseKline(row);
    byTime.set(c.openTime, c);
  }
  return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
}

/** Pure direction of two numeric values. Never use rounded/display values here. */
export function directionOf(open: number, close: number): Outcome {
  if (close > open) return "UP";
  if (close < open) return "DOWN";
  return "FLAT";
}

/** Final outcome of a candle. Returns null while the candle is still forming. */
export function finalOutcome(candle: Candle, now: number): Outcome | null {
  if (!isCandleComplete(candle, now)) return null;
  return directionOf(candle.open, candle.close);
}

export function isCandleComplete(candle: Candle, now: number): boolean {
  return now >= candle.openTime + DAY;
}

/** Merge fresh candles into existing ones by open time (fresh wins), sorted, no duplicates. */
export function mergeCandles(prev: Candle[], fresh: Candle[]): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of prev) m.set(c.openTime, c);
  for (const c of fresh) m.set(c.openTime, c);
  return [...m.values()].sort((a, b) => a.openTime - b.openTime);
}
