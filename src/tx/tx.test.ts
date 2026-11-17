import { describe, it, expect } from "vitest";
import { TxJournal, MemoryStore } from "./journal";
import { TxTracker, DuplicateSubmissionError, phaseFromStatus, executionSucceeded } from "./tracker";
import type { ReceiptView, SubmitContext, TxProvider } from "./types";
import type { Outcome } from "../domain/candle";

type Script = ReceiptView | Error | (() => ReceiptView | Promise<ReceiptView>);

/** Deterministic mock: each submit returns the next hash; each hash has its own receipt script. */
class MockProvider implements TxProvider {
  hashes: string[] = [];
  scripts = new Map<string, Script[]>();
  submitted: SubmitContext[] = [];
  onChain = new Map<string, Outcome>(); // `${wallet}|${market}` -> pick
  nextRejects = false;
  nextThrows = false;
  gate: Promise<void> | null = null;
  private n = 0;
  async submit(ctx: SubmitContext) {
    this.submitted.push(ctx);
    if (this.gate) await this.gate;
    if (this.nextRejects) { this.nextRejects = false; return { kind: "rejected" as const }; }
    if (this.nextThrows) { this.nextThrows = false; throw new Error("provider crashed"); }
    const h = this.hashes[this.n++] ?? `0xH${this.n}`;
    return { kind: "hash" as const, txHash: h };
  }
  async getReceipt(hash: string): Promise<ReceiptView> {
    const q = this.scripts.get(hash);
    const step = q && q.length > 1 ? q.shift()! : q?.[0];
    if (!step) throw new Error("no script");
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step() : step;
  }
  reconcileResult: { verdict: import("./types").Verdict; detail: string } = { verdict: "unknown", detail: "no evidence" };
  async reconcile() {
    return this.reconcileResult;
  }
  async readBack(entry: import("./types").JournalEntry) {
    const got = this.onChain.get(`${entry.wallet}|${entry.args.marketId}`) ?? null;
    return { ok: got === entry.args.pick, observed: got ?? "no prediction" };
  }
}
const ok: ReceiptView = { phase: "finalized", executionOk: true, executionResult: "FINISHED_WITH_RETURN" };
const bad: ReceiptView = { phase: "finalized", executionOk: false, executionResult: "FINISHED_WITH_ERROR" };
const ctx = (wallet: string, marketId: string, pick: Outcome): SubmitContext => ({
  networkId: "test-net", chainId: 1, contractAddress: "0xC0", wallet, method: "test_method", args: { marketId, pick }, marketOpenTime: Date.parse(marketId),
});
function setup(p = new MockProvider(), store = new MemoryStore()) {
  const journal = new TxJournal(store);
  let i = 0;
  const tracker = new TxTracker(journal, p, { sleep: async () => {}, newId: () => `op${++i}`, maxPolls: 5 });
  return { p, journal, tracker, store };
}

