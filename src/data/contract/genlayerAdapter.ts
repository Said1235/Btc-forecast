import { CONTRACT_METHODS, type ChainMarket, type ChainPrediction, type ContractAdapter, type Verified } from "./adapter";
import { isOutcome } from "../../domain/outcomes";
import { executionSucceeded, phaseFromStatus } from "../../tx/tracker";
import type { ReceiptView, SubmitContext, TxProvider } from "../../tx/types";
import { ADDRESS_RE, type GenLayerConfig } from "../../config";

/* Minimal structural types so tests can inject a fake SDK client. */
export interface SdkClient {
  readContract(a: { address: `0x${string}`; functionName: string; args?: unknown[] }): Promise<unknown>;
  simulateWriteContract?(a: { address: `0x${string}`; functionName: string; args?: unknown[] }): Promise<unknown>;
  writeContract(a: { address: `0x${string}`; functionName: string; args?: unknown[]; value: bigint }): Promise<unknown>;
  getTransaction(a: { hash: `0x${string}` }): Promise<Record<string, unknown>>;
}
export interface SdkFactory {
  readClient(): Promise<SdkClient>;
  writeClient(wallet: string, provider: unknown): Promise<SdkClient>;
  /** Address calldata value. A plain hex string would be sent as `str`, not `Address`. */
  address(hex: string): Promise<unknown>;
}

