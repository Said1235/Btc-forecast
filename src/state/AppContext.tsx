import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { CLOCK_DRIFT_WARN_MS, fetchDailySnapshot, isStale, LatestOnly, loadCache, MarketDataError, saveCache, type MarketSnapshot } from "../data/binance";
import { mergeCandles } from "../domain/candle";
import { createDemoAdapter, DEMO_WALLET, demoCandles } from "../data/demo";
import { createGenLayerAdapter } from "../data/contract/genlayerAdapter";
import type { ChainMarket, ChainPrediction, ContractAdapter, Verified } from "../data/contract/adapter";
import { addChainParams, readConfig, type GenLayerConfig } from "../config";
import { DAY_MS, utcDayStart } from "../domain/market";
import { MemoryStore, TxJournal } from "../tx/journal";
import { TxTracker } from "../tx/tracker";
import type { JournalEntry } from "../tx/types";
import { WalletController, type WalletState } from "../wallet/controller";
import { DuplicateSubmissionError } from "../tx/tracker";
import type { Outcome } from "../domain/candle";
import { marketWindowFor } from "../domain/market";

export type Mode = "demo" | "live";
const POLL_MS = 15_000; // incremental refresh of the forming candle (limit=3, weight 2)
const FULL_RELOAD_MS = 10 * 60_000;

export interface MarketDataState {
  status: "loading" | "ok" | "error";
  snapshot: MarketSnapshot | null; // last successful snapshot, kept visible when a refresh fails
  error: MarketDataError | null;
  stale: boolean;
  driftMs: number;
  /** exchange-adjusted "now", ticks each second */
  now: number;
}

export interface Toast { id: number; text: string }

interface Ctx {
  mode: Mode;
  setMode: (m: Mode) => void;
  theme: "light" | "dark" | "system";
  cycleTheme: () => void;
  md: MarketDataState;
  refresh: () => void;
  wallet: WalletState;
  walletApi: WalletController;
  wrongNetwork: boolean;
  account: string | null; // effective account for reads and writes
  adapter: ContractAdapter;
  tracker: TxTracker;
  entries: JournalEntry[];
  user: UserData;
  refetchUser: () => void;
  toasts: Toast[];
  toast: (t: string) => void;
  netInfo: { networkId: string; chainId: number; contractAddress: string };
  config: GenLayerConfig;
  /** Run one contract write through the journal. Returns an error string instead of throwing. */
  act: (method: "submit_prediction" | "resolve_market" | "claim_points", openTimeMs: number, pick?: Outcome) => Promise<{ entry?: JournalEntry; error?: string }>;
}

export interface MarketRow {
  openTimeMs: number;
  market: Verified<ChainMarket>;
  prediction: Verified<ChainPrediction | null>;
}

export interface UserData {
  status: "idle" | "loading" | "ok" | "unavailable";
  reason?: string;
  points: number | null;
  rows: Map<number, MarketRow>;
}

const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside provider");
  return c;
};

