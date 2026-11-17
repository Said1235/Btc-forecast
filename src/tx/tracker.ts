import { TxJournal } from "./journal";
import type { JournalEntry, ReceiptView, SubmitContext, TxProvider, TxState } from "./types";

export class DuplicateSubmissionError extends Error {
  constructor(public existing: JournalEntry) {
    super("An operation for this wallet and market is still unresolved.");
    this.name = "DuplicateSubmissionError";
  }
}

export interface TrackerOptions {
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
  now?: () => number;
  newId?: () => string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let counter = 0;
const defaultId = () => `op-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Maps the SDK's lifecycle names to our phases. Used by the real provider. */
export function phaseFromStatus(status: string): "processing" | "decision" | "finalizing" | "finalized" | "undetermined" {
  switch (status) {
    case "FINALIZED": return "finalized";
    case "READY_TO_FINALIZE": return "finalizing";
    case "ACCEPTED": case "APPEAL_REVEALING": case "APPEAL_COMMITTING": return "decision";
    case "UNDETERMINED": case "CANCELED": case "VALIDATORS_TIMEOUT": case "LEADER_TIMEOUT": return "undetermined";
    default: return "processing"; // UNINITIALIZED, PENDING, PROPOSING, COMMITTING, REVEALING
  }
}

/** genlayer-js 1.1.8 exposes no isSuccessful(); success is read from the execution result. */
export function executionSucceeded(txExecutionResultName: string | undefined): boolean {
  return txExecutionResultName === "FINISHED_WITH_RETURN";
}

export class TxTracker {
  private running = new Set<string>(); // opIds currently polled
  private sleep: (ms: number) => Promise<void>;
  private pollMs: number;
  private maxPolls: number;
  private now: () => number;
  private newId: () => string;
  constructor(public journal: TxJournal, private provider: TxProvider, opts: TrackerOptions = {}) {
    this.sleep = opts.sleep ?? defaultSleep;
    this.pollMs = opts.pollMs ?? 3000;
    this.maxPolls = opts.maxPolls ?? 200;
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? defaultId;
  }

  /** Reload recovery: resume exact hashes, flag hash-less operations as uncertain. */
  resumeAll(): Promise<void[]> {
    const jobs: Promise<void>[] = [];
    for (const e of this.journal.all()) {
      if (e.state === "awaiting-approval" || e.state === "submitting") {
        if (e.txHash) jobs.push(this.track(e.opId));
        else this.journal.setState(e.opId, "unknown-reconcile", { lastError: "The page was reloaded before a transaction hash was received." });
      } else if (e.txHash && ["submitted", "processing", "decision", "finalizing", "tracking-unavailable"].includes(e.state)) {
        jobs.push(this.track(e.opId));
      }
    }
    return Promise.all(jobs);
  }

  async submit(ctx: SubmitContext): Promise<JournalEntry> {
    const existing = this.journal.findUnresolved(ctx.wallet, ctx.args.marketId, ctx.method);
    if (existing) throw new DuplicateSubmissionError(existing);
    const opId = this.newId();
    const t = this.now();
    this.journal.add({
      opId, txHash: null, networkId: ctx.networkId, chainId: ctx.chainId, contractAddress: ctx.contractAddress,
      wallet: ctx.wallet, method: ctx.method, args: { ...ctx.args }, marketOpenTime: ctx.marketOpenTime,
      submittedAt: t, updatedAt: t, state: "awaiting-approval", executionResult: null, lastError: null,
    });
    try {
      const out = await this.provider.submit(ctx);
      if (out.kind === "rejected") {
        this.journal.setState(opId, "rejected", { lastError: "The wallet request was rejected. No transaction was submitted." });
        return this.journal.getByOp(opId)!;
      }
      this.journal.bindHash(opId, out.txHash);
      this.journal.setState(opId, "submitted");
    } catch (e) {
      if ((e as Error).name === "ContractRefusal") {
        this.journal.setState(opId, "rejected", { lastError: `The contract refused this call before it was sent: ${(e as Error).message}. No transaction was submitted.` });
        return this.journal.getByOp(opId)!;
      }
      this.journal.setState(opId, "unknown-reconcile", {
        lastError: `Submission ended without a transaction hash (${(e as Error).message}). Check before submitting again.`,
      });
      return this.journal.getByOp(opId)!;
    }
    await this.track(opId);
    return this.journal.getByOp(opId)!;
  }

  /** Track strictly by the entry's own hash. Safe to call again to resume. */
  async track(opId: string): Promise<void> {
    const entry0 = this.journal.getByOp(opId);
    if (!entry0 || !entry0.txHash || this.running.has(opId)) return;
    this.running.add(opId);
    const hash = entry0.txHash;
    try {
      for (let i = 0; i < this.maxPolls; i++) {
        let view: ReceiptView;
        try {
          view = await this.provider.getReceipt(hash);
        } catch (e) {
          this.journal.setState(opId, "tracking-unavailable", { lastError: `Tracking paused: ${(e as Error).message}. The transaction was submitted; you can resume checking it.` });
          return;
        }
        if (view.phase === "undetermined") {
          this.journal.setState(opId, "undetermined", { lastError: view.detail });
          return;
        }
        if (view.phase === "finalized") {
          if (!view.executionOk) {
            this.journal.setState(opId, "finalized-error", { executionResult: view.executionResult, lastError: "The network finalized the transaction, but contract execution did not complete successfully." + (view.detail ? ` Contract said: ${view.detail}` : "") });
            return;
          }
          await this.verifyReadBack(opId, view.executionResult);
          return;
        }
        this.journal.setState(opId, view.phase satisfies TxState);
        await this.sleep(this.pollMs);
      }
      this.journal.setState(opId, "tracking-unavailable", { lastError: "Finalization is taking longer than expected. The transaction is still tracked by its hash." });
    } finally {
      this.running.delete(opId);
    }
  }

  private async verifyReadBack(opId: string, executionResult: string) {
    const e = this.journal.getByOp(opId)!;
    try {
      const r = await this.provider.readBack(e); // original wallet, exact market, own method
      if (r.ok) this.journal.setState(opId, "finalized-ok", { executionResult, lastError: null });
      else this.journal.setState(opId, "readback-mismatch", { executionResult, lastError: `Contract read-back returned ${r.observed} but ${e.args.pick ?? e.method} was submitted.` });
    } catch (err) {
      this.journal.setState(opId, "tracking-unavailable", { executionResult, lastError: `Finalized, but the read-back failed: ${(err as Error).message}` });
    }
  }
}
