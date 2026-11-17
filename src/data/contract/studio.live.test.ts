// Real network test against GenLayer StudioNet. Skipped unless LIVE_STUDIO=1.
//   LIVE_STUDIO=1 npx vitest run src/data/contract/studio.live.test.ts
import { describe, it, expect } from "vitest";
import { createGenLayerAdapter } from "./genlayerAdapter";
import { readConfig } from "../../config";
import { DAY_MS, utcDayStart } from "../../domain/market";

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
describe.runIf(env.LIVE_STUDIO === "1")("GenLayer StudioNet contract (real network)", () => {
  const cfg = readConfig({});
  it("RPC answers with chain id 61999 and the contract exposes the expected schema", async () => {
    const rpc = await fetch(cfg.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    const j = (await rpc.json()) as { result?: string };
    expect(parseInt(j.result ?? "0", 16)).toBe(cfg.chainId);
    const [{ createClient }, { studionet }] = await Promise.all([import("genlayer-js"), import("genlayer-js/chains")]);
    const client = createClient({ chain: studionet, endpoint: cfg.rpcUrl });
    const schema = (await client.getContractSchema(cfg.contractAddress as `0x${string}`)) as unknown as { methods: Record<string, unknown> };
    const names = Object.keys(schema.methods ?? {});
    for (const m of ["submit_prediction", "resolve_market", "claim_points", "get_prediction", "get_market_candidate", "get_market_result", "get_user_points"]) expect(names).toContain(m);
  }, 60000);
  it("public reads work without a wallet and parse with the app's strict parsers", async () => {
    const ad = createGenLayerAdapter(cfg);
    const zero = "0x0000000000000000000000000000000000000001";
    const day = utcDayStart(Date.now()) - DAY_MS;
    expect(await ad.readPoints(zero)).toMatchObject({ status: "ok" });
    expect(await ad.readMarket(day)).toMatchObject({ status: "ok" });
    expect(await ad.readPrediction(zero, day)).toMatchObject({ status: "ok" });
  }, 60000);
});
