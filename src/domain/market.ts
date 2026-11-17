export const DAY_MS = 86_400_000;

export type MarketPhase = "upcoming" | "open" | "closed";

export interface MarketWindow {
  /** UTC date, YYYY-MM-DD */
  date: string;
  openTime: number;
  closeTime: number; // exclusive: first ms of the next UTC day
}

export function utcDayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export function marketDate(openTime: number): string {
  return new Date(openTime).toISOString().slice(0, 10);
}

export function marketWindowFor(openTime: number): MarketWindow {
  const start = utcDayStart(openTime);
  return { date: marketDate(start), openTime: start, closeTime: start + DAY_MS };
}

/** The UTC day that contains `now`. */
export function currentMarket(now: number): MarketWindow {
  return marketWindowFor(now);
}

/** The UTC day that opens next. This is the market a user can still predict. */
export function nextMarket(now: number): MarketWindow {
  return marketWindowFor(utcDayStart(now) + DAY_MS);
}

/** Phase from the clock alone. Informational: the contract stays the authority. */
export function phaseAt(window: MarketWindow, now: number): MarketPhase {
  if (now < window.openTime) return "upcoming";
  if (now < window.closeTime) return "open";
  return "closed";
}

export function msUntil(target: number, now: number): number {
  return Math.max(0, target - now);
}

export function formatCountdown(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

export function formatUtcStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ") + " UTC";
}
