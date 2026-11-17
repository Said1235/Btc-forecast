import { describe, it, expect, vi } from "vitest";
import { RpcGate } from "../../rpc/gate";
import { createGenLayerAdapter, parseCandidate, parseMarketResult, parsePrediction, failureDetail, type SdkClient, type SdkFactory } from "./genlayerAdapter";
import { readConfig, STUDIO_DEFAULTS, addChainParams } from "../../config";
import { TxJournal, MemoryStore } from "../../tx/journal";
import { TxTracker } from "../../tx/tracker";
import type { JournalEntry, SubmitContext } from "../../tx/types";

const cfg = STUDIO_DEFAULTS;
const W = "0x1111111111111111111111111111111111111111";
const T = Date.UTC(2026, 10, 18);
const HASH = "0x" + "ab".repeat(32);

function fake(over: Partial<SdkClient> = {}) {
  const client = {
    readContract: vi.fn(async () => ({})),
    simulateWriteContract: vi.fn(async () => null),
    writeContract: vi.fn(async () => HASH),
    getTransaction: vi.fn(async () => ({ statusName: "PENDING" })),
    chain: { id: 61999, rpcUrls: { default: { http: ["https://studio.genlayer.com/api"] } } },
    ...over,
  } as unknown as SdkClient & { readContract: ReturnType<typeof vi.fn>; simulateWriteContract: ReturnType<typeof vi.fn>; writeContract: ReturnType<typeof vi.fn>; getTransaction: ReturnType<typeof vi.fn> };
  const addr = vi.fn(async (h: string) => ({ __address: h }));
  const writeClient = vi.fn(async () => client);
  const factory: SdkFactory = { readClient: async () => client, writeClient, address: addr };
  return { client, factory, addr, writeClient };
}
export const mkGate = () => new RpcGate({ minGapMs: 0, sleep: async () => {}, random: () => 0.5 });
const walletProv = (over: Record<string, unknown> = {}) => ({ request: vi.fn(async ({ method }: { method: string }) => (method in over ? over[method] : method === "eth_chainId" ? "0xf22f" : method === "eth_getTransactionCount" ? "0x5" : null)) });
const ctx = (method: string, pick?: "UP"): SubmitContext => ({ networkId: "studionet", chainId: 61999, contractAddress: cfg.contractAddress, wallet: W, method, args: { marketId: "2026-11-18", pick }, marketOpenTime: T });

describe("configuration", () => {
  it("defaults to the StudioNet deployment supplied by the owner", () => {
    expect(readConfig({})).toMatchObject({ network: "studionet", chainId: 61999, rpcUrl: "https://studio.genlayer.com/api", contractAddress: "0x8AB7b7FB6771cb91d65623964df704c075e7e2b7" });
  });
  it("accepts overrides and rejects malformed values", () => {
    expect(readConfig({ VITE_GENLAYER_RPC_URL: "https://x.test/api" }).rpcUrl).toBe("https://x.test/api");
    expect(() => readConfig({ VITE_CONTRACT_ADDRESS: "0x123" })).toThrow(/Invalid contract address/);
    expect(() => readConfig({ VITE_GENLAYER_CHAIN_ID: "abc" })).toThrow(/Invalid chain id/);
  });
  it("builds wallet_addEthereumChain params for chain 61999 (0xf22f)", () => {
    expect(addChainParams(cfg)).toMatchObject({ chainId: "0xf22f", rpcUrls: ["https://studio.genlayer.com/api"], nativeCurrency: { symbol: "GEN" } });
  });
});

describe("response parsers (shapes taken from the contract views)", () => {
  it("get_prediction", () => {
    expect(parsePrediction({ exists: false })).toBeNull();
    expect(parsePrediction({ exists: true, prediction: "UP", submitted_at_ms: 5, processed: false })).toEqual({ pick: "UP", submittedAtMs: 5, processed: false });
    expect(parsePrediction({ exists: true, prediction: "SIDEWAYS", submitted_at_ms: 5, processed: false })).toBe("invalid");
    expect(parsePrediction("nope")).toBe("invalid");
  });
  it("get_market_result and get_market_candidate", () => {
    expect(parseMarketResult({ resolved: false })).toBeNull();
    expect(parseMarketResult({ resolved: true, open_price: "1.5", close_price: "2", outcome: "UP", first_observed_at_ms: 1, resolved_at_ms: 2 })).toMatchObject({ outcome: "UP", openPrice: "1.5" });
    expect(parseMarketResult({ resolved: true, outcome: "UP" })).toBe("invalid");
    expect(parseCandidate({ exists: false })).toBeNull();
    expect(parseCandidate({ exists: true, open_price: "1", close_price: "1", outcome: "FLAT", observed_at_ms: 10, confirmable_at_ms: 310 })).toMatchObject({ outcome: "FLAT", confirmableAtMs: 310 });
  });
  it("accepts numeric strings for large integers (SDK json-safe output)", () => {
    expect(parsePrediction({ exists: true, prediction: "DOWN", submitted_at_ms: "1789000000000", processed: true })?.valueOf()).toMatchObject({ submittedAtMs: 1789000000000 });
  });
});

