import { useState } from "react";
import { useApp } from "../state/AppContext";
import { DAY_MS, formatUtcStamp, marketWindowFor, utcDayStart } from "../domain/market";
import { resolveAction } from "../domain/contractRules";
import { formatPoints } from "../domain/format";
import { Banner, OutcomeTag } from "./parts";
import { TxPanel } from "./PredictionPanel";
import { UNRESOLVED } from "../tx/types";

const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19) + " UTC";

export function Activity() {
  const { user, account, mode, md, entries, act, refetchUser, wrongNetwork, toast } = useApp();
  const [err, setErr] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const today = utcDayStart(md.now);
  const closed = Array.from({ length: 7 }, (_, i) => today - (i + 1) * DAY_MS);
  const mine = entries.filter((e) => e.wallet === account).slice(-4).reverse();

  const run = async (method: "resolve_market" | "claim_points", t: number) => {
    const key = `${method}:${t}`;
    setBusyKey(key);
    setErr(null);
    const r = await act(method, t);
    setBusyKey(null);
    if (r.error) setErr(r.error);
    else if (r.entry?.state === "finalized-ok") toast(method === "claim_points" ? "Claim recorded by the contract." : "Resolution step recorded by the contract.");
    refetchUser();
  };
  const pending = (method: string, t: number) => entries.some((e) => e.wallet === account && e.method === method && e.args.marketId === marketWindowFor(t).date && UNRESOLVED.has(e.state));

  return (
    <section className="box" aria-labelledby="my-h">
      <div className="box__h">
        <h2 id="my-h">My activity</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {mode === "demo" && <span className="chip chip--demo">DEMO</span>}
          {account && <button className="btn btn--sm" onClick={refetchUser}>Refresh</button>}
        </div>
      </div>
      <div className="box__b">
        {!account ? (
          <div className="empty">Connect a wallet to see your predictions and points.</div>
        ) : user.status === "loading" ? (
          <div className="skel" style={{ height: 80 }} aria-label="Loading your activity" />
        ) : (
          <>
            {user.status === "unavailable" && <Banner kind="warn" title="Contract data unavailable" detail={user.reason} actions={<button className="btn btn--sm" onClick={refetchUser}>Retry</button>}><p>Some contract reads failed. Nothing below is estimated; missing rows are simply not shown.</p></Banner>}
            <div>
              <div className="pts num">{user.points ?? "—"}</div>
              <div style={{ color: "var(--muted)", fontSize: 14 }}>{user.points === null ? "Points unavailable" : formatPoints(user.points)}{mode === "demo" ? " (demo)" : " from the contract, counted after you claim"}</div>
            </div>
            {err && <p className="field-err" role="alert">{err}</p>}
            {(() => {
              const rows = closed.map((t) => ({ t, r: user.rows.get(t) })).filter(({ r }) => r?.prediction.status === "ok" && r.prediction.value);
              if (rows.length === 0) return <div className="empty">No predictions in the last 7 closed markets.</div>;
              return (
                <div className="tbl-wrap">
                  <table className="tbl">
                    <caption className="sr">Your predictions for recent closed markets, their contract status and available actions</caption>
                    <thead><tr><th>UTC day</th><th>You</th><th>Market</th><th>Points</th><th>Next step</th></tr></thead>
                    <tbody>
                      {rows.map(({ t, r }) => {
                        const p = r!.prediction.status === "ok" ? r!.prediction.value! : null!;
                        const m = r!.market.status === "ok" ? r!.market.value : null;
                        const res = m?.result ?? null, cand = m?.candidate ?? null;
                        const ra = resolveAction(t, md.now, cand);
                        const date = marketWindowFor(t).date;
                        return (
                          <tr key={t}>
                            <td className="num">{date}</td>
                            <td><OutcomeTag o={p.pick} /></td>
                            <td>{!m ? "Unavailable" : res ? <span>Final <OutcomeTag o={res.outcome} /></span> : cand ? <span>Provisional <OutcomeTag o={cand.outcome} /></span> : "Awaiting resolution"}</td>
                            <td>{res ? (p.processed ? (p.pick === res.outcome ? "+1 claimed" : "0 claimed") : "Not claimed yet") : "—"}</td>
                            <td>
                              {!m ? "—" : res ? (
                                p.processed ? "Done" : <button className="btn btn--sm btn--primary" disabled={wrongNetwork || pending("claim_points", t) || busyKey === `claim_points:${t}`} onClick={() => void run("claim_points", t)}>Claim result</button>
                              ) : ra.kind === "wait" ? (
                                <span className="num" style={{ color: "var(--muted)" }}>Resolution opens {hhmmss(ra.until)}</span>
                              ) : ra.kind === "wait-confirm" ? (
                                <span className="num" style={{ color: "var(--muted)" }}>Confirm from {hhmmss(ra.until)}</span>
                              ) : (
                                <button className="btn btn--sm" disabled={wrongNetwork || pending("resolve_market", t) || busyKey === `resolve_market:${t}`} onClick={() => void run("resolve_market", t)}>{ra.kind === "start" ? "Start resolution" : "Confirm resolution"}</button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })()}
            <p style={{ color: "var(--muted)", fontSize: 13 }}>Resolution is two steps by anyone: a provisional observation, then a confirmation at least 5 minutes later. Only a confirmed result is final and can be claimed. The contract may still refuse a step (for example if the data differs); its answer is shown.</p>
            {mine.map((e) => <TxPanel key={e.opId} entry={e} />)}
            <p style={{ color: "var(--muted)", fontSize: 12 }}>Latest read {user.status === "ok" ? "succeeded" : "had errors"} · markets shown: {formatUtcStamp(today - DAY_MS).slice(0, 10)} and earlier</p>
          </>
        )}
      </div>
    </section>
  );
}
