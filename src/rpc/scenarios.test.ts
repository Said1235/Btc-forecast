import { describe, it, expect, vi } from "vitest";
import { RpcGate, RateLimitedError, isRateLimitError, retryAfterMs } from "./gate";
import { createGenLayerAdapter, verifyStudioNetwork, type SdkClient, type SdkFactory } from "../data/contract/genlayerAdapter";
import { STUDIO_DEFAULTS } from "../config";
import { TxJournal, MemoryStore } from "../tx/journal";
import { TxTracker, DuplicateSubmissionError } from "../tx/tracker";
import type { SubmitContext } from "../tx/types";

const cfg = STUDIO_DEFAULTS;
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const T = Date.UTC(2026, 10, 18);
const T2 = T + 86_400_000;
const HASH = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const RATE = new Error("An internal error was received. Details: RPC 0xf22f Custom eth_sendRawTransaction: Request is being rate limited. Version: viem@2.57.20");
const CHAIN = { id: 61999, rpcUrls: { default: { http: ["https://studio.genlayer.com/api"] } } };

function env(over: { chain?: unknown; wallet?: Record<string, unknown> } = {}) {
  const clock = { t: 1_000_000 };
  const gate = new RpcGate({ now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, minGapMs: 0, random: () => 0.5 });
  let n = 0, active = 0, maxActive = 0;
  const client = {
    chain: over.chain ?? CHAIN,
    readContract: vi.fn(async (): Promise<unknown> => ({ exists: false })),
    simulateWriteContract: vi.fn(async () => null),
    writeContract: vi.fn(async (): Promise<unknown> => { active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); await Promise.resolve(); active--; return HASH(++n); }),
    getTransaction: vi.fn(async (): Promise<Record<string, unknown>> => ({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN" })),
  };
  const factory: SdkFactory = { readClient: async () => client as unknown as SdkClient, writeClient: vi.fn(async () => client as unknown as SdkClient), address: async (h) => ({ h }) };
  const nonces: Record<string, string> = { latest: "0x5", pending: "0x5" };
  const walletCalls: string[] = [];
  const provider = { request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
    walletCalls.push(method);
    if (over.wallet && method in over.wallet) return over.wallet[method];
    if (method === "eth_chainId") return "0xf22f";
    if (method === "eth_getTransactionCount") return nonces[String(params?.[1])];
    return null;
  }) };
  const adapter = createGenLayerAdapter(cfg, factory, gate);
  const store = new MemoryStore();
  const journal = new TxJournal(store);
  let i = 0;
  const tracker = new TxTracker(journal, adapter.txProvider(() => provider), { sleep: async () => {}, now: () => clock.t, newId: () => `op${++i}`, maxPolls: 4 });
  return { clock, gate, client, factory, provider, nonces, walletCalls, adapter, journal, tracker, store, maxActive: () => maxActive };
}
const ctx = (wallet: string, t = T, method = "submit_prediction", pick: "UP" | "DOWN" = "UP"): SubmitContext => ({
  networkId: "studionet", chainId: 61999, contractAddress: cfg.contractAddress, wallet, method, args: { marketId: new Date(t).toISOString().slice(0, 10), pick: method === "submit_prediction" ? pick : undefined }, marketOpenTime: t,
});