describe("reads", () => {
  it("calls the real view names with integer ms and an Address calldata value", async () => {
    const f = fake();
    f.client.readContract.mockImplementation(async (a: { functionName: string }) => (a.functionName === "get_prediction" ? { exists: true, prediction: "UP", submitted_at_ms: 9, processed: false } : 7));
    const ad = createGenLayerAdapter(cfg, f.factory, mkGate());
    const p = await ad.readPrediction(W, T);
    expect(p).toMatchObject({ status: "ok", value: { pick: "UP" } });
    expect(f.client.readContract).toHaveBeenCalledWith({ address: cfg.contractAddress, functionName: "get_prediction", args: [T, { __address: W }] });
    expect(await ad.readPoints(W)).toMatchObject({ status: "ok", value: 7 });
    expect(f.client.readContract).toHaveBeenLastCalledWith({ address: cfg.contractAddress, functionName: "get_user_points", args: [{ __address: W }] });
  });
  it("reads both market views", async () => {
    const f = fake();
    f.client.readContract.mockImplementation(async (a: { functionName: string }) => (a.functionName === "get_market_result" ? { resolved: false } : { exists: false }));
    const m = await createGenLayerAdapter(cfg, f.factory, mkGate()).readMarket(T);
    expect(m).toMatchObject({ status: "ok", value: { openTimeMs: T, result: null, candidate: null } });
    expect((f.client.readContract.mock.calls as [{ functionName: string }][]).map((c) => c[0].functionName).sort()).toEqual(["get_market_candidate", "get_market_result"]);
  });
  it("reports RPC failures and schema mismatches instead of inventing data", async () => {
    const f = fake({ readContract: vi.fn(async () => { throw new Error("RPC down"); }) });
    expect(await createGenLayerAdapter(cfg, f.factory, mkGate()).readPoints(W)).toEqual({ status: "unavailable", reason: "RPC down" });
    const g = fake({ readContract: vi.fn(async () => ({ weird: true })) });
    const r = await createGenLayerAdapter(cfg, g.factory, mkGate()).readPrediction(W, T);
    expect(r).toMatchObject({ status: "unavailable" });
    expect((r as { reason: string }).reason).toMatch(/schema mismatch/);
  });
  it("refuses a malformed wallet address before any call", async () => {
    const f = fake();
    expect(await createGenLayerAdapter(cfg, f.factory, mkGate()).readPoints("0xabc")).toMatchObject({ status: "unavailable" });
    expect(f.client.readContract).not.toHaveBeenCalled();
  });
});

describe("writes", () => {
  it("sends the exact arguments for each method with value 0", async () => {
    const f = fake();
    const tp = createGenLayerAdapter(cfg, f.factory, mkGate()).txProvider(() => walletProv());
    expect(await tp.submit(ctx("submit_prediction", "UP"))).toEqual({ kind: "hash", txHash: HASH });
    expect(f.writeClient).toHaveBeenCalledWith(W, expect.objectContaining({ request: expect.any(Function) }));
    expect(f.client.writeContract).toHaveBeenLastCalledWith({ address: cfg.contractAddress, functionName: "submit_prediction", args: [T, "UP"], value: 0n });
    await tp.submit(ctx("claim_points"));
    expect(f.client.writeContract).toHaveBeenLastCalledWith({ address: cfg.contractAddress, functionName: "claim_points", args: [T], value: 0n });
    await tp.submit(ctx("resolve_market"));
    expect(f.client.writeContract).toHaveBeenLastCalledWith({ address: cfg.contractAddress, functionName: "resolve_market", args: [T], value: 0n });
    expect(f.client.simulateWriteContract).toHaveBeenCalledTimes(2); // not for resolve_market (non-deterministic web fetch)
  });
  it("stops before the wallet when the contract refuses, and the tracker records nothing as sent", async () => {
    const f = fake({ simulateWriteContract: vi.fn(async () => { throw new Error("[EXPECTED] market locked"); }) });
    const j = new TxJournal(new MemoryStore());
    const tr = new TxTracker(j, createGenLayerAdapter(cfg, f.factory, mkGate()).txProvider(() => walletProv()), { sleep: async () => {} });
    const e = await tr.submit(ctx("submit_prediction", "UP"));
    expect(e.state).toBe("rejected");
    expect(e.lastError).toMatch(/market locked/);
    expect(e.lastError).toMatch(/No transaction was submitted/);
    expect(f.client.writeContract).not.toHaveBeenCalled();
  });
  it("continues when the simulation fails for an unknown reason", async () => {
    const f = fake({ simulateWriteContract: vi.fn(async () => { throw new Error("gen_call unsupported"); }) });
    expect(await createGenLayerAdapter(cfg, f.factory, mkGate()).txProvider(() => walletProv()).submit(ctx("claim_points"))).toMatchObject({ kind: "hash" });
  });
  it("maps wallet rejection and refuses a result that is not a hash", async () => {
    const rej = fake({ writeContract: vi.fn(async () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); }) });
    expect(await createGenLayerAdapter(cfg, rej.factory, mkGate()).txProvider(() => walletProv()).submit(ctx("claim_points"))).toEqual({ kind: "rejected" });
    const nohash = fake({ writeContract: vi.fn(async () => undefined) });
    await expect(createGenLayerAdapter(cfg, nohash.factory, mkGate()).txProvider(() => walletProv()).submit(ctx("claim_points"))).rejects.toThrow(/did not return a transaction hash/);
  });
  it("refuses a context for another contract or chain", async () => {
    const f = fake();
    const tp = createGenLayerAdapter(cfg, f.factory, mkGate()).txProvider(() => walletProv());
    await expect(tp.submit({ ...ctx("claim_points"), contractAddress: "0x" + "22".repeat(20) })).rejects.toThrow(/does not match/);
    await expect(tp.submit({ ...ctx("claim_points"), chainId: 1 })).rejects.toThrow(/does not match/);
    expect(f.client.writeContract).not.toHaveBeenCalled();
  });
});