function useStore<T>(sub: (l: () => void) => () => void, get: () => T) {
  return useSyncExternalStore(sub, get, get);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(() => {
    try { return new URLSearchParams(location.search).get("demo") === "1" || sessionStorage.getItem("btcf:mode") === "demo" ? "demo" : "live"; } catch { return "live"; }
  });
  const setMode = useCallback((m: Mode) => {
    try { sessionStorage.setItem("btcf:mode", m); } catch { /* ignore */ }
    setModeState(m);
  }, []);
  const [theme, setTheme] = useState<"light" | "dark" | "system">(() => {
    try { return (localStorage.getItem("btcf:theme") as "light" | "dark" | null) ?? "system"; } catch { return "system"; }
  });
  useEffect(() => {
    const r = document.documentElement;
    if (theme === "system") r.removeAttribute("data-theme"); else r.setAttribute("data-theme", theme);
    try {
      if (theme === "system") localStorage.removeItem("btcf:theme");
      else localStorage.setItem("btcf:theme", theme);
    } catch { /* ignore */ }
  }, [theme]);
  const cycleTheme = useCallback(() => setTheme((t) => (t === "system" ? "dark" : t === "dark" ? "light" : "system")), []);

  /* ---------- market data ---------- */
  const [bootNow] = useState(() => Date.now());
  const [liveMd, setLiveMd] = useState<Omit<MarketDataState, "now" | "stale" | "driftMs">>(() => {
    const cached = loadCache(safeStorage());
    return { status: "loading", snapshot: cached, error: null };
  });
  const lastFull = useRef(0);
  const [tick, setTick] = useState(() => Date.now());
  const latest = useRef(new LatestOnly());
  const backoffUntil = useRef(0);
  const demoMd = useMemo<Omit<MarketDataState, "now" | "stale" | "driftMs">>(
    () => ({ status: "ok", snapshot: { candles: demoCandles(bootNow), clockOffsetMs: 0, receivedAt: bootNow, source: "demo" }, error: null }),
    [bootNow],
  );
  const md = mode === "demo" ? demoMd : liveMd;

  const load = useCallback(async (forceFull = false) => {
    if (mode === "demo" || Date.now() < backoffUntil.current) return;
    const full = forceFull || Date.now() - lastFull.current > FULL_RELOAD_MS;
    try {
      const res = await latest.current.run((signal) => fetchDailySnapshot({ signal, limit: full ? 60 : 3 }));
      if (res.stale) return;
      if (full) lastFull.current = Date.now();
      setLiveMd((p) => {
        const base = !full && p.snapshot ? mergeCandles(p.snapshot.candles, res.value.candles) : res.value.candles;
        const snap: MarketSnapshot = { ...res.value, candles: base, fromCache: false };
        saveCache(snap, safeStorage());
        return { status: "ok", snapshot: snap, error: null };
      });
    } catch (e) {
      const err = e instanceof MarketDataError ? e : new MarketDataError("unavailable", "Market data failed to load.");
      if (err.kind === "aborted") return;
      if (err.kind === "rate_limited") backoffUntil.current = Date.now() + (err.retryAfterMs ?? 60_000);
      setLiveMd((p) => ({ status: "error", snapshot: p.snapshot, error: err })); // keep the last real data visible, flagged
    }
  }, [mode]);

  useEffect(() => {
    if (mode === "demo") return;
    void load(true);
    const id = setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    const onOnline = () => void load(true);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onOnline);
    const lo = latest.current;
    return () => { clearInterval(id); window.removeEventListener("online", onOnline); document.removeEventListener("visibilitychange", onOnline); lo.cancel(); };
  }, [mode, load]);

  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const offset = md.snapshot?.clockOffsetMs ?? 0;
  const mdFull: MarketDataState = {
    ...md,
    now: tick + offset,
    stale: md.snapshot ? md.snapshot.source === "binance-spot" && (isStale(md.snapshot.receivedAt, tick) || md.status === "error" || !!md.snapshot.fromCache) : false,
    driftMs: offset,
  };
  void CLOCK_DRIFT_WARN_MS;

  /* ---------- wallet ---------- */
  const config = useMemo(() => readConfig(), []);
  const walletApi = useMemo(() => new WalletController({ expectedChainId: config.chainId, addChainParams: addChainParams(config), storage: safeStorage() }), [config]);
  useEffect(() => {
    walletApi.discover();
    void walletApi.restore(); // silent; never opens a wallet prompt
    return () => walletApi.destroy();
  }, [walletApi]);
  const wallet = useStore(walletApi.subscribe, walletApi.getState);
  const account = mode === "demo" ? DEMO_WALLET : wallet.account;

  /* ---------- contract adapter + tx ---------- */
  const adapter = useMemo<ContractAdapter>(() => (mode === "demo" ? createDemoAdapter(demoCandles(bootNow), bootNow) : createGenLayerAdapter(config)), [mode, config, bootNow]);
  const journal = useMemo(() => new TxJournal(mode === "demo" ? new MemoryStore() : safeStorage() ?? new MemoryStore(), `btc-forecast:tx-journal:v1:${mode}`), [mode]);
  const tracker = useMemo(
    () => new TxTracker(journal, adapter.txProvider(() => walletApi.currentProvider()), { pollMs: mode === "demo" ? 700 : 5000 }),
    [journal, adapter, mode, walletApi],
  );
  useEffect(() => { if (mode === "live") void tracker.resumeAll(); }, [tracker, mode]);
  const entries = useStore(journal.subscribe, journal.snapshot);
  const netInfo = mode === "demo" ? { networkId: "demo", chainId: 0, contractAddress: "demo" } : { networkId: config.network, chainId: config.chainId, contractAddress: config.contractAddress };

  /* ---------- user data, scoped to the effective account ---------- */
  const [userState, setUserState] = useState<{ key: string; data: UserData } | null>(null);
  const [userVer, setUserVer] = useState(0);
  const refetchUser = useCallback(() => setUserVer((v) => v + 1), []);
  useEffect(() => {
    if (mode !== "live") return;
    const id = setInterval(() => { if (document.visibilityState === "visible") setUserVer((v) => v + 1); }, 120_000);
    return () => clearInterval(id);
  }, [mode]);
  const doneCount = entries.filter((e) => e.state === "finalized-ok").length;
  const dayKey = utcDayStart(mdFull.now);
  const userKey = account ? `${mode}|${account}|${userVer}|${doneCount}|${dayKey}` : null;
  useEffect(() => {
    if (!account || !userKey) return;
    let cancelled = false;
    (async () => {
      // next market, today, and the last 7 closed markets. Every value comes from a contract view.
      const times = Array.from({ length: 9 }, (_, i) => dayKey + DAY_MS - i * DAY_MS);
      // Predictions first (1 call each). Market views only where they are needed: the two markets on screen
      // and any market the user predicted. Everything goes through the shared RPC gate (cache + dedupe + pacing).
      const [pts, ...preds] = await Promise.all([adapter.readPoints(account), ...times.map((t) => adapter.readPrediction(account, t))]);
      const needed = times.filter((_t, i) => i < 2 || (preds[i].status === "ok" && preds[i].value));
      const markets = new Map(await Promise.all(needed.map(async (t) => [t, await adapter.readMarket(t)] as const)));
      const skipped: Verified<ChainMarket> = { status: "unavailable", reason: "not requested" };
      const rows = times.map((t, i) => ({ openTimeMs: t, market: markets.get(t) ?? skipped, prediction: preds[i] }));
      if (cancelled) return;
      const map = new Map(rows.map((r) => [r.openTimeMs, r]));
      const firstBad = [pts, ...rows.flatMap((r) => [markets.has(r.openTimeMs) ? r.market : null, r.prediction])].find((r) => r && r.status !== "ok");
      if (firstBad && firstBad.status === "unavailable") {
        setUserState({ key: userKey, data: { status: "unavailable", reason: firstBad.reason, points: pts.status === "ok" ? pts.value : null, rows: map } });
        return;
      }
      setUserState({ key: userKey, data: { status: "ok", points: pts.status === "ok" ? pts.value : null, rows: map } });
    })();
    return () => { cancelled = true; };
  }, [account, adapter, userKey, dayKey]);
  // Data for another account, mode or version is never shown: it is treated as still loading.
  const user: UserData = userState && userState.key === userKey ? userState.data : { status: account ? "loading" : "idle", points: null, rows: new Map() };

  /* ---------- toasts ---------- */
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const act: Ctx["act"] = async (method, openTimeMs, pick) => {
    if (!account) return { error: "Connect a wallet first." };
    const marketId = marketWindowFor(openTimeMs).date;
    try {
      const entry = await tracker.submit({ ...netInfo, wallet: account, method, args: { marketId, pick }, marketOpenTime: openTimeMs });
      return { entry };
    } catch (e) {
      if (e instanceof DuplicateSubmissionError) return { error: "This operation is already being tracked. Wait for it to resolve." };
      return { error: (e as Error).message };
    }
  };

  const value: Ctx = {
    mode, setMode, theme, cycleTheme, md: mdFull, refresh: () => { void load(true); }, wallet, walletApi, wrongNetwork: walletApi.isWrongNetwork() && mode === "live",
    account, adapter, tracker, entries, user, refetchUser, toasts, toast, netInfo, config, act,
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

function safeStorage() {
  try {
    const s = window.localStorage;
    s.getItem("x");
    return s;
  } catch {
    return undefined;
  }
}

