import { describe, it, expect } from "vitest";
import { directionOf, finalOutcome, parseKline, parseKlines, isCandleComplete } from "./candle";
import { currentMarket, nextMarket, phaseAt, utcDayStart, marketDate, formatCountdown, DAY_MS } from "./market";
import { validatePick } from "./outcomes";

const D = Date.UTC(2026, 10, 15); // 2026-11-15 00:00 UTC
const row = (o = "100.00", h = "110.00", l = "90.00", c = "105.00", t = D) => [t, o, h, l, c, "12.5", t + DAY_MS - 1];

describe("UTC market boundaries", () => {
  it("23:59:59.999 UTC is still the same market", () => {
    expect(marketDate(currentMarket(D + DAY_MS - 1).openTime)).toBe("2026-11-15");
  });
  it("00:00:00.000 UTC starts the next market", () => {
    expect(marketDate(currentMarket(D + DAY_MS).openTime)).toBe("2026-11-16");
  });
  it("is independent of the local timezone (uses epoch math)", () => {
    expect(utcDayStart(Date.parse("2026-11-15T23:30:00-05:00"))).toBe(Date.UTC(2026, 10, 16));
  });
  it("next market is the following UTC day", () => {
    expect(nextMarket(D + 5000).date).toBe("2026-11-16");
  });
  it("phase transitions at the exact boundaries", () => {
    const w = currentMarket(D);
    expect(phaseAt(w, D - 1)).toBe("upcoming");
    expect(phaseAt(w, D)).toBe("open");
    expect(phaseAt(w, D + DAY_MS - 1)).toBe("open");
    expect(phaseAt(w, D + DAY_MS)).toBe("closed");
  });
  it("formats a countdown", () => expect(formatCountdown(3_723_000)).toBe("01:02:03"));
});

describe("UP / DOWN / FLAT", () => {
  it("classifies by numeric comparison", () => {
    expect(directionOf(100, 100.01)).toBe("UP");
    expect(directionOf(100, 99.99)).toBe("DOWN");
    expect(directionOf(100, 100)).toBe("FLAT");
  });
  it("does not use rounded display values", () => {
    expect(directionOf(100.001, 100.002)).toBe("UP");
    expect(directionOf(0.3, 0.1 + 0.2)).toBe("UP"); // parsed numeric values are compared exactly, never rounded
  });
  it("treats identical decimal strings as FLAT", () => {
    const c = parseKline(row("100.10", "110", "90", "100.10"));
    expect(directionOf(c.open, c.close)).toBe("FLAT");
  });
  it("never gives a final outcome for an incomplete candle", () => {
    const c = parseKline(row());
    expect(finalOutcome(c, D + 1000)).toBeNull();
    expect(isCandleComplete(c, D + DAY_MS - 1)).toBe(false);
    expect(finalOutcome(c, D + DAY_MS)).toBe("UP");
  });
});

describe("candle parsing", () => {
  it("rejects malformed rows", () => {
    expect(() => parseKline([1, 2])).toThrow();
    expect(() => parseKline(row("x"))).toThrow();
    expect(() => parseKline(row("100", "90", "95", "100"))).toThrow(/inconsistent/);
    expect(() => parseKline(row("100", "110", "90", "105", D + 1))).toThrow(/00:00 UTC/);
  });
  it("rejects empty and non-list payloads", () => {
    expect(() => parseKlines([])).toThrow(/No candles/);
    expect(() => parseKlines({})).toThrow();
  });
  it("removes duplicate candles and sorts", () => {
    const out = parseKlines([row("1", "2", "1", "2", D + DAY_MS), row("1", "2", "1", "1.5", D), row("1", "2", "1", "1.8", D)]);
    expect(out.map((c) => c.openTime)).toEqual([D, D + DAY_MS]);
    expect(out[0].close).toBe(1.8);
  });
});

describe("prediction validation", () => {
  it("requires a valid option", () => {
    expect(validatePick(null).ok).toBe(false);
    expect(validatePick("SIDEWAYS").ok).toBe(false);
    expect(validatePick("UP")).toEqual({ ok: true, pick: "UP" });
  });
});
