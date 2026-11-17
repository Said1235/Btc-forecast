import { describe, it, expect } from "vitest";
import { derivePresentation } from "./presentation";
import { resolveAction } from "./contractRules";
import { DAY_MS } from "./market";

const base = { mode: "live" as const, contractReadable: true, hasUnresolvedTx: false };
describe("presentation state", () => {
  it("locks once the market is open or closed", () => {
    expect(derivePresentation({ ...base, phase: "open" }).selector).toBe("locked");
    expect(derivePresentation({ ...base, phase: "closed" }).selector).toBe("locked");
  });
  it("live upcoming market is editable when the contract is readable", () => {
    expect(derivePresentation({ ...base, phase: "upcoming" })).toMatchObject({ selector: "edit", canReview: true, unverified: false });
  });
  it("unreadable contract is unverified, never editable", () => {
    expect(derivePresentation({ ...base, phase: "upcoming", contractReadable: false })).toMatchObject({ selector: "unverified", canReview: false, unverified: true });
  });
  it("demo upcoming market is editable", () => {
    expect(derivePresentation({ phase: "upcoming", mode: "demo", contractReadable: true, hasUnresolvedTx: false }).canReview).toBe(true);
  });
  it("an unresolved operation blocks a second review", () => {
    expect(derivePresentation({ ...base, phase: "upcoming", hasUnresolvedTx: true })).toMatchObject({ selector: "submitted", canReview: false });
  });
});

describe("resolution steps (mirrors the contract policy)", () => {
  const t = Date.UTC(2026, 10, 16);
  it("waits for the 5 minute grace after the candle closed", () => {
    expect(resolveAction(t, t + DAY_MS + 299_999, null)).toMatchObject({ kind: "wait" });
    expect(resolveAction(t, t + DAY_MS + 300_000, null)).toEqual({ kind: "start" });
  });
  it("needs the confirmation interval after a candidate", () => {
    const cand = { confirmableAtMs: t + DAY_MS + 600_000 };
    expect(resolveAction(t, t + DAY_MS + 599_999, cand)).toMatchObject({ kind: "wait-confirm" });
    expect(resolveAction(t, t + DAY_MS + 600_000, cand)).toEqual({ kind: "confirm" });
  });
});
