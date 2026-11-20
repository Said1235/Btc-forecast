import { describe, it, expect } from "vitest";
import src from "../../../contracts/btc_forecast.py?raw";
import adapterSrc from "./genlayerAdapter.ts?raw";
import { CONTRACT_METHODS } from "./adapter";
import { STUDIO_DEFAULTS } from "../../config";
import { CONFIRMATION_INTERVAL_MS, HORIZON_MS, RESOLUTION_GRACE_MS } from "../../domain/contractRules";

/**
 * The authoritative Intelligent Contract lives in this repository (contracts/btc_forecast.py), byte for byte
 * the source deployed at STUDIO_DEFAULTS.contractAddress. These tests fail if the client calls a method the
 * contract does not have, or if the rules the UI shows drift from the contract's constants.
 */

const methods = (kind: "write" | "view") =>
  [...src.matchAll(new RegExp(`@gl\\.public\\.${kind}\\s*\\n\\s*def (\\w+)\\(`, "g"))].map((m) => m[1]);
const constant = (name: string) => {
  const m = src.match(new RegExp(`^${name}\\s*=\\s*(.+?)\\s*(#.*)?$`, "m"));
  if (!m) throw new Error(`constant ${name} not found in the contract`);
  return m[1].replace(/_/g, "");
};

describe("contract source in the repository matches the client", () => {
  it("exposes exactly the write methods the client calls", () => {
    expect(methods("write").sort()).toEqual(Object.values(CONTRACT_METHODS).sort());
  });
  it("exposes every view the client reads", () => {
    const used = [...adapterSrc.matchAll(/call\("(get_\w+)"/g)].map((m) => m[1]);
    expect(new Set(used).size).toBeGreaterThanOrEqual(4);
    for (const v of new Set(used)) expect(methods("view")).toContain(v);
  });
  it("uses the Binance settlement source the page describes", () => {
    expect(src).toContain('KLINES_URL = "https://data-api.binance.vision/api/v3/klines"');
    expect(src).toContain('SYMBOL = "BTCUSDT"');
    expect(src).toContain('INTERVAL = "1d"');
    expect(src).toContain("gl.vm.run_nondet");
  });
  it("keeps the timing rules in sync with the UI", () => {
    expect(Number(constant("RESOLUTION_GRACE_MS"))).toBe(RESOLUTION_GRACE_MS);
    expect(Number(constant("CONFIRMATION_INTERVAL_MS"))).toBe(CONFIRMATION_INTERVAL_MS);
    expect(constant("HORIZON_MS").replace(/[ _]/g, "")).toBe("7*DAYMS");
    expect(HORIZON_MS).toBe(7 * 86_400_000);
  });
  it("is the contract the client is configured for", () => {
    expect(STUDIO_DEFAULTS.contractAddress).toBe("0x8AB7b7FB6771cb91d65623964df704c075e7e2b7");
  });
});
