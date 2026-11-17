/**
 * Central control of RPC traffic to GenLayer StudioNet.
 *
 * Reads: deduplicated while in flight, cached with a TTL, limited in concurrency, and paused globally
 * when the RPC says it is rate limiting. Idempotent reads retry a limited number of times with
 * exponential backoff + jitter (honouring Retry-After).
 *
 * Writes: serialized per account+network, never retried here. After a rate limit a cool-down is
 * enforced BEFORE the wallet is asked to sign again.
 */

export class RateLimitedError extends Error {
  /** true only when the limit hit BEFORE anything was handed to the wallet or the network */
  provablyNotSent = false;
  constructor(message: string, public retryAfterMs: number, public cause?: unknown) {
    super(message);
    this.name = "RateLimitedError";
  }
}

const RATE_RE = /rate.?limit|too many requests|\b429\b|request is being rate limited/i;

/** Walks message, details, status, code and the cause chain. Works without an HTTP 429. */
export function isRateLimitError(e: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (x: unknown, d: number): boolean => {
    if (!x || d > 6 || seen.has(x)) return false;
    seen.add(x);
    if (typeof x === "string") return RATE_RE.test(x);
    if (typeof x !== "object") return false;
    const o = x as Record<string, unknown>;
    if (o.status === 429 || o.code === 429 || o.code === -32005) return true;
    return ["message", "details", "shortMessage", "reason"].some((k) => typeof o[k] === "string" && RATE_RE.test(o[k] as string)) || walk(o.cause, d + 1) || walk(o.data, d + 1) || walk(o.error, d + 1);
  };
  return walk(e, 0);
}

/** Retry-After in ms (seconds or HTTP date), searched along the cause chain. */
export function retryAfterMs(e: unknown, now = Date.now()): number | null {
  const seen = new Set<unknown>();
  const walk = (x: unknown, d: number): number | null => {
    if (!x || typeof x !== "object" || d > 6 || seen.has(x)) return null;
    seen.add(x);
    const o = x as { headers?: { get?: (k: string) => string | null } | Record<string, string>; retryAfter?: unknown; cause?: unknown };
    let raw: unknown = o.retryAfter;
    const h = o.headers as { get?: (k: string) => string | null } & Record<string, string> | undefined;
    if (raw === undefined && h) raw = typeof h.get === "function" ? h.get("retry-after") : (h["retry-after"] ?? h["Retry-After"]);
    if (typeof raw === "number" && raw >= 0) return raw * 1000;
    if (typeof raw === "string" && raw.trim()) {
      if (/^\d+$/.test(raw.trim())) return Number(raw) * 1000;
      const t = Date.parse(raw);
      if (Number.isFinite(t)) return Math.max(0, t - now);
    }
    return walk(o.cause, d + 1);
  };
  return walk(e, 0);
}

export interface GateOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxConcurrent?: number;
  minGapMs?: number;
  maxReadRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface ReadOptions {
  /** ms the result stays fresh and shared by every component */
  ttl?: number;
}

