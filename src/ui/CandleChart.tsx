import { useEffect, useRef, useState } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, createChart, LineStyle, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { Candle } from "../domain/candle";
import { directionOf } from "../domain/candle";
import { formatPrice } from "../domain/format";
import { useApp } from "../state/AppContext";

const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const fmtDate = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Chart of REAL (or clearly demo) daily candles. The forming candle is hollow and labelled. */
export function CandleChart({ candles, now, stale }: { candles: Candle[]; now: number; stale: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const { theme } = useApp();
  const [hover, setHover] = useState<Candle | null>(null);
  const byTime = useRef(new Map<number, Candle>());

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const c = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css("--muted"), fontFamily: css("--mono"), fontSize: 12 },
      grid: { vertLines: { color: css("--line") }, horzLines: { color: css("--line") } },
      rightPriceScale: { borderColor: css("--line") },
      timeScale: { borderColor: css("--line"), rightOffset: 4, timeVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { priceFormatter: (p: number) => formatPrice(p) },
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: css("--up"), downColor: css("--down"), borderUpColor: css("--up"), borderDownColor: css("--down"),
      wickUpColor: css("--up"), wickDownColor: css("--down"),
    });
    chart.current = c;
    series.current = s;
    c.subscribeCrosshairMove((p) => {
      const t = p.time as number | undefined;
      if (!t) return setHover(null);
      setHover(byTime.current.get(t * 1000) ?? null);
    });
    return () => { c.remove(); chart.current = null; series.current = null; };
  }, [theme]);

  // `now` ticks every second. Only the forming/closed state of the last candle matters to the drawing,
  // so the series is rebuilt when that flips or the data changes, never on every tick.
  const lastOpen = candles.length ? candles[candles.length - 1].openTime : 0;
  const formingLast = candles.length > 0 && now < lastOpen + 86_400_000;
  const nowRef = useRef(now);
  useEffect(() => { nowRef.current = now; }); // declared before the data effect, so it runs first
  const rangeSet = useRef(false);
  useEffect(() => { rangeSet.current = false; }, [theme]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const now = nowRef.current;
    byTime.current = new Map(candles.map((c) => [c.openTime, c]));
    const up = css("--up"), down = css("--down"), flat = css("--flat");
    s.setData(
      candles.map((c) => {
        const forming = now < c.openTime + 86_400_000;
        const d = directionOf(c.open, c.close);
        const col = d === "UP" ? up : d === "DOWN" ? down : flat;
        return forming
          ? { time: (c.openTime / 1000) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close, color: "transparent", borderColor: col, wickColor: col }
          : { time: (c.openTime / 1000) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close };
      }),
    );
    const last = candles[candles.length - 1];
    let line: ReturnType<typeof s.createPriceLine> | null = null;
    if (last && now < last.openTime + 86_400_000) line = s.createPriceLine({ price: last.open, color: css("--muted"), lineStyle: LineStyle.Dashed, lineWidth: 1, title: "Open" });
    // Initial framing only: never fight the user's pan and zoom on later updates.
    if (!rangeSet.current && candles.length) {
      chart.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, candles.length - 45), to: candles.length + 3 });
      rangeSet.current = true;
    }
    return () => { if (line) s.removePriceLine(line); };
  }, [candles, formingLast, theme]);

  const shown = hover ?? candles[candles.length - 1];
  const forming = !!shown && now < shown.openTime + 86_400_000;
  return (
    <div className={`chart${stale ? " chart--stale" : ""}`}>
      {shown && (
        <div className="chart__legend num" aria-live="off">
          <span><b>{fmtDate(shown.openTime)}</b> UTC{forming ? " · forming" : ""}</span>
          <span>O <b>{formatPrice(shown.open)}</b></span>
          <span>H <b>{formatPrice(shown.high)}</b></span>
          <span>L <b>{formatPrice(shown.low)}</b></span>
          <span>{forming ? "Last" : "C"} <b>{formatPrice(shown.close)}</b></span>
        </div>
      )}
      <div ref={host} style={{ position: "absolute", inset: 0 }} role="img" aria-label={`BTCUSDT daily candlestick chart, ${candles.length} candles, UTC dates. Hollow candle is the one still forming.`} />
    </div>
  );
}