describe("transaction journal regression scenarios", () => {
  it("1. two near-simultaneous submissions from the same wallet: second is blocked, first keeps its own hash", async () => {
    const { p, tracker, journal } = setup();
    p.hashes = ["0xA"]; p.scripts.set("0xA", [ok]); p.onChain.set("0xW|2026-11-16", "UP");
    let release!: () => void;
    p.gate = new Promise<void>((r) => (release = r));
    const first = tracker.submit(ctx("0xW", "2026-11-16", "UP"));
    await expect(tracker.submit(ctx("0xW", "2026-11-16", "DOWN"))).rejects.toBeInstanceOf(DuplicateSubmissionError);
    release();
    const done = await first;
    expect(p.submitted).toHaveLength(1);
    expect(done.txHash).toBe("0xA");
    expect(journal.all()).toHaveLength(1);
  });

  it("2. different markets are tracked independently", async () => {
    const { p, tracker } = setup();
    p.hashes = ["0xA", "0xB"];
    p.scripts.set("0xA", [ok]); p.scripts.set("0xB", [ok]);
    p.onChain.set("0xW|2026-11-16", "UP"); p.onChain.set("0xW|2026-11-17", "DOWN");
    const [a, b] = await Promise.all([tracker.submit(ctx("0xW", "2026-11-16", "UP")), tracker.submit(ctx("0xW", "2026-11-17", "DOWN"))]);
    expect([a.state, b.state]).toEqual(["finalized-ok", "finalized-ok"]);
    expect(a.args.marketId).toBe("2026-11-16");
    expect(b.args.marketId).toBe("2026-11-17");
    expect(a.txHash).not.toBe(b.txHash);
  });

  it("3. receipts arriving in an unexpected order never cross-associate", async () => {
    const { p, tracker, journal } = setup();
    p.hashes = ["0xA", "0xB"];
    let resolveA!: () => void;
    p.scripts.set("0xA", [() => new Promise<ReceiptView>((r) => (resolveA = () => r(ok)))]);
    p.scripts.set("0xB", [ok]);
    p.onChain.set("0xW|2026-11-16", "UP"); p.onChain.set("0xW|2026-11-17", "FLAT");
    const a = tracker.submit(ctx("0xW", "2026-11-16", "UP"));
    await Promise.resolve();
    const b = await tracker.submit(ctx("0xW", "2026-11-17", "FLAT")); // B finishes first
    expect(journal.getByHash("0xB")!.state).toBe("finalized-ok");
    expect(journal.getByHash("0xA")!.state).not.toBe("finalized-ok");
    resolveA();
    const aDone = await a;
    expect(aDone.txHash).toBe("0xA");
    expect(aDone.args).toEqual({ marketId: "2026-11-16", pick: "UP" });
    expect(b.args.pick).toBe("FLAT");
  });

  it("4. a reload while pending resumes the exact hash; a hash-less operation becomes unknown, not a failure", async () => {
    const { p, tracker, store } = setup();
    p.hashes = ["0xA"];
    p.scripts.set("0xA", [{ phase: "processing" }, { phase: "processing" }, ok]);
    p.onChain.set("0xW|2026-11-16", "UP");
    // Simulate a crash mid-flight: persist a submitted entry and a hash-less one, then "reload".
    tracker.journal.add({ opId: "pre1", txHash: "0xA", networkId: "test-net", chainId: 1, contractAddress: "0xC0", wallet: "0xW", method: "test_method", args: { marketId: "2026-11-16", pick: "UP" }, marketOpenTime: 0, submittedAt: 1, updatedAt: 1, state: "processing", executionResult: null, lastError: null });
    tracker.journal.add({ opId: "pre2", txHash: null, networkId: "test-net", chainId: 1, contractAddress: "0xC0", wallet: "0xW", method: "test_method", args: { marketId: "2026-11-18", pick: "DOWN" }, marketOpenTime: 0, submittedAt: 1, updatedAt: 1, state: "awaiting-approval", executionResult: null, lastError: null });
    const reloaded = new TxJournal(store);
    const t2 = new TxTracker(reloaded, p, { sleep: async () => {}, maxPolls: 5 });
    await t2.resumeAll();
    expect(reloaded.getByOp("pre1")!.state).toBe("finalized-ok");
    expect(reloaded.getByOp("pre2")!.state).toBe("unknown-reconcile");
    expect(reloaded.getByOp("pre2")!.txHash).toBeNull();
  });

  it("5. tracking timeout after a hash keeps the operation and can resume the same hash", async () => {
    const { p, tracker, journal } = setup();
    p.hashes = ["0xA"];
    p.scripts.set("0xA", [new Error("RPC timeout")]);
    p.onChain.set("0xW|2026-11-16", "UP");
    const e = await tracker.submit(ctx("0xW", "2026-11-16", "UP"));
    expect(e.state).toBe("tracking-unavailable");
    expect(e.txHash).toBe("0xA");
    expect(e.lastError).toMatch(/submitted/);
    expect(p.submitted).toHaveLength(1);
    p.scripts.set("0xA", [ok]);
    await tracker.track(e.opId);
    expect(journal.getByHash("0xA")!.state).toBe("finalized-ok");
    expect(p.submitted).toHaveLength(1); // never blindly resubmitted
  });

  it("6. an account change while pending keeps the ORIGINAL wallet and read-back target", async () => {
    const { p, tracker, journal } = setup();
    p.hashes = ["0xA"];
    p.scripts.set("0xA", [ok]);
    p.onChain.set("0xOLD|2026-11-16", "UP");
    p.onChain.set("0xNEW|2026-11-16", "DOWN"); // a different account's record for the same market
    const e = await tracker.submit(ctx("0xOLD", "2026-11-16", "UP"));
    expect(e.wallet).toBe("0xOLD");
    expect(e.state).toBe("finalized-ok");
    expect(journal.forWallet("0xNEW")).toHaveLength(0);
    expect(journal.forWallet("0xOLD")).toHaveLength(1);
  });

  it("7. one succeeds while another fails", async () => {
    const { p, tracker } = setup();
    p.hashes = ["0xA", "0xB"];
    p.scripts.set("0xA", [ok]); p.scripts.set("0xB", [bad]);
    p.onChain.set("0xW|2026-11-16", "UP");
    const [a, b] = await Promise.all([tracker.submit(ctx("0xW", "2026-11-16", "UP")), tracker.submit(ctx("0xW", "2026-11-17", "DOWN"))]);
    expect(a.state).toBe("finalized-ok");
    expect(b.state).toBe("finalized-error");
    expect(b.lastError).toMatch(/did not complete successfully/);
  });

  it("8. two transactions finalize close together without mixing results", async () => {
    const { p, tracker, journal } = setup();
    p.hashes = ["0xA", "0xB"];
    p.scripts.set("0xA", [{ phase: "decision" }, ok]); p.scripts.set("0xB", [{ phase: "decision" }, ok]);
    p.onChain.set("0xW|2026-11-16", "UP"); p.onChain.set("0xW|2026-11-17", "DOWN");
    await Promise.all([tracker.submit(ctx("0xW", "2026-11-16", "UP")), tracker.submit(ctx("0xW", "2026-11-17", "DOWN"))]);
    expect(journal.getByHash("0xA")!.args.pick).toBe("UP");
    expect(journal.getByHash("0xB")!.args.pick).toBe("DOWN");
    expect(journal.all().every((e) => e.state === "finalized-ok")).toBe(true);
  });

  it("9. a retry while the original is unresolved is blocked, including after a tracking failure", async () => {
    const { p, tracker } = setup();
    p.hashes = ["0xA"];
    p.scripts.set("0xA", [new Error("down")]);
    await tracker.submit(ctx("0xW", "2026-11-16", "UP"));
    await expect(tracker.submit(ctx("0xW", "2026-11-16", "UP"))).rejects.toBeInstanceOf(DuplicateSubmissionError);
    expect(p.submitted).toHaveLength(1);
  });

  it("10. a read-back that does not match is flagged, not shown as success", async () => {
    const { p, tracker } = setup();
    p.hashes = ["0xA"]; p.scripts.set("0xA", [ok]);
    p.onChain.set("0xW|2026-11-16", "DOWN");
    const e = await tracker.submit(ctx("0xW", "2026-11-16", "UP"));
    expect(e.state).toBe("readback-mismatch");
    expect(e.lastError).toMatch(/read-back returned DOWN but UP was submitted/);
  });
});

