import { CONTRACT_METHODS, type ChainMarket, type ChainPrediction, type ContractAdapter, type Verified } from "./adapter";
import { isOutcome } from "../../domain/outcomes";
import { executionSucceeded, phaseFromStatus } from "../../tx/tracker";
import type { ReceiptView, SubmitContext, TxProvider } from "../../tx/types";
import { ADDRESS_RE, STUDIO_DEFAULTS, type GenLayerConfig } from "../../config";
import { isRateLimitError, RateLimitedError, rpcGate, type RpcGate } from "../../rpc/gate";

/* Minimal structural types so tests can inject a fake SDK client. */
export interface SdkClient {
  chain?: { id?: number; rpcUrls?: { default?: { http?: readonly string[] } } };
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

/** The send was stopped before anything reached the wallet or the network. */
export class PreSendError extends Error {
  constructor(public code: "wrong-wallet-network" | "client-chain-mismatch" | "rpc-mismatch" | "read-write-mismatch" | "provider-unavailable", message: string) {
    super(message);
    this.name = "PreSendError";
  }
}

type Eip1193 = { request(a: { method: string; params?: unknown[] }): Promise<unknown> };
const toNum = (v: unknown): number | null => (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v) ? parseInt(v, 16) : null);

/** Effective runtime check of the real wallet, the real clients and the real RPC. Throws PreSendError on any mismatch. */
export async function verifyStudioNetwork(cfg: GenLayerConfig, reader: SdkClient, writer: SdkClient, provider: unknown): Promise<void> {
  if (cfg.chainId !== STUDIO_DEFAULTS.chainId || cfg.rpcUrl !== STUDIO_DEFAULTS.rpcUrl)
    throw new PreSendError("rpc-mismatch", `The app is configured for chain ${cfg.chainId} at ${cfg.rpcUrl}, not StudioNet (${STUDIO_DEFAULTS.chainId} at ${STUDIO_DEFAULTS.rpcUrl}).`);
  const p = provider as Eip1193 | null;
  if (!p || typeof p.request !== "function") throw new PreSendError("provider-unavailable", "No wallet provider is available.");
  let raw: unknown;
  try {
    raw = await p.request({ method: "eth_chainId" });
  } catch (e) {
    throw new PreSendError("provider-unavailable", `The wallet did not answer eth_chainId (${(e as Error).message}).`);
  }
  const walletChain = toNum(raw);
  if (walletChain !== STUDIO_DEFAULTS.chainId) throw new PreSendError("wrong-wallet-network", `Your wallet is on chain ${raw}, not GenLayer StudioNet (0xf22f / ${STUDIO_DEFAULTS.chainId}). Switch network first.`);
  for (const [name, c] of [["read", reader], ["write", writer]] as const) {
    if (c.chain?.id !== STUDIO_DEFAULTS.chainId) throw new PreSendError("client-chain-mismatch", `The ${name} client uses chain ${String(c.chain?.id)}, not the studionet preset (${STUDIO_DEFAULTS.chainId}).`);
    const http = c.chain?.rpcUrls?.default?.http?.[0];
    if (http !== STUDIO_DEFAULTS.rpcUrl) throw new PreSendError("rpc-mismatch", `The ${name} client uses RPC ${String(http)}, not ${STUDIO_DEFAULTS.rpcUrl}.`);
  }
  if (reader.chain?.id !== writer.chain?.id || reader.chain?.rpcUrls?.default?.http?.[0] !== writer.chain?.rpcUrls?.default?.http?.[0])
    throw new PreSendError("read-write-mismatch", "The read and write clients point to different networks.");
}

