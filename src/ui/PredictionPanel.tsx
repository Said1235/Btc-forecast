import { useState } from "react";
import type { Outcome } from "../domain/candle";
import { OUTCOMES, OUTCOME_COPY, validatePick } from "../domain/outcomes";
import { derivePresentation } from "../domain/presentation";
import { formatUtcStamp, type MarketWindow } from "../domain/market";
import { phaseAt } from "../domain/market";
import { useApp } from "../state/AppContext";
import { DuplicateSubmissionError } from "../tx/tracker";
import { UNRESOLVED, type JournalEntry, type TxState } from "../tx/types";
import { Banner, Dialog, Glyph, OutcomeTag } from "./parts";

export const TX_COPY: Record<TxState, { label: string; tone: "wait" | "ok" | "bad" }> = {
  "awaiting-approval": { label: "Waiting for wallet approval", tone: "wait" },
  submitting: { label: "Submitting", tone: "wait" },
  submitted: { label: "Submitted. Hash received, waiting for the network", tone: "wait" },
  processing: { label: "Processing", tone: "wait" },
  decision: { label: "Decision available, not final yet", tone: "wait" },
  finalizing: { label: "Finalizing", tone: "wait" },
  "finalized-ok": { label: "Finalized and verified by read-back", tone: "ok" },
  "finalized-error": { label: "Finalized, but execution failed", tone: "bad" },
  undetermined: { label: "Undetermined or unsuccessful outcome", tone: "bad" },
  rejected: { label: "Rejected before submission", tone: "bad" },
  "tracking-unavailable": { label: "Tracking temporarily unavailable", tone: "wait" },
  "unknown-reconcile": { label: "Unknown outcome: needs reconciliation", tone: "bad" },
  "readback-mismatch": { label: "Read-back does not match what was submitted", tone: "bad" },
};
const STAGES: TxState[][] = [["awaiting-approval", "submitting"], ["submitted"], ["processing", "decision"], ["finalizing"], ["finalized-ok", "finalized-error", "readback-mismatch"]];

export function TxPanel({ entry, onResume }: { entry: JournalEntry; onResume: () => void }) {
  const c = TX_COPY[entry.state];
  const stage = STAGES.findIndex((s) => s.includes(entry.state));
  const demo = entry.networkId === "demo";
  return (
    <div className={`tx tx--${c.tone}`} data-testid="tx-panel">
      <div className="tx__h"><span>{c.label}</span>{demo && <span className="chip chip--demo">DEMO</span>}</div>
      <div className="prog" aria-hidden="true">{STAGES.map((_, i) => <i key={i} className={i <= stage ? "on" : ""} />)}</div>
      <dl className="dl">
        <dt>Prediction</dt><dd><OutcomeTag o={entry.args.pick} /> for {entry.args.marketId}</dd>
        <dt>{demo ? "Demo id" : "Tx hash"}</dt><dd className="num">{entry.txHash ?? "none yet"}</dd>
        <dt>Wallet</dt><dd className="num">{entry.wallet}</dd>
      </dl>
      {demo && <p style={{ color: "var(--muted)" }}>Simulated lifecycle. No transaction was sent and nothing was written to a contract.</p>}
      {entry.lastError && <p role="status" style={{ color: c.tone === "bad" ? "var(--err)" : "var(--warn)" }}>{entry.lastError}</p>}
      {(entry.state === "tracking-unavailable") && <div><button className="btn btn--sm" onClick={onResume}>Resume tracking this transaction</button></div>}
    </div>
  );
}

