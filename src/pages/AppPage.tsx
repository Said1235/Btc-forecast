import { useState } from "react";
import { useApp } from "../state/AppContext";
import { CandleChart } from "../ui/CandleChart";
import { PredictionPanel } from "../ui/PredictionPanel";
import { Banner, OutcomeTag } from "../ui/parts";
import { currentMarket, formatCountdown, formatUtcStamp, msUntil, nextMarket, phaseAt } from "../domain/market";
import { directionOf, finalOutcome, type Candle } from "../domain/candle";
import { formatPct, formatPoints, formatPrice, formatSigned } from "../domain/format";
import { CLOCK_DRIFT_WARN_MS } from "../data/binance";

const PHASE_LABEL = { upcoming: "Upcoming: opens soon", open: "Candle open", closed: "Candle closed" } as const;

function MarketData({ candles }: { candles: Candle[] }) {
  const { md, mode } = useApp();
  const today = candles[candles.length - 1];
  const forming = !!today && md.now < today.openTime + 86_400_000;
  const dir = today ? directionOf(today.open, today.close) : "FLAT";
  const change = today ? today.close - today.open : 0;
  return (
    <div className="price">
      <div className="big">
        <div>
          <div className="k">{forming ? "Current price (candle still open)" : "Last close"}</div>
          <div className="v num">{formatPrice(today.close)}</div>
        </div>
        <div style={{ display: "grid", gap: 2 }}>
          <span className="k">{forming ? "Live, in progress. Not a result." : "Completed candle"}</span>
          <OutcomeTag o={dir} prefix={forming ? "Leaning " : ""} />
          <span className="num t--FLAT" style={{ fontSize: 14 }}>{formatSigned(change)} ({formatPct((change / today.open) * 100)}) vs open</span>
        </div>
      </div>
      <div><div className="k">Daily open (UTC)</div><div className="v num">{formatPrice(today.open)}</div></div>
      <div><div className="k">High</div><div className="v num">{formatPrice(today.high)}</div></div>
      <div><div className="k">Low</div><div className="v num">{formatPrice(today.low)}</div></div>
      <div><div className="k">Volume (BTC)</div><div className="v num">{today.volume.toLocaleString("en-US", { maximumFractionDigits: 0 })}</div></div>
      <span className="sr">{mode === "demo" ? "Demo data" : "Binance Spot data"}</span>
    </div>
  );
}

