import type { ContractAdapter, SubmitOutcome, Verified } from "./adapter";

/**
 * Real GenLayer adapter. Deliberately inert until the project owner supplies the
 * deployed contract address, network and schema. No method names are assumed here.
 *
 * Integration stage TODO (see docs/FRONTEND_HANDOFF.md):
 *  - build a read client:  createClient({ chain, endpoint })              (genlayer-js 1.1.8)
 *  - build a write client: createClient({ chain, provider: window.ethereum, account })
 *  - map the real view/write methods to the functions below
 *  - track writes with waitForTransactionReceipt({ hash }) through tx/tracker.ts
 */
export interface GenLayerConfig {
  network: string;
  chainId: number;
  rpcUrl: string;
  contractAddress: string;
}

export function readConfig(env: Record<string, string | undefined> = import.meta.env as Record<string, string | undefined>): GenLayerConfig | null {
  const network = env.VITE_GENLAYER_NETWORK?.trim();
  const chainId = Number(env.VITE_GENLAYER_CHAIN_ID);
  const rpcUrl = env.VITE_GENLAYER_RPC_URL?.trim();
  const contractAddress = env.VITE_CONTRACT_ADDRESS?.trim();
  if (!network || !Number.isInteger(chainId) || chainId <= 0 || !rpcUrl || !contractAddress) return null;
  return { network, chainId, rpcUrl, contractAddress };
}

const notConfigured = async (): Promise<Verified<never>> => ({ status: "not-configured" });

export function createGenLayerAdapter(config: GenLayerConfig | null): ContractAdapter {
  const configured = config !== null;
  const pending = async (): Promise<Verified<never>> =>
    configured
      ? { status: "unavailable", reason: "Contract schema has not been mapped yet (integration stage)." }
      : notConfigured();
  return {
    mode: "live",
    configured,
    readMarket: pending,
    readUserPrediction: pending,
    readUserPoints: pending,
    readHistory: pending,
    async submitPrediction(): Promise<SubmitOutcome> {
      throw new Error("Contract writes are disabled until the contract schema is mapped.");
    },
  };
}
