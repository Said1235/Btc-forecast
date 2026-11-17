/**
 * Network + contract configuration. Defaults are the GenLayer StudioNet deployment supplied
 * by the project owner; every value can be overridden with VITE_* variables (see .env.example).
 */
export interface GenLayerConfig {
  network: "studionet";
  chainId: number;
  rpcUrl: string;
  contractAddress: string;
  explorerBase: string;
}

export const STUDIO_DEFAULTS: GenLayerConfig = {
  network: "studionet",
  chainId: 61999, // matches genlayer-js 1.1.8 `studionet`
  rpcUrl: "https://studio.genlayer.com/api", // matches genlayer-js 1.1.8 `studionet`
  contractAddress: "0x8AB7b7FB6771cb91d65623964df704c075e7e2b7",
  explorerBase: "https://explorer-studio.genlayer.com",
};

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

type Env = Record<string, string | undefined>;

export function readConfig(env: Env = import.meta.env as Env): GenLayerConfig {
  const pick = (v: string | undefined, d: string) => (v && v.trim() ? v.trim() : d);
  const cfg: GenLayerConfig = {
    network: "studionet",
    chainId: Number(pick(env.VITE_GENLAYER_CHAIN_ID, String(STUDIO_DEFAULTS.chainId))),
    rpcUrl: pick(env.VITE_GENLAYER_RPC_URL, STUDIO_DEFAULTS.rpcUrl),
    contractAddress: pick(env.VITE_CONTRACT_ADDRESS, STUDIO_DEFAULTS.contractAddress),
    explorerBase: pick(env.VITE_EXPLORER_URL, STUDIO_DEFAULTS.explorerBase),
  };
  if (!ADDRESS_RE.test(cfg.contractAddress)) throw new Error(`Invalid contract address: ${cfg.contractAddress}`);
  if (!Number.isInteger(cfg.chainId) || cfg.chainId <= 0) throw new Error(`Invalid chain id: ${cfg.chainId}`);
  return cfg;
}

export const addChainParams = (c: GenLayerConfig) => ({
  chainId: "0x" + c.chainId.toString(16),
  chainName: "GenLayer Studio Network",
  nativeCurrency: { name: "GEN Token", symbol: "GEN", decimals: 18 },
  rpcUrls: [c.rpcUrl],
  blockExplorerUrls: [c.explorerBase],
});

export const contractUrl = (c: GenLayerConfig) => `${c.explorerBase}/address/${c.contractAddress}`;