describe("1-3 StudioNet configuration is verified at runtime, not just declared", () => {
  it("1+2 chain id 61999 / 0xf22f, preset rpc: a normal send passes every check", async () => {
    expect(cfg.chainId).toBe(61999);
    expect((61999).toString(16)).toBe("f22f");
    const e = env();
    const r = await e.tracker.submit(ctx(A));
    expect(r.txHash).toBe(HASH(1));
    expect(e.client.writeContract).toHaveBeenCalledTimes(1);
    expect(e.walletCalls).toContain("eth_chainId");
  });
  it("3 a client whose effective RPC is not studio.genlayer.com/api stops the send", async () => {
    const e = env({ chain: { id: 61999, rpcUrls: { default: { http: ["https://studio-dev.genlayer.com/api"] } } } });
    const r = await e.tracker.submit(ctx(A));
    expect(r.state).toBe("rejected");
    expect(r.lastError).toMatch(/not https:\/\/studio\.genlayer\.com\/api/);
    expect(e.client.writeContract).not.toHaveBeenCalled();
  });
  it("3b a client on chain 61997 (studio-dev) stops the send", async () => {
    const e = env({ chain: { id: 61997, rpcUrls: { default: { http: [cfg.rpcUrl] } } } });
    const r = await e.tracker.submit(ctx(A));
    expect(r.lastError).toMatch(/chain 61997/);
    expect(e.client.writeContract).not.toHaveBeenCalled();
  });
  it("read and write clients on different networks are refused", async () => {
    const e = env();
    const other = { chain: { id: 61999, rpcUrls: { default: { http: ["https://other.test"] } } } } as unknown as SdkClient;
    await expect(verifyStudioNetwork(cfg, e.client as unknown as SdkClient, other, e.provider)).rejects.toMatchObject({ name: "PreSendError" });
  });
  it("an env override pointing anywhere else than StudioNet is refused", async () => {
    const e = env();
    await expect(verifyStudioNetwork({ ...cfg, rpcUrl: "https://x.test/api" }, e.client as unknown as SdkClient, e.client as unknown as SdkClient, e.provider)).rejects.toMatchObject({ code: "rpc-mismatch" });
  });
});

describe("4-5 wallet", () => {
  it("4 wallet on another network: nothing is sent, nothing is signed", async () => {
    const e = env({ wallet: { eth_chainId: "0x1" } });
    const r = await e.tracker.submit(ctx(A));
    expect(r.state).toBe("rejected");
    expect(r.lastError).toMatch(/0xf22f/);
    expect(e.client.writeContract).not.toHaveBeenCalled();
  });
  it("5 the wallet rejecting the signature is its own outcome", async () => {
    const e = env();
    e.client.writeContract.mockRejectedValueOnce(Object.assign(new Error("User rejected the request."), { code: 4001 }));
    const r = await e.tracker.submit(ctx(A));
    expect(r.state).toBe("rejected");
    expect(r.lastError).toMatch(/wallet request was rejected/);
    expect(e.client.writeContract).toHaveBeenCalledTimes(1);
  });
});

describe("6 RPC says 'Request is being rate limited'", () => {
  it("is recognised without any HTTP 429", () => {
    expect(isRateLimitError(RATE)).toBe(true);
    expect(isRateLimitError({ cause: { details: "Request is being rate limited" } })).toBe(true);
    expect(isRateLimitError(new Error("insufficient funds"))).toBe(false);
    expect(retryAfterMs({ headers: new Headers({ "retry-after": "7" }) })).toBe(7000);
  });
  it("at send time: ONE attempt, uncertain state, cool-down, no automatic resend, no second prompt", async () => {
    const e = env();
    e.client.writeContract.mockRejectedValue(RATE);
    const r = await e.tracker.submit(ctx(A));
    expect(r.state).toBe("send-rate-limited");
    expect(r.retryAt).toBeGreaterThan(e.clock.t);
    expect(r.lastError).toMatch(/not proven/);
    await expect(e.tracker.submit(ctx(A))).rejects.toBeInstanceOf(DuplicateSubmissionError);
    expect(e.client.writeContract).toHaveBeenCalledTimes(1);
  });
  it("during the pre-send simulation: provably nothing sent and the wallet is never asked", async () => {
    const e = env();
    e.client.simulateWriteContract.mockRejectedValue(RATE);
    const r = await e.tracker.submit(ctx(A));
    expect(r.state).toBe("rate-limited");
    expect(e.client.writeContract).not.toHaveBeenCalled();
    expect(e.walletCalls.filter((m) => m === "eth_sendTransaction")).toHaveLength(0);
    // cool-down is enforced: a new click does not even reach the simulation
    const sims = e.client.simulateWriteContract.mock.calls.length;
    const r2 = await e.tracker.submit(ctx(A));
    expect(r2.state).toBe("rate-limited");
    expect(e.client.simulateWriteContract.mock.calls.length).toBe(sims);
  });
});

