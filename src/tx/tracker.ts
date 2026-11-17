import { TxJournal } from "./journal";
import { isRateLimitError, RateLimitedError } from "../rpc/gate";
import { UNRESOLVED, type JournalEntry, type ReceiptView, type SubmitContext, type TxProvider, type TxState, type Verdict } from "./types";

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
    this.pollMs = opts.pollMs ?? 5000;
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
      const out = await this.provider.submit({ ...ctx, onPrepared: ({ nonce }) => this.journal.patchByOp(opId, { nonceAtSend: nonce }) });
      if (out.kind === "rejected") {
        this.journal.setState(opId, "rejected", { lastError: "The wallet request was rejected. No transaction was submitted." });
        return this.journal.getByOp(opId)!;
      }
      this.journal.bindHash(opId, out.txHash);
      this.journal.setState(opId, "submitted");
    } catch (e) {
      const err = e as Error & { provablyNotSent?: boolean };
      if (err.name === "ContractRefusal") {
        this.journal.setState(opId, "rejected", { lastError: `The contract refused this call before it was sent: ${err.message}. No transaction was submitted.` });
        return this.journal.getByOp(opId)!;
      }
      if (err.name === "PreSendError") {
        this.journal.setState(opId, "rejected", { lastError: `Nothing was sent: ${err.message}` });
        return this.journal.getByOp(opId)!;
      }
      if (err instanceof RateLimitedError || isRateLimitError(err)) {
        const wait = err instanceof RateLimitedError ? err.retryAfterMs : 15_000;
        const retryAt = this.now() + wait;
        const secs = Math.ceil(wait / 1000);
        if (err.provablyNotSent) {
          this.journal.setState(opId, "rate-limited", { retryAt, lastError: `The StudioNet RPC is temporarily limiting requests. Nothing was sent and your wallet was not asked to sign. Try again in about ${secs}s.` });
        } else {
          this.journal.setState(opId, "send-rate-limited", { retryAt, lastError: `The StudioNet RPC limited the send (${err.message}). It is not proven that nothing was accepted, so nothing is resent automatically. Run the check in about ${secs}s.` });
        }
        return this.journal.getByOp(opId)!;
      }
      this.journal.setState(opId, "unknown-reconcile", {
        lastError: `Submission ended without a transaction hash (${err.message}). Check before submitting again.`,
      });
      return this.journal.getByOp(opId)!;
    }
    await this.track(opId);
    return this.journal.getByOp(opId)!;
  }

  /**
   * Evidence-based check for an operation that has no hash. It only READS; it never sends.
   * Resolves to a safe state only when the evidence is sufficient, otherwise the operation stays uncertain.
   */
  async reconcile(opId: string): Promise<{ verdict: Verdict; detail: string }> {
    const e = this.journal.getByOp(opId);
    if (!e || e.txHash || !["unknown-reconcile", "send-rate-limited"].includes(e.state)) return { verdict: "unknown", detail: "Nothing to check for this operation." };
    const wait = (e.retryAt ?? 0) - this.now();
    if (wait > 0) return { verdict: "unknown", detail: `Wait about ${Math.ceil(wait / 1000)}s before checking, so the RPC can recover.` };
    const others = this.journal.all().filter((x) => x.opId !== opId && x.wallet.toLowerCase() === e.wallet.toLowerCase() && UNRESOLVED.has(x.state));
    if (others.length) return this.keep(opId, { verdict: "unknown", detail: "Another operation from this account is still unresolved, so the account nonce cannot be attributed to this one. Resolve that one first." });
    let r: { verdict: Verdict; detail: string };
    try {
      r = await this.provider.reconcile(e);
    } catch (err) {
      const rl = err instanceof RateLimitedError || isRateLimitError(err);
      const retryAt = rl ? this.now() + (err instanceof RateLimitedError ? err.retryAfterMs : 15_000) : e.retryAt ?? null;
      r = { verdict: "unknown", detail: `The check could not complete (${(err as Error).message}).` };
      this.journal.patchByOp(opId, { retryAt });
    }
    if (r.verdict === "applied") this.journal.setState(opId, "finalized-ok", { executionResult: "STATE_ALREADY_APPLIED", lastError: r.detail, retryAt: null });
    else if (r.verdict === "not-found") this.journal.setState(opId, "rejected", { lastError: `${r.detail} Nothing was applied; you can try again.`, retryAt: null });
    else return this.keep(opId, r);
    return r;
  }

  private keep(opId: string, r: { verdict: Verdict; detail: string }) {
    this.journal.patchByOp(opId, { lastError: `Still uncertain: ${r.detail}` });
    return r;
  }

  /** Deliberate user decision after checking the explorer. Never automatic. */
  markNotSent(opId: string): void {
    const e = this.journal.getByOp(opId);
    if (!e || e.txHash || !["unknown-reconcile", "send-rate-limited"].includes(e.state)) return;
    this.journal.setState(opId, "rejected", { lastError: "Marked by you as not sent after checking the account in the explorer.", retryAt: null });
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