/** Exponential backoff with full jitter on top of a floor. */
export function backoffMs(failures: number, base: number, max: number, random: () => number): number {
  const exp = Math.min(max, base * 2 ** Math.max(0, failures - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

export class RpcGate {
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private random: () => number;
  private maxConcurrent: number;
  private minGap: number;
  private maxRetries: number;
  private base: number;
  private max: number;
  private inflight = new Map<string, Promise<unknown>>();
  private cache = new Map<string, { at: number; ttl: number; value: unknown }>();
  private active = 0;
  private waiters: Array<() => void> = [];
  private lastStart = 0;
  private readFailures = 0;
  private pausedUntil = 0;
  private chains = new Map<string, Promise<unknown>>();
  private writeBlock = new Map<string, { until: number; failures: number }>();
  /** counters for diagnostics and tests */
  stats = { reads: 0, cacheHits: 0, deduped: 0, rateLimited: 0, writes: 0 };

  constructor(o: GateOptions = {}) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = o.random ?? Math.random;
    this.maxConcurrent = o.maxConcurrent ?? 3;
    this.minGap = o.minGapMs ?? 120;
    this.maxRetries = o.maxReadRetries ?? 3;
    this.base = o.baseBackoffMs ?? 2000;
    this.max = o.maxBackoffMs ?? 60_000;
  }

  /** Remaining global read pause, 0 when reads flow. */
  pausedForMs(): number {
    return Math.max(0, this.pausedUntil - this.now());
  }

  invalidate(prefix = ""): void {
    for (const k of [...this.cache.keys()]) if (k.startsWith(prefix)) this.cache.delete(k);
  }

  private pause(e: unknown): number {
    this.readFailures += 1;
    this.stats.rateLimited += 1;
    const wait = Math.max(retryAfterMs(e, this.now()) ?? 0, backoffMs(this.readFailures, this.base, this.max, this.random));
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
    return wait;
  }

  private async slot(): Promise<void> {
    if (this.active >= this.maxConcurrent) await new Promise<void>((r) => this.waiters.push(r));
    this.active += 1;
    const gap = this.lastStart + this.minGap - this.now();
    this.lastStart = Math.max(this.now(), this.lastStart + this.minGap);
    if (gap > 0) await this.sleep(gap);
  }
  private release() {
    this.active -= 1;
    this.waiters.shift()?.();
  }

  /** Shared, deduplicated, cached, rate-limit-aware read. */
  read<T>(key: string, fn: () => Promise<T>, opts: ReadOptions = {}): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < hit.ttl) {
      this.stats.cacheHits += 1;
      return Promise.resolve(hit.value as T);
    }
    const running = this.inflight.get(key);
    if (running) {
      this.stats.deduped += 1;
      return running as Promise<T>;
    }
    const p = this.run(key, fn, opts).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async run<T>(key: string, fn: () => Promise<T>, opts: ReadOptions): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.pausedForMs();
      if (wait > 0) await this.sleep(wait);
      await this.slot();
      try {
        this.stats.reads += 1;
        const v = await fn();
        this.readFailures = 0;
        if (opts.ttl && opts.ttl > 0) this.cache.set(key, { at: this.now(), ttl: opts.ttl, value: v });
        return v;
      } catch (e) {
        if (!isRateLimitError(e)) throw e;
        const w = this.pause(e);
        if (attempt >= this.maxRetries) throw new RateLimitedError("The StudioNet RPC is temporarily limiting requests.", w, e);
      } finally {
        this.release();
      }
    }
  }

  /** Remaining cool-down before this account may be asked to sign again. */
  writeBlockedForMs(key: string): number {
    const b = this.writeBlock.get(key);
    return b ? Math.max(0, b.until - this.now()) : 0;
  }

  /** Record a write that the RPC rate limited. Returns the cool-down in ms. */
  noteWriteRateLimit(key: string, e: unknown): number {
    const prev = this.writeBlock.get(key)?.failures ?? 0;
    const failures = prev + 1;
    const wait = Math.max(retryAfterMs(e, this.now()) ?? 0, backoffMs(failures, 5000, this.max, this.random));
    this.writeBlock.set(key, { until: this.now() + wait, failures });
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + Math.min(wait, 15_000)); // let reads breathe too
    return wait;
  }
  noteWriteOk(key: string): void {
    this.writeBlock.delete(key);
  }

  /** Refused before anything is handed to the wallet: provably not sent. */
  private cooling(ms: number): RateLimitedError {
    const e = new RateLimitedError("The StudioNet RPC is cooling down after limiting requests. Wait before signing again.", ms);
    e.provablyNotSent = true;
    return e;
  }

  /** Writes for one key run strictly one after another. Never retried here. */
  write<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const blocked = this.writeBlockedForMs(key);
    if (blocked > 0) return Promise.reject(this.cooling(blocked));
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => {
      const again = this.writeBlockedForMs(key);
      if (again > 0) throw this.cooling(again);
      this.stats.writes += 1;
      return fn();
    });
    this.chains.set(key, next);
    void next.catch(() => undefined).then(() => { if (this.chains.get(key) === next) this.chains.delete(key); });
    return next;
  }
}

/** One gate per page: every component and client shares it. */
export const rpcGate = new RpcGate();