function History({ candles }: { candles: Candle[] }) {
  const { md, user, mode, account } = useApp();
  const done = candles.filter((c) => finalOutcome(c, md.now)).slice(-7).reverse();
  return (
    <div className="grid" style={{ alignItems: "start" }}>
      <section className="box" aria-labelledby="mh-h">
        <div className="box__h"><h2 id="mh-h">Market history</h2><span className="chip">{mode === "demo" ? "DEMO candles" : "Binance candles"}</span></div>
        {done.length === 0 ? <div className="box__b"><div className="empty">No completed candles to show.</div></div> : <div className="tbl-wrap">
          <table className="tbl">
            <caption className="sr">Recent completed daily candles and their direction. This is market data, not contract settlement.</caption>
            <thead><tr><th>UTC day</th><th>Open</th><th>Close</th><th>Candle</th></tr></thead>
            <tbody>
              {done.map((c) => (
                <tr key={c.openTime}>
                  <td className="num">{new Date(c.openTime).toISOString().slice(0, 10)}</td>
                  <td className="num">{formatPrice(c.open)}</td>
                  <td className="num">{formatPrice(c.close)}</td>
                  <td><OutcomeTag o={directionOf(c.open, c.close)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
        <p style={{ padding: "var(--s3) var(--s4)", color: "var(--muted)", fontSize: 13 }}>Market direction from the candle only. It is not a contract settlement and does not say how anyone predicted.</p>
      </section>
      <section className="box" aria-labelledby="my-h">
        <div className="box__h"><h2 id="my-h">My activity</h2>{mode === "demo" && <span className="chip chip--demo">DEMO</span>}</div>
        <div className="box__b">
          {!account ? (
            <div className="empty">Connect a wallet to see your predictions and points.</div>
          ) : user.status === "loading" ? (
            <div className="skel" style={{ height: 80 }} aria-label="Loading your activity" />
          ) : user.status === "not-configured" ? (
            <Banner kind="info" title="Contract not connected">Your points and past predictions come from the contract, so they are unavailable until it is configured. Nothing is estimated.</Banner>
          ) : user.status === "unavailable" ? (
            <Banner kind="warn" title="Contract data unavailable" detail={user.reason} />
          ) : (
            <>
              <div><div className="pts num">{user.points}</div><div style={{ color: "var(--muted)", fontSize: 14 }}>{formatPoints(user.points ?? 0)}{mode === "demo" ? " (demo)" : ""}</div></div>
              {user.history.length === 0 ? <div className="empty">No predictions yet.</div> : (
                <div className="tbl-wrap">
                  <table className="tbl">
                    <caption className="sr">Your past predictions</caption>
                    <thead><tr><th>UTC day</th><th>You</th><th>Result</th></tr></thead>
                    <tbody>
                      {user.history.map((h) => (
                        <tr key={h.marketId}><td className="num">{h.marketId}</td><td><OutcomeTag o={h.pick} /></td><td>{h.correct === null ? "Pending" : h.correct ? "Correct, +1" : "Incorrect, 0"}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

export function AppPage() {
  const { md, mode, setMode, refresh, adapter } = useApp();
  const [view, setView] = useState<"next" | "today">("next");
  const candles = md.snapshot?.candles ?? [];
  const market = view === "next" ? nextMarket(md.now) : currentMarket(md.now);
  const phase = phaseAt(market, md.now);
  const err = md.error;
  const errCopy: Record<string, string> = {
    offline: "This browser is offline.", timeout: "Binance took too long to answer.", rate_limited: "Binance is rate limiting requests. Retrying automatically after the pause.",
    unavailable: "Binance could not be reached.", invalid: "Binance returned data this app cannot trust.", aborted: "",
  };
  const closeIn = msUntil(currentMarket(md.now).closeTime, md.now);
  const updated = md.snapshot ? new Date(md.snapshot.receivedAt).toISOString().slice(11, 19) + " UTC" : "never";

  return (
    <main id="main" className="wrap app rise">
      <div className="mh">
        <div className="mh__row">
          <h1>BTCUSDT daily forecast</h1>
          <span className="chip">Binance Spot</span><span className="chip">1d</span>
          {mode === "demo" ? <span className="chip chip--demo"><i className="dot" />DEMO data</span> : md.snapshot?.fromCache ? <span className="chip chip--stale"><i className="dot" />CACHED</span> : md.stale ? <span className="chip chip--stale"><i className="dot" />STALE</span> : md.status === "ok" ? <span className="chip chip--live"><i className="dot" />LIVE</span> : null}
        </div>
        <div className="mh__meta">
          <span>Market day <b className="num">{market.date}</b> UTC</span>
          <span>Phase <b>{PHASE_LABEL[phase]}</b></span>
          <span>Closes in <b className="num">{formatCountdown(closeIn)}</b> (today's candle)</span>
          <span>Last update <b className="num">{updated}</b></span>
        </div>
        <div className="seg" role="group" aria-label="Market day">
          <button aria-pressed={view === "next"} onClick={() => setView("next")}>Next market</button>
          <button aria-pressed={view === "today"} onClick={() => setView("today")}>Today's market</button>
        </div>
      </div>

      {err && err.kind !== "aborted" && (
        <Banner kind="error" title={md.snapshot ? "Market data could not be refreshed" : "Market data is unavailable"}
          detail={err.message}
          actions={<><button className="btn btn--sm" onClick={refresh}>Retry now</button><button className="btn btn--sm" onClick={() => setMode("demo")}>Explore in Demo Mode</button></>}>
          <p>{errCopy[err.kind]} {md.snapshot ? `Showing the last successful update from ${updated}${md.snapshot?.fromCache ? " (cached in this browser)" : ""}. The chart is marked stale.` : "No prices are shown. Demo Mode is separate and always labelled."}</p>
        </Banner>
      )}
      {!err && md.snapshot?.fromCache && <Banner kind="warn" title="Showing cached market data">These prices were saved in this browser from {updated} and are not live. They update as soon as Binance answers.</Banner>}
      {!err && !md.snapshot?.fromCache && md.stale && <Banner kind="warn" title="Market data is stale">The last successful update was at {updated}.</Banner>}
      {Math.abs(md.driftMs) > CLOCK_DRIFT_WARN_MS && mode === "live" && <Banner kind="warn" title="Your clock differs from the exchange">Your device is off by about {Math.round(Math.abs(md.driftMs) / 1000)} s. Market times here use the exchange's clock.</Banner>}
      {mode === "live" && !adapter.configured && <Banner kind="info" title="Contract integration not configured">Market data is live, but predictions, results and points need the GenLayer contract, which is not connected to this build yet. No contract reads or writes are attempted.</Banner>}

      <div className="grid">
        <section className="box" aria-labelledby="mk-h">
          <div className="box__h"><h2 id="mk-h">Market data</h2><span className="num" style={{ fontSize: 13, color: "var(--muted)" }}>{formatUtcStamp(md.now)}</span></div>
          <div className="box__b">
            {md.status === "loading" && !md.snapshot ? <div className="skel" style={{ height: 380 }} aria-label="Loading market data" /> : candles.length ? (
              <>
                <MarketData candles={candles} />
                <CandleChart candles={candles} now={md.now} stale={md.stale} />
                <div className="keyline" aria-label="Chart key">
                  <span><i className="sw" style={{ borderColor: "var(--up)", background: "var(--up)" }} />Completed, closed above open</span>
                  <span><i className="sw" style={{ borderColor: "var(--down)", background: "var(--down)" }} />Completed, closed below open</span>
                  <span><i className="sw" style={{ borderColor: "var(--ink)" }} />Hollow: still forming</span>
                </div>
              </>
            ) : (
              <div className="empty">No market data to show. {mode === "live" ? "Use Retry now, or open Demo Mode to explore the interface with clearly labelled fixtures." : ""}</div>
            )}
          </div>
        </section>
        <PredictionPanel market={market} isNext={view === "next"} />
      </div>
      <History candles={candles} />
    </main>
  );
}