export function createGenLayerAdapter(cfg: GenLayerConfig, factory: SdkFactory = sdkFactory(cfg), gate: RpcGate = rpcGate): ContractAdapter {
  const address = cfg.contractAddress as `0x${string}`;
  let reader: Promise<SdkClient> | null = null;
  const client = () => (reader ??= factory.readClient());
  // TTLs: results that can still change are shared for a short time; everything goes through the one gate.
  const call = (fn: string, args: unknown[], key: string, ttl: number) => gate.read(`${cfg.chainId}|${address}|${fn}|${key}`, async () => (await client()).readContract({ address, functionName: fn, args }), { ttl });
  const writers = new Map<string, Promise<SdkClient>>();
  const writerFor = (wallet: string, provider: unknown) => {
    const k = wallet.toLowerCase();
    let w = writers.get(k);
    if (!w) writers.set(k, (w = factory.writeClient(wallet, provider)));
    return w;
  };
  const addr = async (wallet: string) => {
    if (!ADDRESS_RE.test(wallet)) throw new Error("Invalid wallet address");
    return factory.address(wallet);
  };
  const marketRaw = async (t: number): Promise<{ result: ChainMarket["result"]; candidate: ChainMarket["candidate"] } | "invalid"> => {
    const [res, cand] = await Promise.all([call("get_market_result", [t], String(t), 20_000), call("get_market_candidate", [t], String(t), 20_000)]);
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
        const p = parsePrediction(await call("get_prediction", [t, await addr(wallet)], `${wallet.toLowerCase()}|${t}`, 10_000));
        return p === "invalid" ? bad("prediction") : ok(p);
      } catch (e) {
        return unavailable(e);
      }
    },
    async readPoints(wallet) {
      try {
        const v = num(await call("get_user_points", [await addr(wallet)], wallet.toLowerCase(), 10_000));
        return v === null ? bad("points") : ok(v);
      } catch (e) {
        return unavailable(e);
      }
    },
    txProvider(getWalletProvider): TxProvider {
      return {
        async submit(ctx: SubmitContext) {
          if (ctx.contractAddress.toLowerCase() !== address.toLowerCase() || ctx.chainId !== cfg.chainId) throw new Error("Submission context does not match the configured network.");
          const key = `${ctx.wallet.toLowerCase()}|${cfg.chainId}`;
          // One write at a time per account+network. A cool-down after a rate limit is enforced before the wallet is asked to sign.
          return gate.write(key, async () => {
            const provider = getWalletProvider();
            const [r, w] = await Promise.all([client(), writerFor(ctx.wallet, provider)]);
            await verifyStudioNetwork(cfg, r, w, provider);
            const args = ctx.method === CONTRACT_METHODS.submit ? [ctx.marketOpenTime, ctx.args.pick] : [ctx.marketOpenTime];
            const notSent = (e: unknown) => {
              const wait = gate.noteWriteRateLimit(key, e);
              const err = new RateLimitedError("The StudioNet RPC is temporarily limiting requests.", wait, e);
              err.provablyNotSent = true;
              return err;
            };
            if (ctx.method !== CONTRACT_METHODS.resolve && w.simulateWriteContract) {
              try {
                await gate.read(`sim|${key}|${ctx.method}|${ctx.marketOpenTime}|${String(ctx.args.pick)}`, () => w.simulateWriteContract!({ address, functionName: ctx.method, args }));
              } catch (e) {
                if (e instanceof RateLimitedError || isRateLimitError(e)) throw notSent(e); // nothing has reached the wallet yet
                const m = e instanceof Error ? e.message : String(e);
                if (m.includes("[EXPECTED]")) throw new ContractRefusal(m.slice(m.indexOf("[EXPECTED]") + 11, m.indexOf("[EXPECTED]") + 140));
                console.warn("Pre-send simulation was inconclusive; the contract will still validate on-chain:", m); // not a refusal: continue
              }
            }
            let nonce: number | null = null;
            try {
              nonce = toNum(await (provider as Eip1193).request({ method: "eth_getTransactionCount", params: [ctx.wallet, "pending"] }));
            } catch (e) {
              if (isRateLimitError(e)) throw notSent(e);
              console.warn("Could not read the pending nonce before sending:", (e as Error).message);
            }
            ctx.onPrepared?.({ nonce });
            try {
              const hash = await w.writeContract({ address, functionName: ctx.method, args, value: 0n });
              if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("The SDK did not return a transaction hash.");
              gate.noteWriteOk(key);
              gate.invalidate(`${cfg.chainId}|${address}|get_prediction|${ctx.wallet.toLowerCase()}`);
              return { kind: "hash" as const, txHash: hash };
            } catch (e) {
              if ((e as { code?: number })?.code === 4001 || /user rejected|User denied/i.test((e as Error)?.message ?? "")) return { kind: "rejected" as const };
              if (isRateLimitError(e)) {
                // Raised while sending: acceptance is NOT proven. Cool down, never resend automatically.
                throw new RateLimitedError(e instanceof Error ? e.message : String(e), gate.noteWriteRateLimit(key, e), e);
              }
              throw e;
            }
          });
        },
        async reconcile(entry) {
          const provider = getWalletProvider() as Eip1193 | null;
          const w = entry.wallet;
          const nonceOf = async (tag: "latest" | "pending") =>
            toNum(await gate.read(`nonce|${w.toLowerCase()}|${tag}`, () => (provider as Eip1193).request({ method: "eth_getTransactionCount", params: [w, tag] })));
          if (!provider) return { verdict: "unknown" as const, detail: "No wallet provider is available to check the account." };
          const [latest, pending] = [await nonceOf("latest"), await nonceOf("pending")];
          gate.invalidate(`${cfg.chainId}|${address}|get_`);
          const rb = await this.readBack(entry);
          if (rb.ok) return { verdict: "applied" as const, detail: `The contract already shows the intended state (${rb.observed}).` };
          if (latest === null || pending === null) return { verdict: "unknown" as const, detail: "The account nonce could not be read." };
          if (pending > latest) return { verdict: "pending" as const, detail: `The account has a transaction still pending (nonce ${latest} -> ${pending}). Wait for it to settle, then check again.` };
          if (entry.nonceAtSend == null) return { verdict: "unknown" as const, detail: "No nonce was recorded before sending, so the account nonce proves nothing. Check the account in the explorer." };
          if (latest > entry.nonceAtSend) return { verdict: "unknown" as const, detail: `The account nonce moved (${entry.nonceAtSend} -> ${latest}) but the contract does not show this operation. Check the account in the explorer.` };
          return { verdict: "not-found" as const, detail: `The account nonce is unchanged (${latest}), nothing is pending and the contract does not show the operation.` };
        },
        async getReceipt(hash): Promise<ReceiptView> {
          const tx = await gate.read(`tx|${hash}`, async () => (await client()).getTransaction({ hash: hash as `0x${string}` }));
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
            gate.invalidate(`${cfg.chainId}|${address}|get_market`);
            const m = await marketRaw(t);
            if (m === "invalid") throw new Error("Unexpected market response.");
            return { ok: !!(m.result || m.candidate), observed: m.result ? `resolved ${m.result.outcome}` : m.candidate ? `candidate ${m.candidate.outcome}` : "no observation" };
          }
          const p = parsePrediction(await call("get_prediction", [t, await addr(entry.wallet)], `${entry.wallet.toLowerCase()}|${t}`, 0));
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