export function PredictionPanel({ market, isNext }: { market: MarketWindow; isNext: boolean }) {
  const { mode, adapter, account, entries, tracker, md, wallet, walletApi, wrongNetwork, netInfo, toast, user } = useApp();
  const [pick, setPick] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const phase = phaseAt(market, md.now);
  const mine = entries.filter((e) => e.wallet === account && e.args.marketId === market.date);
  const latest = mine[mine.length - 1];
  const hasUnresolved = mine.some((e) => UNRESOLVED.has(e.state) || e.state === "finalized-ok");
  const pres = derivePresentation({ phase, mode, contractConfigured: adapter.configured, hasUnresolvedTx: hasUnresolved });
  const done = latest?.state === "finalized-ok" ? latest.args.pick : null;
  const shownPick = done ?? pick;
  const interactive = pres.selector === "edit";
  const needsWallet = mode === "live" && !account;

  const review = () => {
    const v = validatePick(pick);
    if (!v.ok) return setError(v.error);
    setError(null);
    setConfirm(true);
  };

  const submit = async () => {
    const v = validatePick(pick);
    if (!v.ok || !account || busy) return;
    setBusy(true);
    try {
      const e = await tracker.submit({ ...netInfo, wallet: account, method: "submit_prediction", args: { marketId: market.date, pick: v.pick }, marketOpenTime: market.openTime });
      setConfirm(false);
      if (e.state === "finalized-ok") toast(mode === "demo" ? "Demo prediction recorded in this browser session only." : "Prediction confirmed by the contract.");
    } catch (err) {
      if (err instanceof DuplicateSubmissionError) setError("A prediction for this market is already being tracked. Wait for it to resolve.");
      else setError((err as Error).message);
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="box" aria-labelledby="pred-h">
      <div className="box__h">
        <h2 id="pred-h">Your prediction</h2>
        {mode === "demo" ? <span className="chip chip--demo">DEMO</span> : pres.unverified ? <span className="chip chip--stale">Unverified</span> : null}
      </div>
      <div className="box__b">
        <p className="q">Will BTCUSDT close above or below the open on {market.date}?</p>
        {!interactive && (
          <Banner kind={pres.selector === "locked" ? "info" : pres.unverified ? "warn" : "info"} title={pres.selector === "locked" ? "Prediction locked" : pres.unverified ? "Cannot verify or record predictions yet" : "Prediction submitted"}>
            <p>{pres.reason} {pres.unverified && "A local timer is not authoritative: once connected, the contract decides."}</p>
          </Banner>
        )}
        <fieldset className="opts" role="radiogroup" aria-label="Prediction options" aria-describedby={error ? "pick-err" : undefined}>
          {OUTCOMES.map((o) => (
            <button key={o} type="button" role="radio" aria-checked={shownPick === o} className="opt" disabled={!interactive} onClick={() => { setPick(o); setError(null); }}
              onKeyDown={(e) => {
                if (!interactive) return;
                const i = OUTCOMES.indexOf(o);
                if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); setPick(OUTCOMES[(i + 1) % 3]); (e.currentTarget.parentElement?.children[(i + 1) % 3] as HTMLElement).focus(); }
                if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); setPick(OUTCOMES[(i + 2) % 3]); (e.currentTarget.parentElement?.children[(i + 2) % 3] as HTMLElement).focus(); }
              }}>
              <b><Glyph o={o} />{o}</b>
              <span className="r">{OUTCOME_COPY[o].rule}</span>
            </button>
          ))}
        </fieldset>
        {error && <p id="pick-err" className="field-err" role="alert">{error}</p>}
        {isNext && interactive && (
          needsWallet ? (
            <button className="btn btn--primary" onClick={() => void walletApi.connect(wallet.selectedId ?? undefined)}>Connect wallet to continue</button>
          ) : (
            <button className="btn btn--primary" onClick={review} disabled={wrongNetwork}>Review prediction</button>
          )
        )}
        {wrongNetwork && <Banner kind="warn" title="Wrong network" actions={<button className="btn btn--sm" onClick={() => void walletApi.switchNetwork()}>Switch network</button>}><p>Your wallet is on chain {wallet.chainId}. Switch to continue. This app never switches it for you.</p></Banner>}
        <dl className="dl">
          <dt>Market</dt><dd>BTCUSDT · Binance Spot · 1d</dd>
          <dt>Opens</dt><dd className="num">{formatUtcStamp(market.openTime)}</dd>
          <dt>Points</dt><dd>1 point if correct, 0 if not. No stakes.</dd>
        </dl>
        {latest && <TxPanel entry={latest} onResume={() => void tracker.track(latest.opId)} />}
        {user.status === "ok" && !latest && mode === "demo" && <p style={{ color: "var(--muted)", fontSize: 14 }}>No demo prediction yet for this market.</p>}
      </div>
      {confirm && pick && (
        <Dialog title="Confirm your prediction" labelId="cf-h" onClose={() => !busy && setConfirm(false)}>
          <dl className="dl">
            <dt>Market</dt><dd>BTCUSDT daily, {market.date}</dd>
            <dt>Opens</dt><dd className="num">{formatUtcStamp(market.openTime)}</dd>
            <dt>Prediction</dt><dd><OutcomeTag o={pick} /> ({OUTCOME_COPY[pick].short})</dd>
          </dl>
          {mode === "demo" ? (
            <Banner kind="warn" title="Demo only">This will not send a transaction or write to any contract. It only shows how the flow behaves.</Banner>
          ) : (
            <p style={{ color: "var(--muted)" }}>When the integration is enabled, this prediction is recorded through GenLayer and your wallet will ask you to approve it.</p>
          )}
          <div className="acts">
            <button className="btn" onClick={() => setConfirm(false)} disabled={busy}>Cancel</button>
            <button className="btn btn--primary" onClick={() => void submit()} disabled={busy || !pres.canReview}>{busy ? "Working…" : mode === "demo" ? "Run demo flow" : "Submit prediction"}</button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