describe("receipts and read-back", () => {
  const tpFor = (tx: Record<string, unknown>) => createGenLayerAdapter(cfg, fake({ getTransaction: vi.fn(async () => tx) }).factory, mkGate()).txProvider(() => walletProv());
  it("maps SDK statuses", async () => {
    expect(await tpFor({ statusName: "PENDING" }).getReceipt(HASH)).toEqual({ phase: "processing" });
    expect(await tpFor({ statusName: "ACCEPTED" }).getReceipt(HASH)).toEqual({ phase: "decision" });
    expect(await tpFor({ statusName: "READY_TO_FINALIZE" }).getReceipt(HASH)).toEqual({ phase: "finalizing" });
    expect(await tpFor({ statusName: "UNDETERMINED" }).getReceipt(HASH)).toMatchObject({ phase: "undetermined" });
    await expect(tpFor({}).getReceipt(HASH)).rejects.toThrow(/status unavailable/);
  });
  it("FINALIZED alone is not success: the execution result decides", async () => {
    expect(await tpFor({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN" }).getReceipt(HASH)).toMatchObject({ phase: "finalized", executionOk: true });
    const bad = await tpFor({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_ERROR", nested: { error: "[EXPECTED] market locked" } }).getReceipt(HASH);
    expect(bad).toMatchObject({ phase: "finalized", executionOk: false, detail: "[EXPECTED] market locked" });
    expect(await tpFor({ statusName: "FINALIZED" }).getReceipt(HASH)).toMatchObject({ executionOk: false });
  });
  it("extracts failure text only when present", () => {
    expect(failureDetail({ a: { b: "[EXTERNAL] http status" } })).toBe("[EXTERNAL] http status");
    expect(failureDetail({ a: 1 })).toBeNull();
  });
  it("read-back verifies each method with the ORIGINAL wallet", async () => {
    const f = fake();
    f.client.readContract.mockImplementation(async (a: { functionName: string }) => {
      if (a.functionName === "get_prediction") return { exists: true, prediction: "UP", submitted_at_ms: 1, processed: true };
      if (a.functionName === "get_market_result") return { resolved: false };
      return { exists: true, open_price: "1", close_price: "2", outcome: "UP", observed_at_ms: 1, confirmable_at_ms: 2 };
    });
    const tp = createGenLayerAdapter(cfg, f.factory, mkGate()).txProvider(() => walletProv());
    const entry = (method: string, pick?: "UP" | "DOWN"): JournalEntry => ({ opId: "o", txHash: HASH, networkId: "studionet", chainId: 61999, contractAddress: cfg.contractAddress, wallet: W, method, args: { marketId: "2026-11-18", pick }, marketOpenTime: T, submittedAt: 0, updatedAt: 0, state: "finalizing", executionResult: null, lastError: null });
    expect(await tp.readBack(entry("submit_prediction", "UP"))).toEqual({ ok: true, observed: "UP" });
    expect(await tp.readBack(entry("submit_prediction", "DOWN"))).toEqual({ ok: false, observed: "UP" });
    expect(await tp.readBack(entry("claim_points"))).toEqual({ ok: true, observed: "claimed" });
    expect(await tp.readBack(entry("resolve_market"))).toMatchObject({ ok: true, observed: "candidate UP" });
    expect(f.addr).toHaveBeenCalledWith(W);
  });
});