describe("submission edge cases", () => {
  it("wallet rejection records a rejected entry with no hash and allows another try", async () => {
    const { p, tracker } = setup();
    p.nextRejects = true;
    const e = await tracker.submit(ctx("0xW", "2026-11-16", "UP"));
    expect(e.state).toBe("rejected");
    expect(e.txHash).toBeNull();
    expect(e.lastError).toMatch(/No transaction was submitted/);
    p.hashes = ["0xA"]; p.scripts.set("0xA", [ok]); p.onChain.set("0xW|2026-11-16", "UP");
    expect((await tracker.submit(ctx("0xW", "2026-11-16", "UP"))).state).toBe("finalized-ok");
  });
  it("an error after approval without a hash is uncertain and blocks resubmission", async () => {
    const { p, tracker } = setup();
    p.nextThrows = true;
    const e = await tracker.submit(ctx("0xW", "2026-11-16", "UP"));
    expect(e.state).toBe("unknown-reconcile");
    await expect(tracker.submit(ctx("0xW", "2026-11-16", "UP"))).rejects.toBeInstanceOf(DuplicateSubmissionError);
  });
  it("undetermined outcomes are terminal and explained", async () => {
    const { p, tracker } = setup();
    p.hashes = ["0xA"]; p.scripts.set("0xA", [{ phase: "undetermined", detail: "Validators could not agree." }]);
    expect((await tracker.submit(ctx("0xW", "2026-11-16", "UP"))).state).toBe("undetermined");
  });
  it("journal persists by hash and survives a reload", async () => {
    const { p, tracker, store } = setup();
    p.hashes = ["0xA"]; p.scripts.set("0xA", [ok]); p.onChain.set("0xW|2026-11-16", "UP");
    await tracker.submit(ctx("0xW", "2026-11-16", "UP"));
    const again = new TxJournal(store);
    expect(again.getByHash("0xA")).toMatchObject({ wallet: "0xW", method: "test_method", contractAddress: "0xC0", chainId: 1, networkId: "test-net" });
  });
  it("maps SDK statuses and checks execution result, not ACCEPTED/FINALIZED alone", () => {
    expect(phaseFromStatus("PENDING")).toBe("processing");
    expect(phaseFromStatus("ACCEPTED")).toBe("decision");
    expect(phaseFromStatus("READY_TO_FINALIZE")).toBe("finalizing");
    expect(phaseFromStatus("FINALIZED")).toBe("finalized");
    expect(phaseFromStatus("UNDETERMINED")).toBe("undetermined");
    expect(executionSucceeded("FINISHED_WITH_RETURN")).toBe(true);
    expect(executionSucceeded("FINISHED_WITH_ERROR")).toBe(false);
    expect(executionSucceeded(undefined)).toBe(false);
  });
});
