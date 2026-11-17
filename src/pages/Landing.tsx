import { useEffect, useState } from "react";
import { Glyph } from "../ui/parts";
import { currentMarket, formatCountdown, msUntil } from "../domain/market";

function OpenLine() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const w = currentMarket(now);
  return (
    <div className="hero__vis" role="img" aria-label="Illustration of the rule: a daily candle compared with its opening price line, with three possible outcomes">
      <svg viewBox="0 0 520 380" style={{ display: "block", width: "100%", height: "auto" }} aria-hidden="true">
        <line x1="40" y1="190" x2="500" y2="190" stroke="var(--muted)" strokeDasharray="4 5" />
        <text x="40" y="214" fontFamily="var(--mono)" fontSize="12" fill="var(--muted)">OPEN, 00:00 UTC</text>
        <g stroke="currentColor" fill="none" strokeWidth="2">
          <g style={{ color: "var(--up)" }}><line x1="120" y1="60" x2="120" y2="150" /><rect x="100" y="90" width="40" height="100" fill="var(--up)" /></g>
          <g style={{ color: "var(--flat)" }}><line x1="260" y1="150" x2="260" y2="230" /><line x1="238" y1="190" x2="282" y2="190" strokeWidth="4" /></g>
          <g style={{ color: "var(--down)" }}><line x1="400" y1="230" x2="400" y2="330" /><rect x="380" y="190" width="40" height="100" fill="var(--down)" /></g>
        </g>
        <g fontFamily="var(--display)" fontSize="22" fontWeight="500" fill="var(--ink)" textAnchor="middle">
          <text x="120" y="40">UP</text><text x="260" y="130">FLAT</text><text x="400" y="360">DOWN</text>
        </g>
        <g fontFamily="var(--mono)" fontSize="12" fill="var(--muted)" textAnchor="middle">
          <text x="120" y="56">close &gt; open</text><text x="260" y="146">close = open</text><text x="400" y="346" opacity="0">.</text>
        </g>
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "12px 16px", borderTop: "1px solid var(--line)", background: "var(--bg)", fontSize: 14 }}>
        <span>Today's UTC candle ({w.date}) closes in</span>
        <b className="num">{formatCountdown(msUntil(w.closeTime, now))}</b>
      </div>
    </div>
  );
}

export function Landing() {
  return (
    <main id="main">
      <section className="hero">
        <div className="wrap hero__grid">
          <div>
            <p className="eyebrow">BTCUSDT · Daily forecast</p>
            <h1>Call Bitcoin's daily close.</h1>
            <p className="lead">Each UTC day, predict whether the Binance Spot BTCUSDT candle closes above its open (UP), below it (DOWN), or exactly at it (FLAT). A correct call earns one point. There are no stakes and no prizes.</p>
            <div className="ctas"><a className="btn btn--primary" href="#/app">Open forecast</a><a className="btn" href="#how">How it works</a></div>
          </div>
          <OpenLine />
        </div>
      </section>

      <section className="sec" id="how" aria-labelledby="how-h">
        <div className="wrap">
          <p className="eyebrow">How it works</p>
          <h2 id="how-h">Three steps per day</h2>
          <ol className="steps">
            <li><span className="n">01</span><h3>Review the market</h3><p>See the current BTCUSDT daily candle, its open, high, low and the time left until it closes at 00:00 UTC.</p></li>
            <li><span className="n">02</span><h3>Submit a prediction</h3><p>Pick UP, DOWN or FLAT for the next UTC day before its market opens. Once it opens, the call is locked.</p></li>
            <li><span className="n">03</span><h3>Check the result</h3><p>After the candle closes, the result and your points depend on the contract's settlement process, so they are not instant.</p></li>
          </ol>
        </div>
      </section>

      <section className="sec sec--alt" id="market" aria-labelledby="mk-h">
        <div className="wrap">
          <p className="eyebrow">The market</p>
          <h2 id="mk-h">One rule, three outcomes</h2>
          <p className="lead">The comparison is arithmetic on the candle's open and close prices. Markets start and end at 00:00 UTC, whatever your local time zone.</p>
          <div className="rules">
            {(["UP", "DOWN", "FLAT"] as const).map((o) => (
              <div className="rule" key={o}>
                <b><Glyph o={o} />{o}</b>
                <span className="num">{o === "UP" ? "close > open" : o === "DOWN" ? "close < open" : "close = open"}</span>
                <p style={{ color: "var(--muted)" }}>{o === "UP" ? "The day ends higher than it started." : o === "DOWN" ? "The day ends lower than it started." : "The day closes at exactly its opening price."}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="sec" id="technology" aria-labelledby="tc-h">
        <div className="wrap">
          <p className="eyebrow">Technology</p>
          <h2 id="tc-h">What each part does</h2>
          <div className="tech">
            <div><h3>Binance</h3><p>Provides the BTCUSDT Spot daily candle data shown in the chart and price summary.</p></div>
            <div><h3>GenLayer</h3><p>Hosts the Intelligent Contract that is the authority for recorded predictions, results and points.</p></div>
            <div><h3>MetaMask and compatible wallets</h3><p>Authorize blockchain transactions with your approval. Connecting a wallet alone never sends one.</p></div>
          </div>
          <p className="notes">This is a prediction game, not a betting product: there are no deposits, tokens or payouts. The interface reads market data and, once connected, contract state. It does not settle markets or award points itself.</p>
        </div>
      </section>

      <footer className="foot">
        <div className="wrap foot__in">
          <span>© BTC Forecast · BTCUSDT daily prediction game</span>
          <span>
            <a href="#/app">Open app</a>
            <a href="https://docs.genlayer.com" rel="noreferrer" target="_blank">GenLayer docs</a>
            <a href="https://developers.binance.com/docs/binance-spot-api-docs" rel="noreferrer" target="_blank">Binance Spot API</a>
          </span>
        </div>
      </footer>
    </main>
  );
}