describe("7-9 no duplicate writes", () => {
  it("7 rapid presses send exactly once", async () => {
    const e = env();
    const res = await Promise.allSettled(Array.from({ length: 6 }, () => e.tracker.submit(ctx(A))));
    expect(res.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(res.filter((x) => x.status === "rejected" && x.reason instanceof DuplicateSubmissionError)).toHaveLength(5);
    expect(e.client.writeContract).toHaveBeenCalledTimes(1);
  });
  it("8 two operations from one account are serialized, never concurrent", async () => {
    const e = env();
    await Promise.all([e.tracker.submit(ctx(A, T)), e.tracker.submit(ctx(A, T2, "claim_points"))]);
    expect(e.client.writeContract).toHaveBeenCalledTimes(2);
    expect(e.maxActive()).toBe(1);
    const hashes = e.journal.all().map((x) => x.txHash);
    expect(new Set(hashes).size).toBe(2);
  });
  it("9 two accounts are independent: one account's cool-down does not block the other", async () => {
    const e = env();
    e.client.writeContract.mockRejectedValueOnce(RATE);
    const a = await e.tracker.submit(ctx(A));
    expect(a.state).toBe("send-rate-limited");
    const b = await e.tracker.submit(ctx(B));
    expect(b.txHash).toMatch(/^0x/);
    expect(b.wallet).toBe(B);
    expect(e.journal.all().find((x) => x.wallet === A)!.txHash).toBeNull();
  });
});

describe("10-13 tracking by the exact id", () => {
  it("10 timeout after getting an id: tracking pauses, the id is kept, nothing is resent", async () => {
    const e = env();
    e.client.getTransaction.mockRejectedValue(new Error("timeout"));
    const r = await e.tracker.submit(ctx(A));
    expect(r.state).toBe("tracking-unavailable");
    expect(r.txHash).toBe(HASH(1));
    expect(e.client.writeContract).toHaveBeenCalledTimes(1);
  });
  it("11 error before any id: uncertain, blocks resend, never retried automatically", async () => {
    const e = env();
    e.client.writeContract.mockRejectedValueOnce(new Error("socket hang up"));
    const r = await e.tracker.submit(ctx(A));
    expect(r.state).toBe("unknown-reconcile");
    expect(r.txHash).toBeNull();
    await expect(e.tracker.submit(ctx(A))).rejects.toBeInstanceOf(DuplicateSubmissionError);
    expect(e.client.writeContract).toHaveBeenCalledTimes(1);
  });
  it("12 after a reload the exact hash is tracked again, without a new write", async () => {
    const e = env();
    e.client.getTransaction.mockRejectedValue(new Error("timeout"));
    await e.tracker.submit(ctx(A));
    e.client.getTransaction.mockResolvedValue({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN" });
    e.client.readContract.mockResolvedValue({ exists: true, prediction: "UP", submitted_at_ms: 1, processed: false });
    const t2 = new TxTracker(new TxJournal(e.store), e.adapter.txProvider(() => e.provider), { sleep: async () => {}, now: () => e.clock.t });
    await t2.resumeAll();
    expect(t2.journal.all()[0].state).toBe("finalized-ok");
    expect(e.client.getTransaction).toHaveBeenLastCalledWith({ hash: HASH(1) });
    expect(e.client.writeContract).toHaveBeenCalledTimes(1);
  });
  it("13 a real contract execution failure is reported as such, with the reason", async () => {
    const e = env();
    e.client.getTransaction.mockResolvedValue({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_ERROR", result: { error: "[EXPECTED] Market is closed" } });
    const r = await e.tracker.submit(ctx(A));
    expect(r.state).toBe("finalized-error");
    expect(r.lastError).toMatch(/Market is closed/);
  });
});

describe("14 recovery once the RPC answers again", () => {
  const limited = async () => {
    const e = env();
    e.client.writeContract.mockRejectedValueOnce(RATE);
    const r = await e.tracker.submit(ctx(A));
    return { e, r };
  };
  it("the check waits for the cool-down, then proves 'not found' from nonce + contract state, then a new send is allowed", async () => {
    const { e, r } = await limited();
    const early = await e.tracker.reconcile(r.opId);
    expect(early.verdict).toBe("unknown");
    expect(e.walletCalls.filter((m) => m === "eth_getTransactionCount")).toHaveLength(1); // only the pre-send nonce
    e.clock.t = r.retryAt! + 1;
    const out = await e.tracker.reconcile(r.opId);
    expect(out.verdict).toBe("not-found");
    expect(e.journal.getByOp(r.opId)!.state).toBe("rejected");
    const again = await e.tracker.submit(ctx(A));
    expect(again.txHash).toBe(HASH(1));
    expect(e.client.writeContract).toHaveBeenCalledTimes(2);
  });
  it("a pending nonce keeps it uncertain", async () => {
    const { e, r } = await limited();
    e.clock.t = r.retryAt! + 1;
    e.nonces.pending = "0x6";
    expect((await e.tracker.reconcile(r.opId)).verdict).toBe("pending");
    expect(e.journal.getByOp(r.opId)!.state).toBe("send-rate-limited");
  });
  it("a moved nonce without contract evidence keeps it uncertain", async () => {
    const { e, r } = await limited();
    e.clock.t = r.retryAt! + 1;
    e.nonces.latest = "0x6"; e.nonces.pending = "0x6";
    expect((await e.tracker.reconcile(r.opId)).verdict).toBe("unknown");
    expect(e.journal.getByOp(r.opId)!.state).toBe("send-rate-limited");
  });
  it("contract state that already shows the prediction closes it as applied, with no resend", async () => {
    const { e, r } = await limited();
    e.clock.t = r.retryAt! + 1;
    e.client.readContract.mockResolvedValue({ exists: true, prediction: "UP", submitted_at_ms: 1, processed: false });
    expect((await e.tracker.reconcile(r.opId)).verdict).toBe("applied");
    expect(e.client.writeContract).toHaveBeenCalledTimes(1);
  });
  it("another unresolved operation of the account makes the nonce non-attributable", async () => {
    const { e, r } = await limited();
    e.clock.t = r.retryAt! + 1;
    e.client.writeContract.mockRejectedValueOnce(new Error("socket hang up"));
    await e.tracker.submit(ctx(A, T2, "claim_points"));
    expect((await e.tracker.reconcile(r.opId)).verdict).toBe("unknown");
  });
  it("an unreachable wallet RPC during the check leaves it uncertain and delays the next check", async () => {
    const { e, r } = await limited();
    e.clock.t = r.retryAt! + 1;
    e.provider.request.mockRejectedValue(RATE);
    const out = await e.tracker.reconcile(r.opId);
    expect(out.verdict).toBe("unknown");
    expect(e.journal.getByOp(r.opId)!.retryAt).toBeGreaterThan(e.clock.t);
  });
});

describe("read traffic is controlled", () => {
  it("20 simultaneous identical reads become one RPC call; the result is shared", async () => {
    const g = new RpcGate({ minGapMs: 0, sleep: async () => {} });
    const fn = vi.fn(async () => 42);
    const all = await Promise.all(Array.from({ length: 20 }, () => g.read("k", fn, { ttl: 5000 })));
    expect(new Set(all)).toEqual(new Set([42]));
    expect(fn).toHaveBeenCalledTimes(1);
    await g.read("k", fn, { ttl: 5000 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("a limited read backs off with a pause and recovers; retries are bounded", async () => {
    const clock = { t: 0 };
    const g = new RpcGate({ now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, minGapMs: 0, random: () => 0.5 });
    let k = 0;
    const flaky = vi.fn(async () => { if (k++ < 2) throw RATE; return "ok"; });
    expect(await g.read("a", flaky)).toBe("ok");
    expect(flaky).toHaveBeenCalledTimes(3);
    expect(clock.t).toBeGreaterThan(0);
    const dead = vi.fn(async () => { throw RATE; });
    await expect(g.read("b", dead)).rejects.toBeInstanceOf(RateLimitedError);
    expect(dead).toHaveBeenCalledTimes(4); // 1 + 3 retries, never infinite
  });
  it("Retry-After is honoured", async () => {
    const clock = { t: 0 };
    const g = new RpcGate({ now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, minGapMs: 0, random: () => 0 });
    let k = 0;
    await g.read("x", async () => { if (k++ === 0) throw Object.assign(new Error("Request is being rate limited"), { headers: new Headers({ "retry-after": "30" }) }); return 1; });
    expect(clock.t).toBeGreaterThanOrEqual(30_000);
  });
  it("reads are not blocked by an in-flight write", async () => {
    const e = env();
    let release!: () => void;
    e.client.writeContract.mockImplementationOnce(() => new Promise((r) => { release = () => r(HASH(9)); }));
    const sub = e.tracker.submit(ctx(A));
    await new Promise((r) => setTimeout(r, 0));
    expect(await e.adapter.readPoints(A)).toBeDefined();
    release();
    await sub;
  });
});
