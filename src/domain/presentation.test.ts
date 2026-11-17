import { describe, it, expect } from "vitest";
import { derivePresentation } from "./presentation";

describe("presentation state", () => {
  it("locks once the market is open or closed", () => {
    expect(derivePresentation({ phase: "open", mode: "demo", contractConfigured: true, hasUnresolvedTx: false }).selector).toBe("locked");
    expect(derivePresentation({ phase: "closed", mode: "live", contractConfigured: false, hasUnresolvedTx: false }).selector).toBe("locked");
  });
  it("live mode without a contract is unverified, never editable", () => {
    const p = derivePresentation({ phase: "upcoming", mode: "live", contractConfigured: false, hasUnresolvedTx: false });
    expect(p).toMatchObject({ selector: "unverified", canReview: false, unverified: true });
  });
  it("demo upcoming market is editable", () => {
    expect(derivePresentation({ phase: "upcoming", mode: "demo", contractConfigured: true, hasUnresolvedTx: false }).canReview).toBe(true);
  });
  it("an unresolved operation blocks a second review", () => {
    expect(derivePresentation({ phase: "upcoming", mode: "demo", contractConfigured: true, hasUnresolvedTx: true })).toMatchObject({ selector: "submitted", canReview: false });
  });
});