export function sdkFactory(cfg: GenLayerConfig): SdkFactory {
  const load = async () => {
    const [core, chains, types] = await Promise.all([import("genlayer-js"), import("genlayer-js/chains"), import("genlayer-js/types")]);
    return { createClient: core.createClient, chain: chains.studionet, CalldataAddress: types.CalldataAddress };
  };
  return {
    async readClient() {
      const s = await load();
      return s.createClient({ chain: s.chain, endpoint: cfg.rpcUrl }) as unknown as SdkClient;
    },
    async writeClient(wallet, provider) {
      const s = await load();
      return s.createClient({ chain: s.chain, endpoint: cfg.rpcUrl, account: wallet as `0x${string}`, provider: provider as never }) as unknown as SdkClient;
    },
    async address(hex) {
      const s = await load();
      const bytes = new Uint8Array(20);
      for (let i = 0; i < 20; i++) bytes[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
      return new s.CalldataAddress(bytes);
    },
  };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Strict parsers: anything that does not match the contract's documented shape becomes `unavailable`. */
export function parseMarketResult(v: unknown): ChainMarket["result"] | "invalid" {
  const r = rec(v);
  if (!r) return "invalid";
  if (r.resolved === false) return null;
  const outcome = r.outcome;
  const open = str(r.open_price), close = str(r.close_price), first = num(r.first_observed_at_ms), at = num(r.resolved_at_ms);
  if (r.resolved !== true || !isOutcome(outcome) || !open || !close || first === null || at === null) return "invalid";
  return { openPrice: open, closePrice: close, outcome, firstObservedAtMs: first, resolvedAtMs: at };
}

export function parseCandidate(v: unknown): ChainMarket["candidate"] | "invalid" {
  const r = rec(v);
  if (!r) return "invalid";
  if (r.exists === false) return null;
  const outcome = r.outcome;
  const open = str(r.open_price), close = str(r.close_price), obs = num(r.observed_at_ms), conf = num(r.confirmable_at_ms);
  if (r.exists !== true || !isOutcome(outcome) || !open || !close || obs === null || conf === null) return "invalid";
  return { openPrice: open, closePrice: close, outcome, observedAtMs: obs, confirmableAtMs: conf };
}

export function parsePrediction(v: unknown): ChainPrediction | null | "invalid" {
  const r = rec(v);
  if (!r) return "invalid";
  if (r.exists === false) return null;
  const pick = r.prediction, at = num(r.submitted_at_ms);
  if (r.exists !== true || !isOutcome(pick) || at === null || typeof r.processed !== "boolean") return "invalid";
  return { pick, submittedAtMs: at, processed: r.processed };
}

const unavailable = (e: unknown): Verified<never> => ({ status: "unavailable", reason: e instanceof Error ? e.message : String(e) });
const bad = (what: string): Verified<never> => ({ status: "unavailable", reason: `Unexpected ${what} response from the contract (schema mismatch).` });
const ok = <T,>(value: T): Verified<T> => ({ status: "ok", value, readAt: Date.now() });

/** Best-effort text of why execution failed, if the SDK exposes it. */
export function failureDetail(tx: Record<string, unknown>): string | null {
  const seen = new Set<unknown>();
  const walk = (o: unknown, depth: number): string | null => {
    if (depth > 6 || !o || typeof o !== "object" || seen.has(o)) return null;
    seen.add(o);
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === "string" && /\[(EXPECTED|EXTERNAL|TRANSIENT)\]/.test(v)) return v.slice(v.indexOf("["), v.indexOf("[") + 160);
      if ((k === "error" || k === "stderr") && typeof v === "string" && v) return v.slice(0, 160);
      const r = walk(v, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return walk(tx, 0);
}

export function createGenLayerAdapter(cfg: GenLayerConfig, factory: SdkFactory = sdkFactory(cfg)): ContractAdapter {
  const address = cfg.contractAddress as `0x${string}`;
  let reader: Promise<SdkClient> | null = null;
  const client = () => (reader ??= factory.readClient());
  const call = async (fn: string, args: unknown[]) => (await client()).readContract({ address, functionName: fn, args });
  const addr = async (wallet: string) => {
    if (!ADDRESS_RE.test(wallet)) throw new Error("Invalid wallet address");
    return factory.address(wallet);
  };
  const marketRaw = async (t: number): Promise<{ result: ChainMarket["result"]; candidate: ChainMarket["candidate"] } | "invalid"> => {
    const [res, cand] = await Promise.all([call("get_market_result", [t]), call("get_market_candidate", [t])]);
    const result = parseMarketResult(res), candidate = parseCandidate(cand);
    return result === "invalid" || candidate === "invalid" ? "invalid" : { result, candidate };
  };

  return {
    mode: "live",
    async readMarket(t) {
      try {
        const m = await marketRaw(t);
        return m === "invalid" ? bad("market") : ok({ openTimeMs: t, ...m });
      } catch (e) {
        return unavailable(e);
      }
    },
    async readPrediction(wallet, t) {
      try {
        const p = parsePrediction(await call("get_prediction", [t, await addr(wallet)]));
        return p === "invalid" ? bad("prediction") : ok(p);
      } catch (e) {
        return unavailable(e);
      }
    },
    async readPoints(wallet) {
      try {
        const v = num(await call("get_user_points", [await addr(wallet)]));
        return v === null ? bad("points") : ok(v);
      } catch (e) {
        return unavailable(e);
      }
    },
    txProvider(getWalletProvider): TxProvider {
      return {
        async submit(ctx: SubmitContext) {
          if (ctx.contractAddress.toLowerCase() !== address.toLowerCase() || ctx.chainId !== cfg.chainId) throw new Error("Submission context does not match the configured network.");
          const w = await factory.writeClient(ctx.wallet, getWalletProvider());
          const args = ctx.method === CONTRACT_METHODS.submit ? [ctx.marketOpenTime, ctx.args.pick] : [ctx.marketOpenTime];
          if (ctx.method !== CONTRACT_METHODS.resolve && w.simulateWriteContract) {
            try {
              await w.simulateWriteContract({ address, functionName: ctx.method, args });
            } catch (e) {
              const m = e instanceof Error ? e.message : String(e);
              if (m.includes("[EXPECTED]")) throw new ContractRefusal(m.slice(m.indexOf("[EXPECTED]") + 11, m.indexOf("[EXPECTED]") + 140));
            }
          }
          try {
            const hash = await w.writeContract({ address, functionName: ctx.method, args, value: 0n });
            if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("The SDK did not return a transaction hash.");
            return { kind: "hash" as const, txHash: hash };
          } catch (e) {
            if ((e as { code?: number })?.code === 4001 || /user rejected|User denied/i.test((e as Error)?.message ?? "")) return { kind: "rejected" as const };
            throw e;
          }
        },
        async getReceipt(hash): Promise<ReceiptView> {
          const tx = await (await client()).getTransaction({ hash: hash as `0x${string}` });
          const status = String(tx.statusName ?? "");
          if (!status) throw new Error("Transaction status unavailable.");
          const phase = phaseFromStatus(status);
          if (phase === "undetermined") return { phase, detail: `The network reported ${status}. The outcome is not settled.` };
          if (phase === "finalized") {
            const name = tx.txExecutionResultName as string | undefined;
            const ok = executionSucceeded(name);
            return { phase, executionOk: ok, executionResult: name ?? "UNKNOWN", detail: ok ? undefined : (failureDetail(tx) ?? undefined) };
          }
          return { phase };
        },
        async readBack(entry) {
          const t = entry.marketOpenTime;
          if (entry.method === CONTRACT_METHODS.resolve) {
            const m = await marketRaw(t);
            if (m === "invalid") throw new Error("Unexpected market response.");
            return { ok: !!(m.result || m.candidate), observed: m.result ? `resolved ${m.result.outcome}` : m.candidate ? `candidate ${m.candidate.outcome}` : "no observation" };
          }
          const p = parsePrediction(await call("get_prediction", [t, await addr(entry.wallet)]));
          if (p === "invalid") throw new Error("Unexpected get_prediction response.");
          if (entry.method === CONTRACT_METHODS.claim) return { ok: !!p?.processed, observed: p ? (p.processed ? "claimed" : "not claimed") : "no prediction" };
          return { ok: !!p && p.pick === entry.args.pick, observed: p?.pick ?? "no prediction" };
        },
      };
    },
  };
}

/** The contract (or its simulation) refused the call with an [EXPECTED] reason. No transaction is sent. */
export class ContractRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractRefusal";
  }
}
